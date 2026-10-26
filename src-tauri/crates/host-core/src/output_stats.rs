//! 输出统计：记录分发器实际发出了多少包、丢弃了多少、遇到什么错误。
//!
//! 实时转发与录制回放共用 [`crate::Dispatcher`] 作为出口，所以统计埋点放在分发器内，
//! 两条链路天然同口径。
//!
//! 本模块分两层：
//!
//! - [`OutputStats`]：热路径上的累计计数器（原子量加少量互斥锁），只记录事实；
//! - [`OutputTracker`]：低频（约 2Hz）的窗口差分与状态推导，产出面向前端的 [`OutputPayload`]。
//!   它只依赖逻辑时间（毫秒），便于确定性测试。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

use crate::sender::SenderState;
use crate::util::lock;

/// 直发目标（非转发表目的地）的限速键前缀；这类目标只计入全局统计。
pub const DIRECT_PREFIX: &str = "direct:";

/// 速率统计与状态推导使用的窗口（毫秒）。
const WINDOW_MS: u64 = 1000;
/// 发生发送错误后，"错误"状态保持的时长（毫秒）。
const ERROR_HOLD_MS: u64 = 5000;
/// 发生明显丢弃后，"丢弃"状态保持的时长（毫秒）。
const DROP_HOLD_MS: u64 = 5000;
/// 最近一次有包发出后，"发送中"状态保持的时长（毫秒）。
const SEND_HOLD_MS: u64 = 3000;
/// 窗口内丢弃占比达到该百分比才判定为"丢弃"。
///
/// 44Hz 限速的最小间隔取整为 22ms，带抖动的 44Hz 信号偶尔会被丢掉一两帧，
/// 这属于正常现象，不应让状态条报警。
const DROP_RATIO_PERCENT: u64 = 10;

/// 单个目的地的累计计数。
#[derive(Debug, Default, Clone)]
struct DestCounters {
    sent: u64,
    errors: u64,
    dropped: u64,
    last_send: Option<Instant>,
}

/// 最近一次发送错误。
#[derive(Debug, Clone)]
struct LastError {
    message: String,
    at: Instant,
}

/// 输出累计计数器（线程安全，可经 `Arc` 在分发器及其克隆间共享）。
#[derive(Debug, Default)]
pub struct OutputStats {
    sent: AtomicU64,
    errors: AtomicU64,
    dropped: AtomicU64,
    last_error: Mutex<Option<LastError>>,
    dests: Mutex<HashMap<String, DestCounters>>,
}

impl OutputStats {
    /// 创建全零的计数器。
    ///
    /// # Returns
    ///
    /// 可共享的 [`OutputStats`]。
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 记录一次成功发出的包。
    ///
    /// # Arguments
    ///
    /// * `dest_id` - 目的地 id；以 [`DIRECT_PREFIX`] 开头的直发目标只计入全局统计。
    pub fn record_sent(&self, dest_id: &str) {
        self.sent.fetch_add(1, Ordering::Relaxed);
        self.with_dest(dest_id, |c| {
            c.sent += 1;
            c.last_send = Some(Instant::now());
        });
    }

    /// 记录一次发送错误，并保存最近一次错误的描述。
    ///
    /// # Arguments
    ///
    /// * `dest_id` - 目的地 id；以 [`DIRECT_PREFIX`] 开头的直发目标只计入全局统计。
    /// * `message` - 错误描述（底层错误的 `Display` 文本）。
    pub fn record_error(&self, dest_id: &str, message: &str) {
        self.errors.fetch_add(1, Ordering::Relaxed);
        *lock(&self.last_error) = Some(LastError {
            message: message.to_string(),
            at: Instant::now(),
        });
        self.with_dest(dest_id, |c| c.errors += 1);
    }

    /// 记录一次被 44Hz 限速器丢弃的帧。
    ///
    /// # Arguments
    ///
    /// * `dest_id` - 目的地 id；以 [`DIRECT_PREFIX`] 开头的直发目标只计入全局统计。
    pub fn record_dropped(&self, dest_id: &str) {
        self.dropped.fetch_add(1, Ordering::Relaxed);
        self.with_dest(dest_id, |c| c.dropped += 1);
    }

