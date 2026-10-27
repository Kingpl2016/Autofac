//! 节目编辑器的灯光输出通道。
//!
//! 编辑器的 30 FPS 计时线程只负责算帧；网络发送交给本模块在 tokio 里完成，
//! 与回放（见 [`crate::playback`]）共用同一个 [`Dispatcher`] 和输出目标（转发表或指定 IP）。
//!
//! [`ShowOutput`] 存活期间置位 [`RuntimeMode`] 的 `show` 标志：
//!
//! - 接收循环丢弃实时帧，避免实时转发与编辑器输出叠加；
//! - 回放节目 / 录制拒绝开始（见 [`crate::playback::ERR_SHOW_ACTIVE`]）；
//! - 同时只允许一个输出会话。
//!
//! 每条消息都是完整的各 Universe 状态，所以队列满时丢弃旧帧是安全的，下一帧会覆盖它。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use tokio::sync::mpsc::{self, error::TrySendError};

use forwarding::ForwardProtocol;

use crate::dispatch::{DispatchTarget, Dispatcher, SequenceTable};
use crate::routes::Endpoint;
use crate::mode::RuntimeMode;
use crate::playback::{ERR_RECORDING_ACTIVE, ERR_SHOW_ACTIVE};

/// 错误码：回放节目已打开，不能开始编辑器输出。
pub const ERR_PLAYBACK_ACTIVE: &str = "playback_active";

/// 输出队列容量（消息数，每条是一次所有 Universe 的完整状态）。
const OUTPUT_QUEUE: usize = 16;

/// 编辑器输出所需的运行时句柄（由 [`crate::Runtime::show_output_handle`] 提供）。
#[derive(Clone)]
pub struct OutputHandle {
    dispatcher: Dispatcher,
    mode: Arc<RuntimeMode>,
    started_at: Instant,
}

impl OutputHandle {
    /// 组装句柄。
    ///
    /// # Arguments
    ///
    /// * `dispatcher` - 输出分发器。
    /// * `mode` - 运行模式仲裁。
    /// * `started_at` - 运行时起点（换算逻辑毫秒，供分发器限速 / 统计使用）。
    #[must_use]
    pub fn new(dispatcher: Dispatcher, mode: Arc<RuntimeMode>, started_at: Instant) -> Self {
        Self {
            dispatcher,
            mode,
            started_at,
        }
    }

    /// 转发表里启用的目的地个数。
    ///
    /// # Returns
    ///
    /// 输出目标为转发表时，该值为 0 意味着不会有任何输出。
    #[must_use]
    pub fn enabled_destinations(&self) -> usize {
        self.dispatcher.enabled_destinations()
    }
}

/// 一条输出消息。
struct Msg {
    target: Arc<DispatchTarget>,
    frames: Vec<(u16, Bytes)>,
}

/// 一次编辑器输出会话。丢弃它即结束会话并复位 `show` 标志。
pub struct ShowOutput {
    tx: mpsc::Sender<Msg>,
    mode: Arc<RuntimeMode>,
    dropped: AtomicU64,
}

impl ShowOutput {
    /// 开始一次输出会话，并启动发送任务。
    ///
    /// # Arguments
    ///
    /// * `handle` - 运行时句柄。
    ///
    /// # Returns
    ///
    /// 会话对象；丢弃它即结束会话。
    ///
    /// # Errors
    ///
    /// - [`ERR_RECORDING_ACTIVE`]：录制进行中。
    /// - [`ERR_PLAYBACK_ACTIVE`]：已打开回放节目。
    /// - [`ERR_SHOW_ACTIVE`]：已有一个编辑器输出会话。
    pub fn begin(handle: &OutputHandle) -> Result<Self, String> {
        let mode = &handle.mode;
        if mode.is_recording() {
            return Err(ERR_RECORDING_ACTIVE.to_string());
        }
        if mode.is_playback() {
            return Err(ERR_PLAYBACK_ACTIVE.to_string());
        }
        if mode.is_show() {
            return Err(ERR_SHOW_ACTIVE.to_string());
        }
        mode.set_show(true);
        let (tx, rx) = mpsc::channel(OUTPUT_QUEUE);
        tauri::async_runtime::spawn(run_output(
            handle.dispatcher.clone(),
            handle.started_at,
            rx,
        ));
        Ok(Self {
            tx,
            mode: mode.clone(),
            dropped: AtomicU64::new(0),
        })
    }

