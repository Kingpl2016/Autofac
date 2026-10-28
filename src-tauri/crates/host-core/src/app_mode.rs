//! 应用运行模式：实时（Live）与播放器（Player）。
//!
//! 播放器模式把本机变成一台专用的节目播放机：实时接收（Art-Net / sACN）被整体停止、
//! 端口释放、实时状态清空，只保留发送能力。切换顺序是安全性的关键，因此集中在
//! [`ModeManager`] 里，并通过 [`ModeDeps`] 注入具体动作，使顺序可以用假实现做确定性测试。
//!
//! 进入播放器模式：
//! 1. 拒绝（录制进行中）→ 置位模式标志（接收循环立刻开始丢帧）→ 拆除接收任务 →
//!    清空实时状态 → 确保发送器就绪。
//!
//! 退出播放器模式：
//! 1. 关闭节目 → 重建接收任务 → 清除模式标志。
//!
//! 切换由互斥保护：切换进行中再次触发会立刻返回 [`ERR_TRANSITION_IN_PROGRESS`]，而不是排队。

use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::playback::ERR_RECORDING_ACTIVE;
use crate::sender::SenderState;
use crate::util::lock;

/// 错误码：已有模式切换正在进行。
pub const ERR_TRANSITION_IN_PROGRESS: &str = "transition_in_progress";

/// 应用运行模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppMode {
    /// 实时模式：接收、合并、转发、录制全部可用。
    #[default]
    Live,
    /// 播放器模式：实时接收已停止，只播放节目。
    Player,
}

/// 接收任务的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReceiversState {
    /// 接收套接字已绑定（或按配置本就关闭，无需绑定）。
    #[default]
    Bound,
    /// 重建接收套接字失败（例如端口被独占）；可再次请求切换到实时模式重试。
    Failed,
    /// 已被播放器模式主动停止。
    Suspended,
}

/// 模式状态快照（`app:mode` 事件载荷与 `app_mode_get` 返回值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeStatus {
    /// 当前模式。
    pub mode: AppMode,
    /// 接收任务状态。
    pub receivers: ReceiversState,
    /// 发送器状态。
    pub sender: SenderState,
}

/// 模式切换所需的具体动作。
///
/// 全部是同步方法：真实实现（[`crate::Runtime`]）要求在 Tokio 上下文中调用，
/// 因为重建接收套接字需要 reactor；测试用的假实现则无此限制。
pub trait ModeDeps {
    /// 是否正在录制。
    fn is_recording(&self) -> bool;
    /// 置位 / 清除运行时的播放器模式标志。
    ///
    /// # Arguments
    ///
    /// * `on` - `true` 表示进入播放器模式。
    fn set_player_flag(&self, on: bool);
    /// 拆除全部接收任务（Art-Net 与 sACN），释放端口。
    fn suspend_receivers(&self);
    /// 重建全部接收任务。
    ///
    /// # Returns
    ///
    /// Art-Net 接收成功绑定（或按配置本就关闭）时为 `true`，绑定失败时为 `false`。
    fn resume_receivers(&self) -> bool;
    /// 清空实时状态（信号引擎、设备表、限速状态）。
    fn clear_live_state(&self);
    /// 确保发送器可用：缺失时请求创建。
    fn ensure_sender(&self);
    /// 关闭已打开的节目（没有则什么也不做）。
    fn close_program(&self);
}

/// 模式管理器：持有当前模式与接收状态，并按固定顺序执行切换。
#[derive(Debug, Default)]
pub struct ModeManager {
    state: Mutex<(AppMode, ReceiversState)>,
    busy: AtomicBool,
}

/// 切换互斥守卫：离开作用域自动释放。
struct BusyGuard<'a>(&'a AtomicBool);

