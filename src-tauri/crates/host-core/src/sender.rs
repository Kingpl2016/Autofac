//! 发送器健康状态与自愈。
//!
//! 无人值守的播放机在网卡掉线、驱动重置后，发送套接字可能一直报错而没有任何提示。
//! 本模块提供：
//!
//! - [`SenderHealth`]：由分发器在每次发送后上报成败；连续失败达到阈值就判定需要重建；
//! - [`recover`]：按 100、200、400、800、1600、3200、5000 毫秒的阶梯反复重建发送套接字，
//!   直到成功（永不放弃）；
//! - [`SenderState`]：向界面暴露的三态（就绪 / 重连中 / 不可用）。
//!
//! 首次创建发送器也走同一条路径：启动时先请求一次恢复，由监督任务完成创建。

use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use arc_swap::ArcSwapOption;
use artnet_net::socket::DmxSender;
use serde::Serialize;
use tokio::sync::Notify;

use crate::util::lock;

/// 发送器槽位：分发器、监督任务与运行时共享。
///
/// 读多写极少（只在创建 / 重建发送套接字时替换），发送路径经 `load` 无锁读取；
/// 为空（`None`）表示发送器尚未就绪，此时发送被静默忽略。
pub type SenderSlot = Arc<ArcSwapOption<DmxSender>>;

/// 连续发送失败多少次后判定发送套接字需要重建。
///
/// 只有"连续"失败才计数：一个不可达的目的地不会拖垮其它正常目的地的发送。
pub const FAIL_STREAK_THRESHOLD: u32 = 5;
/// 重建尝试的退避阶梯（毫秒），用完后一直使用最后一档。
pub const REBIND_DELAYS_MS: [u64; 7] = [100, 200, 400, 800, 1600, 3200, 5000];
/// 重建连续失败多少次后，状态从"重连中"升级为"不可用"。
const DOWN_AFTER_FAILED_ATTEMPTS: u32 = 3;

/// 发送器状态（面向前端）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum SenderState {
    /// 就绪：发送套接字工作正常。
    #[default]
    Ready,
    /// 重连中：正在重建发送套接字。
    Reconnecting,
    /// 不可用：多次重建失败，仍在继续尝试。
    Down,
}

impl SenderState {
    fn to_u8(self) -> u8 {
        match self {
            Self::Ready => 0,
            Self::Reconnecting => 1,
            Self::Down => 2,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Reconnecting,
            2 => Self::Down,
            _ => Self::Ready,
        }
    }
}

/// 状态变化回调。
type Listener = Arc<dyn Fn(SenderState) + Send + Sync>;

/// 发送器健康度：状态、连续失败计数与"需要恢复"的唤醒信号。
pub struct SenderHealth {
    state: AtomicU8,
    streak: AtomicU32,
    wake: Notify,
    listener: Mutex<Option<Listener>>,
}

impl SenderHealth {
    /// 创建初始为 [`SenderState::Ready`] 的健康度。
    ///
    /// # Returns
    ///
    /// 可在分发器与监督任务间共享的 `Arc`。
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: AtomicU8::new(SenderState::Ready.to_u8()),
            streak: AtomicU32::new(0),
            wake: Notify::new(),
            listener: Mutex::new(None),
        })
    }

    /// 当前状态。
    ///
    /// # Returns
    ///
    /// 最近一次设置的 [`SenderState`]。
    #[must_use]
    pub fn state(&self) -> SenderState {
        SenderState::from_u8(self.state.load(Ordering::Acquire))
    }

    /// 注册状态变化回调（覆盖此前的回调）。回调只在状态**真正变化**时触发。
    ///
    /// # Arguments
    ///
    /// * `f` - 回调，参数为新状态；它在上报发送结果的线程里同步执行，须轻量。
    pub fn set_listener(&self, f: impl Fn(SenderState) + Send + Sync + 'static) {
        *lock(&self.listener) = Some(Arc::new(f));
    }

    fn set_state(&self, next: SenderState) {
        let prev = self.state.swap(next.to_u8(), Ordering::AcqRel);
        if prev != next.to_u8() {
            // 先克隆出回调再调用，避免回调里再触碰本对象时持锁
            let cb = lock(&self.listener).clone();
            if let Some(cb) = cb {
                cb(next);
            }
        }
    }

    /// 上报一次发送成功：清零连续失败计数。
    pub fn report_ok(&self) {
        self.streak.store(0, Ordering::Relaxed);
    }

    /// 上报一次发送失败。
    ///
    /// 连续失败达到 [`FAIL_STREAK_THRESHOLD`] 且当前为就绪状态时，转入"重连中"并唤醒监督任务。
    pub fn report_error(&self) {
        let n = self.streak.fetch_add(1, Ordering::Relaxed) + 1;
        if n >= FAIL_STREAK_THRESHOLD && self.state() == SenderState::Ready {
            self.request_recovery();
        }
    }

    /// 请求一次恢复（发送器缺失或疑似损坏）：转入"重连中"并唤醒监督任务。
    ///
    /// 已在恢复中（重连中 / 不可用）时只保持状态，不重复唤醒。
    pub fn request_recovery(&self) {
        if self.state() == SenderState::Ready {
            self.set_state(SenderState::Reconnecting);
            self.wake.notify_one();
        }
    }

    /// 监督任务等待"需要恢复"的信号。
    pub async fn wait_for_trouble(&self) {
        self.wake.notified().await;
    }

    fn mark_ready(&self) {
        self.streak.store(0, Ordering::Relaxed);
        self.set_state(SenderState::Ready);
    }
}