    /// 提交一次完整输出（在计时线程上调用，非阻塞）。
    ///
    /// # Arguments
    ///
    /// * `target` - 输出目标。
    /// * `frames` - 各 Universe 的完整数据；为空时什么也不做。
    pub fn submit<'a>(
        &self,
        target: &Arc<DispatchTarget>,
        frames: impl IntoIterator<Item = (u16, &'a [u8])>,
    ) {
        let frames: Vec<(u16, Bytes)> = frames
            .into_iter()
            .map(|(universe, data)| (universe, Bytes::copy_from_slice(data)))
            .collect();
        if frames.is_empty() {
            return;
        }
        let msg = Msg {
            target: target.clone(),
            frames,
        };
        if let Err(TrySendError::Full(_)) = self.tx.try_send(msg) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// 累计因队列满被丢弃的消息数。
    ///
    /// # Returns
    ///
    /// 自会话开始以来的丢弃计数。
    #[must_use]
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl Drop for ShowOutput {
    fn drop(&mut self) {
        self.mode.set_show(false);
    }
}

/// 发送任务：逐条取出消息，解析路由并发送；发送端丢弃后取空即结束。
///
/// 每个 `(端点, 远端 Universe)` 的序列号独立递增；路由目标开启同步时，每帧末尾发送 ArtSync /
/// sACN 同步包。会话结束时给用过的 sACN 流发送 Stream_Terminated。
async fn run_output(dispatcher: Dispatcher, started_at: Instant, mut rx: mpsc::Receiver<Msg>) {
    let mut jobs = Vec::new();
    let mut seqs = SequenceTable::default();
    let mut sacn_streams: Vec<(Arc<Endpoint>, u16)> = Vec::new();
    while let Some(msg) = rx.recv().await {
        let now_ms = started_at.elapsed().as_millis() as u64;
        for (universe, data) in msg.frames {
            dispatcher.plan_into(universe, data, now_ms, &msg.target, false, &mut jobs);
        }
        for job in &jobs {
            if job.endpoint.protocol == ForwardProtocol::Sacn
                && sacn_streams.len() < MAX_TRACKED_STREAMS
                && !sacn_streams.iter().any(|(e, u)| Arc::ptr_eq(e, &job.endpoint) && *u == job.target_universe)
            {
                sacn_streams.push((job.endpoint.clone(), job.target_universe));
            }
        }
        dispatcher.send_frame(&mut jobs, &mut seqs, msg.target.sync()).await;
    }
    dispatcher.terminate_sacn(&sacn_streams, &mut seqs).await;
}

/// 会话结束时最多为多少个 sACN 流发送 Stream_Terminated。
const MAX_TRACKED_STREAMS: usize = 4096;

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(mode: Arc<RuntimeMode>) -> OutputHandle {
        OutputHandle::new(
            Dispatcher::with_table(forwarding::ForwardingTable::default(), crate::SenderSlot::default()),
            mode,
            Instant::now(),
        )
    }

    #[tokio::test]
    async fn 会话占用与释放_show_标志() {
        let mode = Arc::new(RuntimeMode::new());
        let h = handle(mode.clone());
        let out = ShowOutput::begin(&h).expect("空闲时应能开始");
        assert!(mode.is_show());
        assert_eq!(ShowOutput::begin(&h).err().as_deref(), Some(ERR_SHOW_ACTIVE));
        drop(out);
        assert!(!mode.is_show());
        assert!(ShowOutput::begin(&h).is_ok());
    }

    #[tokio::test]
    async fn 录制与回放进行时拒绝开始() {
        let mode = Arc::new(RuntimeMode::new());
        let h = handle(mode.clone());
        mode.set_recording(true);
        assert_eq!(ShowOutput::begin(&h).err().as_deref(), Some(ERR_RECORDING_ACTIVE));
        mode.set_recording(false);
        mode.set_playback(true);
        assert_eq!(ShowOutput::begin(&h).err().as_deref(), Some(ERR_PLAYBACK_ACTIVE));
        assert!(!mode.is_show(), "被拒绝时不得置位 show 标志");
    }

    #[tokio::test]
    async fn 空提交不入队_满队列计数丢弃() {
        // 手工组装会话，自己持有接收端，保证队列不被消费。
        let (tx, mut rx) = mpsc::channel(2);
        let out = ShowOutput {
            tx,
            mode: Arc::new(RuntimeMode::new()),
            dropped: AtomicU64::new(0),
        };
        let target = Arc::new(DispatchTarget::Forwarding);
        out.submit(&target, std::iter::empty());
        assert_eq!(out.dropped(), 0);
        assert!(rx.try_recv().is_err(), "空提交不应入队");
        let data = [7u8; 512];
        for _ in 0..5 {
            out.submit(&target, [(1u16, &data[..])]);
        }
        assert_eq!(out.dropped(), 3);
        let first = rx.try_recv().expect("队列里应有消息");
        assert_eq!(first.frames[0].0, 1);
        assert_eq!(first.frames[0].1.len(), 512);
    }
}