impl<'a> BusyGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self(flag))
            .map_err(|_| ERR_TRANSITION_IN_PROGRESS.to_string())
    }
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl ModeManager {
    /// 创建处于实时模式、接收视为已绑定的管理器。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前模式。
    ///
    /// # Returns
    ///
    /// 最近一次成功切换后的 [`AppMode`]。
    #[must_use]
    pub fn mode(&self) -> AppMode {
        lock(&self.state).0
    }

    /// 当前接收任务状态。
    ///
    /// # Returns
    ///
    /// 最近一次观察到的 [`ReceiversState`]。
    #[must_use]
    pub fn receivers(&self) -> ReceiversState {
        lock(&self.state).1
    }

    /// 直接记录接收状态（启动时 Art-Net 绑定失败等不经过切换的场合）。
    ///
    /// # Arguments
    ///
    /// * `state` - 新的接收状态。
    pub fn set_receivers(&self, state: ReceiversState) {
        lock(&self.state).1 = state;
    }

    /// 切换到目标模式。
    ///
    /// 目标等于当前模式时是幂等的：实时模式下若接收曾绑定失败，会再次尝试重建（供"重试"使用）；
    /// 其余情况什么也不做。
    ///
    /// # Arguments
    ///
    /// * `target` - 目标模式。
    /// * `deps` - 切换所需的具体动作。
    ///
    /// # Returns
    ///
    /// 切换完成后的 `(模式, 接收状态)`。
    ///
    /// # Errors
    ///
    /// - [`ERR_TRANSITION_IN_PROGRESS`]：已有切换正在进行。
    /// - [`ERR_RECORDING_ACTIVE`]：录制进行中，不能进入播放器模式（调用方应先停止录制）。
    pub fn set(
        &self,
        target: AppMode,
        deps: &dyn ModeDeps,
    ) -> Result<(AppMode, ReceiversState), String> {
        let _guard = BusyGuard::acquire(&self.busy)?;
        let (current, receivers) = *lock(&self.state);
        match (current, target) {
            (AppMode::Live, AppMode::Player) => {
                if deps.is_recording() {
                    return Err(ERR_RECORDING_ACTIVE.to_string());
                }
                // 先置位：接收循环从此刻起丢弃一切实时帧，包括通道里已排队的
                deps.set_player_flag(true);
                deps.suspend_receivers();
                deps.clear_live_state();
                deps.ensure_sender();
                *lock(&self.state) = (AppMode::Player, ReceiversState::Suspended);
            }
            (AppMode::Player, AppMode::Live) => {
                deps.close_program();
                let bound = deps.resume_receivers();
                // 接收重建完成后才放开标志，避免旧状态与新帧混在一起
                deps.set_player_flag(false);
                *lock(&self.state) = (AppMode::Live, Self::state_of(bound));
            }
            (AppMode::Live, AppMode::Live) => {
                if receivers == ReceiversState::Failed {
                    let bound = deps.resume_receivers();
                    *lock(&self.state) = (AppMode::Live, Self::state_of(bound));
                }
            }
            (AppMode::Player, AppMode::Player) => {}
        }
        Ok(*lock(&self.state))
    }

    fn state_of(bound: bool) -> ReceiversState {
        if bound {
            ReceiversState::Bound
        } else {
            ReceiversState::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use super::{
        AppMode, ModeDeps, ModeManager, ReceiversState, ERR_RECORDING_ACTIVE,
        ERR_TRANSITION_IN_PROGRESS,
    };

    /// 在 `suspend_receivers` 内部执行的重入动作。
    type Reenter = Box<dyn Fn() -> Result<(), String> + Send + Sync>;

    /// 记录调用顺序的假依赖。
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<String>>,
        recording: AtomicBool,
        bind_ok: AtomicBool,
        /// 在 `suspend_receivers` 内部尝试再次切换，用于验证互斥。
        reenter: Mutex<Option<Reenter>>,
    }

    impl Fake {
        fn new() -> Self {
            let f = Self::default();
            f.bind_ok.store(true, Ordering::SeqCst);
            f
        }
        fn log(&self, s: &str) {
            self.calls.lock().unwrap().push(s.to_string());
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl ModeDeps for Fake {
        fn is_recording(&self) -> bool {
            self.recording.load(Ordering::SeqCst)
        }
        fn set_player_flag(&self, on: bool) {
            self.log(&format!("flag={on}"));
        }
        fn suspend_receivers(&self) {
            self.log("suspend");
            if let Some(f) = self.reenter.lock().unwrap().as_ref() {
                let r = f();
                self.log(&format!("reenter={r:?}"));
            }
        }
        fn resume_receivers(&self) -> bool {
            self.log("resume");
            self.bind_ok.load(Ordering::SeqCst)
        }
        fn clear_live_state(&self) {
            self.log("clear");
        }
        fn ensure_sender(&self) {
            self.log("sender");
        }
        fn close_program(&self) {
            self.log("close");
        }
    }

    #[test]
    fn entering_player_runs_steps_in_the_safe_order() {
        let m = ModeManager::new();
        let d = Fake::new();
        let out = m.set(AppMode::Player, &d).unwrap();
        assert_eq!(out, (AppMode::Player, ReceiversState::Suspended));
        assert_eq!(
            d.calls(),
            vec!["flag=true", "suspend", "clear", "sender"],
            "必须先置位丢帧标志，再拆接收，再清空，最后确保发送器"
        );
        assert_eq!(m.mode(), AppMode::Player);
    }

    #[test]
    fn leaving_player_closes_program_then_rebinds_then_releases_flag() {
        let m = ModeManager::new();
        let d = Fake::new();
        m.set(AppMode::Player, &d).unwrap();
        d.calls.lock().unwrap().clear();

        let out = m.set(AppMode::Live, &d).unwrap();
        assert_eq!(out, (AppMode::Live, ReceiversState::Bound));
        assert_eq!(d.calls(), vec!["close", "resume", "flag=false"]);
    }

    #[test]
    fn recording_blocks_entering_player_and_changes_nothing() {
        let m = ModeManager::new();
        let d = Fake::new();
        d.recording.store(true, Ordering::SeqCst);
        assert_eq!(m.set(AppMode::Player, &d).unwrap_err(), ERR_RECORDING_ACTIVE);
        assert!(d.calls().is_empty(), "被拒绝时不应触碰任何东西: {:?}", d.calls());
        assert_eq!(m.mode(), AppMode::Live);
        // 停止录制后可以进入
        d.recording.store(false, Ordering::SeqCst);
        assert!(m.set(AppMode::Player, &d).is_ok());
    }

    #[test]
    fn rebind_failure_still_leaves_player_mode_but_reports_failed_receivers() {
        let m = ModeManager::new();
        let d = Fake::new();
        m.set(AppMode::Player, &d).unwrap();
        d.bind_ok.store(false, Ordering::SeqCst);

        let out = m.set(AppMode::Live, &d).unwrap();
        assert_eq!(out, (AppMode::Live, ReceiversState::Failed));
        assert_eq!(m.receivers(), ReceiversState::Failed);
        assert_eq!(d.calls().last().map(String::as_str), Some("flag=false"));
    }

    #[test]
    fn live_to_live_is_a_noop_unless_receivers_failed_then_it_retries() {
        let m = ModeManager::new();
        let d = Fake::new();
        m.set(AppMode::Live, &d).unwrap();
        assert!(d.calls().is_empty(), "接收正常时幂等切换不应做任何事");

        m.set_receivers(ReceiversState::Failed);
        let out = m.set(AppMode::Live, &d).unwrap();
        assert_eq!(out, (AppMode::Live, ReceiversState::Bound));
        assert_eq!(d.calls(), vec!["resume"]);

        // 重试仍然失败时保持 Failed，可继续重试
        m.set_receivers(ReceiversState::Failed);
        d.bind_ok.store(false, Ordering::SeqCst);
        assert_eq!(m.set(AppMode::Live, &d).unwrap().1, ReceiversState::Failed);
    }

    #[test]
    fn player_to_player_is_a_noop() {
        let m = ModeManager::new();
        let d = Fake::new();
        m.set(AppMode::Player, &d).unwrap();
        d.calls.lock().unwrap().clear();
        assert_eq!(m.set(AppMode::Player, &d).unwrap().0, AppMode::Player);
        assert!(d.calls().is_empty());
    }

    #[test]
    fn a_second_transition_while_one_is_running_is_rejected() {
        use std::sync::Arc;
        let m = Arc::new(ModeManager::new());
        let d = Fake::new();
        let m2 = m.clone();
        let inner = Fake::new();
        // 在 suspend 的过程中，另一个切换请求到来
        *d.reenter.lock().unwrap() = Some(Box::new(move || {
            m2.set(AppMode::Live, &inner).map(|_| ())
        }));

        m.set(AppMode::Player, &d).unwrap();
        let calls = d.calls();
        assert!(
            calls.contains(&format!("reenter=Err({ERR_TRANSITION_IN_PROGRESS:?})")),
            "{calls:?}"
        );
        // 互斥释放后可以正常切回
        *d.reenter.lock().unwrap() = None;
        assert!(m.set(AppMode::Live, &d).is_ok());
    }
}