    /// 只保留满足条件的目的地计数，其余清除（转发表变更后调用）。
    ///
    /// 全局累计值不受影响。
    ///
    /// # Arguments
    ///
    /// * `keep` - 返回 `true` 表示保留该目的地 id 的计数。
    pub fn retain(&self, keep: impl Fn(&str) -> bool) {
        lock(&self.dests).retain(|id, _| keep(id));
    }

    /// 读取当前累计值的快照。
    ///
    /// # Returns
    ///
    /// 全局与各目的地的累计值；目的地按 id 升序。
    #[must_use]
    pub fn snapshot(&self) -> OutputSnapshot {
        let now = Instant::now();
        let ago = |t: Instant| now.saturating_duration_since(t).as_millis() as u64;
        let last_error = lock(&self.last_error).clone();
        let mut destinations: Vec<DestSnapshot> = lock(&self.dests)
            .iter()
            .map(|(id, c)| DestSnapshot {
                id: id.clone(),
                sent: c.sent,
                errors: c.errors,
                dropped: c.dropped,
                last_send_ago_ms: c.last_send.map(ago),
            })
            .collect();
        destinations.sort_by(|a, b| a.id.cmp(&b.id));
        OutputSnapshot {
            sent: self.sent.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            last_error: last_error.as_ref().map(|e| e.message.clone()),
            last_error_ago_ms: last_error.map(|e| ago(e.at)),
            destinations,
        }
    }

    fn with_dest(&self, dest_id: &str, f: impl FnOnce(&mut DestCounters)) {
        if dest_id.starts_with(DIRECT_PREFIX) {
            return;
        }
        let mut map = lock(&self.dests);
        // 先查后插：热路径上目的地已存在时不分配新的 `String`
        if let Some(c) = map.get_mut(dest_id) {
            f(c);
        } else {
            f(map.entry(dest_id.to_string()).or_default());
        }
    }
}

/// 某一时刻的累计值快照。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OutputSnapshot {
    /// 累计发出的包数。
    pub sent: u64,
    /// 累计发送错误数。
    pub errors: u64,
    /// 累计被限速丢弃的帧数。
    pub dropped: u64,
    /// 最近一次错误的描述。
    pub last_error: Option<String>,
    /// 最近一次错误距快照时刻的毫秒数。
    pub last_error_ago_ms: Option<u64>,
    /// 各目的地的累计值（按 id 升序）。
    pub destinations: Vec<DestSnapshot>,
}

/// 单个目的地的累计值快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestSnapshot {
    /// 目的地 id。
    pub id: String,
    /// 累计发出的包数。
    pub sent: u64,
    /// 累计发送错误数。
    pub errors: u64,
    /// 累计被限速丢弃的帧数。
    pub dropped: u64,
    /// 最近一次发出距快照时刻的毫秒数；从未发出为 `None`。
    pub last_send_ago_ms: Option<u64>,
}

/// 输出总体状态（面向前端）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputState {
    /// 空闲：近期没有包发出。
    Idle,
    /// 发送中：近期持续有包发出。
    Sending,
    /// 丢弃：近期有明显比例的帧被限速器丢弃。
    Dropping,
    /// 错误：发送套接字异常，或近期出现发送错误。
    Error,
}

/// `engine:output` 事件载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPayload {
    /// 总体状态。
    pub state: OutputState,
    /// 累计发出的包数（会话累计）。
    pub sent: u64,
    /// 累计发送错误数。
    pub send_errors: u64,
    /// 累计被限速丢弃的帧数。
    pub dropped: u64,
    /// 全部目的地合计的每秒发出包数（约 1 秒窗口）。
    pub sent_rate: u32,
    /// 最近一次错误的描述。
    pub last_error: Option<String>,
    /// 最近一次错误距今的毫秒数。
    pub last_error_ago_ms: Option<u64>,
    /// 发送套接字状态。
    pub sender: SenderState,
    /// 各目的地的统计。
    pub destinations: Vec<DestinationOutput>,
}

/// 单个目的地的输出统计（面向前端）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationOutput {
    /// 目的地 id。
    pub id: String,
    /// 累计发出的包数。
    pub sent: u64,
    /// 累计发送错误数。
    pub errors: u64,
    /// 累计被限速丢弃的帧数。
    pub dropped: u64,
    /// 每秒发出包数（约 1 秒窗口）。
    pub sent_rate: u32,
    /// 最近一次发出距今的毫秒数；从未发出为 `None`。
    pub last_send_ago_ms: Option<u64>,
}

