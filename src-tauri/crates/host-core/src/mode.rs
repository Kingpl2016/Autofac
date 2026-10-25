//! 运行时模式仲裁与帧分发原语。
//!
//! - [`RuntimeMode`]：录制与回放互斥仲裁（手册语义：二者不可同时进行），由接收循环、
//!   录制与回放三方共享，取代此前分散的 `playback_mode` 原子与 `recording_active` 传参。
//! - [`FrameFanout`] / [`FrameSink`]：接收热路径的帧旁路扇出，取代接收循环对录制控制器的
//!   硬编码调用，使录制等消费者可独立注册，便于后续拆分到各自的插件 crate。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use artnet_net::DmxFrame;

use crate::util::lock;

/// 录制与回放的互斥仲裁：二者不能同时进行。
///
/// 接收循环据 [`RuntimeMode::is_playback`] 与 [`RuntimeMode::is_player`] 决定是否丢弃实时帧；
/// 录制与回放各自在进入/退出时置位对应标志，并在进入前检查对方是否已激活。
///
/// 三个标志含义不同：
/// - `playback`：已打开节目（输出由回放任务产生）；
/// - `player`：处于**播放器模式**（实时接收已被整体停止，接收任务已拆除）；
/// - `recording`：正在录制。
#[derive(Debug, Default)]
pub struct RuntimeMode {
    playback: AtomicBool,
    recording: AtomicBool,
    player: AtomicBool,
}

impl RuntimeMode {
    /// 创建空闲仲裁（录制、回放均未激活）。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 是否处于回放模式（接收循环据此暂停实时摄取）。
    #[must_use]
    pub fn is_playback(&self) -> bool {
        self.playback.load(Ordering::Acquire)
    }

    /// 是否正在录制。
    #[must_use]
    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::Acquire)
    }

    /// 是否处于播放器模式。
    ///
    /// 播放器模式下接收任务已被拆除；接收循环仍据此丢弃通道里残留的迟到帧，
    /// 避免它们在清空之后又被摄取、录制或转发。
    #[must_use]
    pub fn is_player(&self) -> bool {
        self.player.load(Ordering::Acquire)
    }

    /// 置位播放器模式标志（进入/退出播放器模式时调用）。
    ///
    /// # Arguments
    ///
    /// * `on` - `true` 表示进入播放器模式。
    pub fn set_player(&self, on: bool) {
        self.player.store(on, Ordering::Release);
    }

    /// 置位回放标志（进入/退出回放时调用）。
    pub fn set_playback(&self, on: bool) {
        self.playback.store(on, Ordering::Release);
    }

    /// 置位录制标志（开始/结束录制时调用）。
    pub fn set_recording(&self, on: bool) {
        self.recording.store(on, Ordering::Release);
    }
}

/// 帧接收器：录制等旁路消费者实现它，由 [`FrameFanout`] 在接收热路径上回调。
pub trait FrameSink: Send + Sync {
    /// 处理一帧。实现必须**非阻塞**：满载时自行丢弃并计数，绝不拖慢接收循环。
    fn offer(&self, frame: &DmxFrame);
}

/// 帧分发扇出：接收循环把每帧投递给所有已注册的 [`FrameSink`]。
///
/// 以弱引用持有各接收器，消费者销毁后自动失效。每个 sink 自行按需门控
/// （例如录制未开始时直接返回），因此扇出本身不关心业务状态。
#[derive(Clone, Default)]
pub struct FrameFanout {
    sinks: Arc<Mutex<Vec<Weak<dyn FrameSink>>>>,
    active: Arc<AtomicBool>,
}

impl FrameFanout {
    /// 创建空扇出（无接收器）。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个帧接收器（弱引用）。
    ///
    /// # Arguments
    ///
    /// * `sink` - 接收器的弱引用；其强引用被消费者持有，销毁后此处自动失效。
    pub fn register(&self, sink: Weak<dyn FrameSink>) {
        lock(&self.sinks).push(sink);
        self.active.store(true, Ordering::Release);
    }

    /// 把一帧投递给所有存活的接收器。无接收器时仅一次原子读、零分配。
    ///
    /// # Arguments
    ///
    /// * `frame` - 接收循环收到的 DMX 帧。
    pub fn offer(&self, frame: &DmxFrame) {
        if !self.active.load(Ordering::Acquire) {
            return;
        }
        for sink in lock(&self.sinks).iter() {
            if let Some(s) = sink.upgrade() {
                s.offer(frame);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimeMode;

    #[test]
    fn recording_and_playback_are_mutually_exclusive_checks() {
        let m = RuntimeMode::new();
        assert!(!m.is_recording() && !m.is_playback());

        // 录制进行时，回放侧据 is_recording 拒绝进入
        m.set_recording(true);
        assert!(m.is_recording());
        // 回放进行时，录制侧据 is_playback 拒绝进入
        m.set_recording(false);
        m.set_playback(true);
        assert!(m.is_playback() && !m.is_recording());
        m.set_playback(false);
        assert!(!m.is_playback());
    }
}