/// 第 `attempt` 次失败后的等待时长（从 0 起，超出阶梯后沿用最后一档）。
///
/// # Arguments
///
/// * `attempt` - 已失败的次数（第一次失败后传 0）。
///
/// # Returns
///
/// 对应阶梯档位的 [`Duration`]。
#[must_use]
pub fn rebind_delay(attempt: u32) -> Duration {
    let idx = (attempt as usize).min(REBIND_DELAYS_MS.len() - 1);
    Duration::from_millis(REBIND_DELAYS_MS[idx])
}

/// 反复重建发送套接字直到成功（永不放弃）。
///
/// 第一次尝试立即进行；失败后按 `delay` 给出的时长等待再试。成功后替换 `slot` 里的发送器
/// 并把状态置回就绪。连续失败达到 3 次时状态升级为 [`SenderState::Down`]。
///
/// # Arguments
///
/// * `health` - 发送器健康度，用于更新状态。
/// * `slot` - 与分发器共享的发送器槽位（见 [`SenderSlot`]）；成功后原子替换其中的发送器，
///   正在使用旧发送器的发送不受影响（旧发送器在最后一个使用者结束后释放）。
/// * `make` - 创建新发送器的函数（生产环境为 `DmxSender::new`，测试可注入失败）。
/// * `delay` - 第 N 次失败后的等待时长，参数从 0 起。
pub async fn recover<F, Fut>(
    health: &SenderHealth,
    slot: &ArcSwapOption<DmxSender>,
    mut make: F,
    delay: impl Fn(u32) -> Duration,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = io::Result<DmxSender>>,
{
    let mut failed: u32 = 0;
    loop {
        match make().await {
            Ok(sender) => {
                slot.store(Some(Arc::new(sender)));
                health.mark_ready();
                tracing::info!(failed, "发送套接字已就绪");
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, attempt = failed + 1, "重建发送套接字失败");
                failed += 1;
                if failed >= DOWN_AFTER_FAILED_ATTEMPTS {
                    health.set_state(SenderState::Down);
                }
                tokio::time::sleep(delay(failed - 1)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use arc_swap::ArcSwapOption;
    use artnet_net::socket::DmxSender;

    use super::{
        rebind_delay, recover, SenderHealth, SenderState, FAIL_STREAK_THRESHOLD, REBIND_DELAYS_MS,
    };

    #[test]
    fn delays_follow_the_ladder_and_then_stay_at_the_last_step() {
        let got: Vec<u64> = (0..9).map(|i| rebind_delay(i).as_millis() as u64).collect();
        assert_eq!(got, vec![100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000]);
        assert_eq!(REBIND_DELAYS_MS.len(), 7);
    }

    #[test]
    fn only_consecutive_failures_trigger_recovery() {
        let h = SenderHealth::new();
        for _ in 0..FAIL_STREAK_THRESHOLD - 1 {
            h.report_error();
        }
        assert_eq!(h.state(), SenderState::Ready, "未达阈值不应判定故障");
        h.report_ok();
        for _ in 0..FAIL_STREAK_THRESHOLD - 1 {
            h.report_error();
        }
        assert_eq!(h.state(), SenderState::Ready, "中间有成功就应重新计数");
        h.report_error();
        assert_eq!(h.state(), SenderState::Reconnecting);
    }

    #[test]
    fn listener_fires_only_on_real_changes() {
        let h = SenderHealth::new();
        let seen: Arc<Mutex<Vec<SenderState>>> = Arc::default();
        let s = seen.clone();
        h.set_listener(move |st| s.lock().unwrap().push(st));
        h.request_recovery();
        h.request_recovery(); // 已在恢复中，不重复
        for _ in 0..FAIL_STREAK_THRESHOLD * 2 {
            h.report_error(); // 非就绪状态下不再触发
        }
        assert_eq!(*seen.lock().unwrap(), vec![SenderState::Reconnecting]);
    }

    #[tokio::test]
    async fn request_recovery_wakes_the_supervisor() {
        let h = SenderHealth::new();
        h.request_recovery();
        // 信号在无人等待时也会被保留，随后的等待立即返回
        tokio::time::timeout(Duration::from_secs(1), h.wait_for_trouble())
            .await
            .expect("应被唤醒");
    }

    #[tokio::test]
    async fn recover_retries_until_success_and_walks_through_down() {
        let h = SenderHealth::new();
        let states: Arc<Mutex<Vec<SenderState>>> = Arc::default();
        let s = states.clone();
        h.set_listener(move |st| s.lock().unwrap().push(st));
        h.request_recovery();

        let slot = ArcSwapOption::<DmxSender>::empty();
        let tries = AtomicU32::new(0);
        recover(
            &h,
            &slot,
            || {
                let n = tries.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n < 4 {
                        Err(io::Error::other("网卡不可用"))
                    } else {
                        DmxSender::new([0u8; 16]).await
                    }
                }
            },
            |_| Duration::ZERO,
        )
        .await;

        assert_eq!(tries.load(Ordering::SeqCst), 5);
        assert!(slot.load().is_some(), "成功后槽位里应有新的发送器");
        assert_eq!(h.state(), SenderState::Ready);
        assert_eq!(
            *states.lock().unwrap(),
            vec![
                SenderState::Reconnecting,
                SenderState::Down,
                SenderState::Ready
            ]
        );
    }

    #[tokio::test]
    async fn first_attempt_is_immediate() {
        let h = SenderHealth::new();
        h.request_recovery();
        let slot = ArcSwapOption::<DmxSender>::empty();
        let started = std::time::Instant::now();
        // 即使退避阶梯很长，首次尝试也不应等待
        recover(
            &h,
            &slot,
            || DmxSender::new([0u8; 16]),
            |_| Duration::from_secs(60),
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(h.state(), SenderState::Ready);
    }
}