/// 窗口差分与状态推导。
#[derive(Debug, Default)]
pub struct OutputTracker {
    /// 上个窗口结束的逻辑时间；`None` 表示尚未建立基线。
    last_at_ms: Option<u64>,
    prev_sent: u64,
    prev_errors: u64,
    prev_dropped: u64,
    prev_dest_sent: HashMap<String, u64>,
    sent_rate: u32,
    dest_rates: HashMap<String, u32>,
    /// 最近一次观察到发送错误增长的逻辑时间。
    error_at: Option<u64>,
    /// 最近一次观察到明显丢弃的逻辑时间。
    drop_at: Option<u64>,
    /// 最近一次观察到有包发出的逻辑时间。
    sent_at: Option<u64>,
}

impl OutputTracker {
    /// 创建尚未建立基线的追踪器。
    ///
    /// # Returns
    ///
    /// 空的 [`OutputTracker`]。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 用最新快照推进窗口并生成事件载荷。
    ///
    /// 第一次调用只建立基线。此后每满一个窗口（1 秒）重新计算速率并刷新状态依据；
    /// 窗口内多次调用沿用上次的速率，只更新累计值与"距今"类字段。
    ///
    /// # Arguments
    ///
    /// * `snap` - 当前累计值快照。
    /// * `sender` - 发送套接字当前状态；非就绪时总体状态直接为错误。
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    ///
    /// # Returns
    ///
    /// 面向前端的 [`OutputPayload`]。
    pub fn update(
        &mut self,
        snap: &OutputSnapshot,
        sender: SenderState,
        now_ms: u64,
    ) -> OutputPayload {
        match self.last_at_ms {
            None => self.rebase(snap, now_ms),
            Some(last) if now_ms.saturating_sub(last) >= WINDOW_MS => {
                self.close_window(snap, now_ms, now_ms - last);
            }
            Some(_) => {}
        }

        let state = if sender != SenderState::Ready || within(self.error_at, now_ms, ERROR_HOLD_MS)
        {
            OutputState::Error
        } else if within(self.drop_at, now_ms, DROP_HOLD_MS) {
            OutputState::Dropping
        } else if within(self.sent_at, now_ms, SEND_HOLD_MS) {
            OutputState::Sending
        } else {
            OutputState::Idle
        };

        OutputPayload {
            state,
            sent: snap.sent,
            send_errors: snap.errors,
            dropped: snap.dropped,
            sent_rate: self.sent_rate,
            last_error: snap.last_error.clone(),
            last_error_ago_ms: snap.last_error_ago_ms,
            sender,
            destinations: snap
                .destinations
                .iter()
                .map(|d| DestinationOutput {
                    id: d.id.clone(),
                    sent: d.sent,
                    errors: d.errors,
                    dropped: d.dropped,
                    sent_rate: self.dest_rates.get(&d.id).copied().unwrap_or(0),
                    last_send_ago_ms: d.last_send_ago_ms,
                })
                .collect(),
        }
    }

    fn rebase(&mut self, snap: &OutputSnapshot, now_ms: u64) {
        self.prev_sent = snap.sent;
        self.prev_errors = snap.errors;
        self.prev_dropped = snap.dropped;
        self.prev_dest_sent = snap.destinations.iter().map(|d| (d.id.clone(), d.sent)).collect();
        self.last_at_ms = Some(now_ms);
    }

    fn close_window(&mut self, snap: &OutputSnapshot, now_ms: u64, elapsed_ms: u64) {
        let ds = snap.sent.saturating_sub(self.prev_sent);
        let de = snap.errors.saturating_sub(self.prev_errors);
        let dd = snap.dropped.saturating_sub(self.prev_dropped);
        self.sent_rate = per_second(ds, elapsed_ms);
        self.dest_rates = snap
            .destinations
            .iter()
            .map(|d| {
                let before = self.prev_dest_sent.get(&d.id).copied().unwrap_or(0);
                (d.id.clone(), per_second(d.sent.saturating_sub(before), elapsed_ms))
            })
            .collect();
        if ds > 0 {
            self.sent_at = Some(now_ms);
        }
        if de > 0 {
            self.error_at = Some(now_ms);
        }
        if dd > 0 && dd * 100 >= (ds + dd) * DROP_RATIO_PERCENT {
            self.drop_at = Some(now_ms);
        }
        self.rebase(snap, now_ms);
    }
}

/// `at` 是否在 `hold` 毫秒内。
fn within(at: Option<u64>, now_ms: u64, hold: u64) -> bool {
    at.is_some_and(|t| now_ms.saturating_sub(t) < hold)
}

/// 把窗口内的增量换算成每秒速率。
fn per_second(delta: u64, elapsed_ms: u64) -> u32 {
    let rate = (delta as f64 * 1000.0 / elapsed_ms.max(1) as f64).round();
    rate.min(f64::from(u32::MAX)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(sent: u64, errors: u64, dropped: u64) -> OutputSnapshot {
        OutputSnapshot { sent, errors, dropped, ..OutputSnapshot::default() }
    }

    fn dest(id: &str, sent: u64) -> DestSnapshot {
        DestSnapshot { id: id.into(), sent, errors: 0, dropped: 0, last_send_ago_ms: Some(5) }
    }

    #[test]
    fn counters_accumulate_globally_and_per_destination() {
        let s = OutputStats::new();
        s.record_sent("a");
        s.record_sent("a");
        s.record_sent("b");
        s.record_dropped("a");
        s.record_error("c", "boom");
        let snap = s.snapshot();
        assert_eq!((snap.sent, snap.errors, snap.dropped), (3, 1, 1));
        assert_eq!(snap.last_error.as_deref(), Some("boom"));
        assert!(snap.last_error_ago_ms.is_some());
        assert_eq!(snap.destinations.len(), 3);
        assert_eq!(snap.destinations[0].id, "a");
        assert_eq!(snap.destinations[0].sent, 2);
        assert_eq!(snap.destinations[0].dropped, 1);
        assert!(snap.destinations[0].last_send_ago_ms.is_some());
        assert_eq!(snap.destinations[1].id, "b");
        assert_eq!(snap.destinations[1].sent, 1);
        assert_eq!(snap.destinations[2].id, "c");
        assert_eq!(snap.destinations[2].errors, 1);
        assert!(snap.destinations[2].last_send_ago_ms.is_none(), "c 从未成功发出");
    }

    #[test]
    fn direct_targets_only_count_globally() {
        let s = OutputStats::new();
        s.record_sent("direct:10.0.0.1:6454");
        s.record_dropped("direct:10.0.0.1:6454");
        let snap = s.snapshot();
        assert_eq!((snap.sent, snap.dropped), (1, 1));
        assert!(snap.destinations.is_empty());
    }

    #[test]
    fn retain_prunes_destinations_but_keeps_global_totals() {
        let s = OutputStats::new();
        s.record_sent("keep");
        s.record_sent("gone");
        s.retain(|id| id == "keep");
        let snap = s.snapshot();
        assert_eq!(snap.sent, 2);
        assert_eq!(snap.destinations.len(), 1);
        assert_eq!(snap.destinations[0].id, "keep");
    }

    #[test]
    fn counters_are_exact_under_concurrency() {
        let s = OutputStats::new();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let s = s.clone();
                std::thread::spawn(move || {
                    for _ in 0..1000 {
                        s.record_sent("a");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let snap = s.snapshot();
        assert_eq!(snap.sent, 8000);
        assert_eq!(snap.destinations[0].sent, 8000);
    }

    #[test]
    fn first_update_is_idle_baseline() {
        let mut t = OutputTracker::new();
        let p = t.update(&snap(100, 0, 0), SenderState::Ready, 0);
        assert_eq!(p.state, OutputState::Idle);
        assert_eq!(p.sent_rate, 0);
        assert_eq!(p.sent, 100);
    }

    #[test]
    fn sending_when_packets_flow_then_idle_after_hold() {
        let mut t = OutputTracker::new();
        t.update(&snap(0, 0, 0), SenderState::Ready, 0);
        let p = t.update(&snap(44, 0, 0), SenderState::Ready, 1000);
        assert_eq!(p.state, OutputState::Sending);
        assert_eq!(p.sent_rate, 44);
        // 之后不再有包：保持窗口内仍显示发送中
        let p = t.update(&snap(44, 0, 0), SenderState::Ready, 2000);
        assert_eq!(p.state, OutputState::Sending);
        assert_eq!(p.sent_rate, 0);
        // 超过保持时长后回到空闲
        let p = t.update(&snap(44, 0, 0), SenderState::Ready, 4000);
        assert_eq!(p.state, OutputState::Idle);
    }

    #[test]
    fn rate_is_held_inside_a_window() {
        let mut t = OutputTracker::new();
        t.update(&snap(0, 0, 0), SenderState::Ready, 0);
        t.update(&snap(44, 0, 0), SenderState::Ready, 1000);
        let p = t.update(&snap(66, 0, 0), SenderState::Ready, 1500);
        assert_eq!(p.sent_rate, 44, "窗口未满沿用旧速率");
        assert_eq!(p.sent, 66, "累计值始终是最新的");
    }

    #[test]
    fn send_errors_raise_error_state_and_then_clear() {
        let mut t = OutputTracker::new();
        t.update(&snap(0, 0, 0), SenderState::Ready, 0);
        let p = t.update(&snap(10, 3, 0), SenderState::Ready, 1000);
        assert_eq!(p.state, OutputState::Error);
        assert_eq!(p.send_errors, 3);
        let p = t.update(&snap(54, 3, 0), SenderState::Ready, 5900);
        assert_eq!(p.state, OutputState::Error, "保持时长内仍为错误");
        let p = t.update(&snap(98, 3, 0), SenderState::Ready, 6000);
        assert_eq!(p.state, OutputState::Sending, "错误停止并过了保持时长");
    }

    #[test]
    fn unhealthy_sender_forces_error_state() {
        let mut t = OutputTracker::new();
        t.update(&snap(0, 0, 0), SenderState::Ready, 0);
        for st in [SenderState::Reconnecting, SenderState::Down] {
            let p = t.update(&snap(0, 0, 0), st, 100);
            assert_eq!(p.state, OutputState::Error);
            assert_eq!(p.sender, st);
        }
    }

    #[test]
    fn minor_drops_do_not_alarm_but_heavy_drops_do() {
        let mut t = OutputTracker::new();
        t.update(&snap(0, 0, 0), SenderState::Ready, 0);
        // 44 发出 + 2 丢弃（约 4%）：仍是发送中
        let p = t.update(&snap(44, 0, 2), SenderState::Ready, 1000);
        assert_eq!(p.state, OutputState::Sending);
        // 再来 40 发出 + 20 丢弃（33%）：丢弃
        let p = t.update(&snap(84, 0, 22), SenderState::Ready, 2000);
        assert_eq!(p.state, OutputState::Dropping);
    }

    #[test]
    fn error_state_wins_over_dropping() {
        let mut t = OutputTracker::new();
        t.update(&snap(0, 0, 0), SenderState::Ready, 0);
        let p = t.update(&snap(10, 1, 50), SenderState::Ready, 1000);
        assert_eq!(p.state, OutputState::Error);
    }

    #[test]
    fn per_destination_rates_and_new_destinations() {
        let mut t = OutputTracker::new();
        let mut s0 = snap(0, 0, 0);
        s0.destinations = vec![dest("a", 0)];
        t.update(&s0, SenderState::Ready, 0);

        let mut s1 = snap(74, 0, 0);
        s1.destinations = vec![dest("a", 44), dest("b", 30)];
        let p = t.update(&s1, SenderState::Ready, 1000);
        assert_eq!(p.destinations.len(), 2);
        assert_eq!(p.destinations[0].sent_rate, 44);
        assert_eq!(p.destinations[1].sent_rate, 30, "新目的地的基线为 0");
        assert_eq!(p.sent_rate, 74);
    }

    #[test]
    fn counter_reset_does_not_underflow() {
        let mut t = OutputTracker::new();
        t.update(&snap(500, 0, 0), SenderState::Ready, 0);
        let p = t.update(&snap(10, 0, 0), SenderState::Ready, 1000);
        assert_eq!(p.sent_rate, 0);
    }

    #[test]
    fn payload_serializes_camel_case() {
        let mut t = OutputTracker::new();
        let p = t.update(&snap(1, 0, 0), SenderState::Ready, 0);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["state"], "idle");
        assert_eq!(v["sendErrors"], 0);
        assert_eq!(v["sentRate"], 0);
        assert_eq!(v["sender"], "ready");
        assert!(v["destinations"].is_array());
    }
}
