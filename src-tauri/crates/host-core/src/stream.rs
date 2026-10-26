//! 二进制 DMX 通道流：经 Tauri [`Channel`] 向主窗口推送紧凑的二进制帧，
//! 取代逐 Universe 一条 JSON 的 `engine:channels` 事件。
//!
//! # 帧格式 v1（全部小端）
//!
//! | 偏移 | 类型  | 含义 |
//! |------|-------|------|
//! | 0    | `u8`  | 魔数 [`FRAME_MAGIC`]（`0x44`，即 ASCII `'D'`） |
//! | 1    | `u8`  | 版本 [`FRAME_VERSION`]（`1`） |
//! | 2    | `u8`  | 类别 [`StreamKind`]：`1` 实时、`2` 回放 |
//! | 3    | `u8`  | 标志位：bit0 = [`FLAG_FULL`]（全量） |
//! | 4    | `u16` | 条目数 `count` |
//!
//! 随后 `count` 条，每条为 `u16 universe`、`u16 len` 与 `len` 字节通道数据。
//!
//! - `len = 0`：该 Universe 当前无数据，前端删除它；
//! - 全量帧（带 [`FLAG_FULL`]）：前端用本帧内容整体替换该类别的通道表，
//!   帧里没有出现的 Universe 视为已移除；
//! - 增量帧：只包含有变化的 Universe，前端按条目合并。
//!
//! 只有主窗口订阅，所以 [`DmxStream`] 至多持有一个订阅者；新订阅替换旧订阅。

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use signal_engine::SignalEngine;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::util::lock;

/// 帧魔数（ASCII `'D'`）。
pub const FRAME_MAGIC: u8 = 0x44;
/// 帧格式版本。
pub const FRAME_VERSION: u8 = 1;
/// 标志位 bit0：全量帧（前端整体替换该类别的通道表）。
pub const FLAG_FULL: u8 = 0b0000_0001;
/// 帧头长度（字节）：魔数、版本、类别、标志位各 1 字节 + `u16` 条目数。
pub const HEADER_LEN: usize = 6;
/// 每个条目的头部长度（字节）：`u16 universe` + `u16 len`。
pub const ENTRY_HEADER_LEN: usize = 4;
/// 单个条目的最大数据长度（`len` 为 `u16`）；更长的数据被截断。
pub const MAX_ENTRY_LEN: usize = u16::MAX as usize;

/// 实时通道流两次全量帧之间的最长间隔。
///
/// 即使数据没有任何变化也每秒发一次全量帧兜底：前端漏收或丢弃坏帧后能在 1 秒内自愈。
pub const FULL_FRAME_INTERVAL: Duration = Duration::from_secs(1);

/// 一帧单个 Universe 的通道数（DMX512）；用于预估缓冲容量。
const DMX_CHANNELS: usize = 512;

/// 帧的数据类别（帧头第 3 字节）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum StreamKind {
    /// 实时接收的合并输出。
    Live = 1,
    /// 节目回放的输出（由回放控制器产生）。
    Playback = 2,
}

/// 可复用缓冲的帧编码器。
///
/// 用法：[`begin`](Self::begin) → 若干次 [`push`](Self::push) → [`finish`](Self::finish)。
/// `finish` 交出本帧的 `Vec<u8>`（Tauri 的 [`InvokeResponseBody::Raw`] 需要所有权），
/// 并按本帧大小预分配下一帧的缓冲，稳态下每帧只分配一次、不发生扩容拷贝。
#[derive(Debug, Default)]
pub struct FrameWriter {
    /// 当前帧的字节；为空表示尚未 `begin`。
    buf: Vec<u8>,
    /// 已写入的条目数。
    count: u16,
}

impl FrameWriter {
    /// 创建编码器。
    ///
    /// # Returns
    ///
    /// 尚未开始任何帧的编码器。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 开始一帧：清空缓冲（保留容量）并写入帧头。
    ///
    /// # Arguments
    ///
    /// * `kind` - 帧的数据类别。
    /// * `flags` - 标志位（如 [`FLAG_FULL`]）。
    pub fn begin(&mut self, kind: StreamKind, flags: u8) {
        self.buf.clear();
        self.count = 0;
        self.buf
            .extend_from_slice(&[FRAME_MAGIC, FRAME_VERSION, kind as u8, flags, 0, 0]);
    }

    /// 追加一个 Universe 条目。
    ///
    /// # Arguments
    ///
    /// * `universe` - Universe 编号。
    /// * `data` - 通道数据；空切片表示该 Universe 当前无数据（前端删除它）；
    ///   超过 [`MAX_ENTRY_LEN`] 字节的部分被截断。
    ///
    /// # Returns
    ///
    /// 写入成功为 `true`；尚未 [`begin`](Self::begin)，或条目数已达 `u16::MAX` 时为
    /// `false`（不写入任何字节）。
    pub fn push(&mut self, universe: u16, data: &[u8]) -> bool {
        if self.buf.len() < HEADER_LEN || self.count == u16::MAX {
            return false;
        }
        let data = &data[..data.len().min(MAX_ENTRY_LEN)];
        self.buf.extend_from_slice(&universe.to_le_bytes());
        self.buf
            .extend_from_slice(&(data.len() as u16).to_le_bytes());
        self.buf.extend_from_slice(data);
        self.count += 1;
        true
    }

    /// 当前帧已写入的条目数。
    ///
    /// # Returns
    ///
    /// 自上次 [`begin`](Self::begin) 以来成功 [`push`](Self::push) 的次数。
    #[must_use]
    pub fn count(&self) -> u16 {
        self.count
    }

    /// 结束当前帧：回填条目数并交出整帧字节。
    ///
    /// 之后须再次 [`begin`](Self::begin) 才能写下一帧。
    ///
    /// # Returns
    ///
    /// 完整的帧字节；尚未 `begin` 时返回空 `Vec`。
    pub fn finish(&mut self) -> Vec<u8> {
        if self.buf.len() < HEADER_LEN {
            return Vec::new();
        }
        self.buf[4..HEADER_LEN].copy_from_slice(&self.count.to_le_bytes());
        self.count = 0;
        let capacity = self.buf.len();
        std::mem::replace(&mut self.buf, Vec::with_capacity(capacity))
    }
}

/// 当前订阅者。
struct Subscriber {
    /// 订阅 id（由 [`DmxStream::subscribe`] 分配）。
    id: u32,
    /// 前端创建的通道；发送 [`InvokeResponseBody::Raw`] 时前端收到 `ArrayBuffer`。
    channel: Channel<InvokeResponseBody>,
}

/// 二进制通道流的订阅槽：至多一个订阅者（主窗口）。
///
/// 生产者（实时推送任务、回放控制器）各自维护变化检测与帧编码器，只经
/// [`send`](Self::send) 投递整帧；订阅变化时 [`epoch`](Self::epoch) 改变，生产者据此
/// 让下一帧强制为全量。
#[derive(Default)]
pub struct DmxStream {
    /// 当前订阅者。
    subscriber: Mutex<Option<Subscriber>>,
    /// 最近分配的订阅 id。
    last_id: AtomicU32,
    /// 全量代次：订阅变化或 [`request_full`](Self::request_full) 时 +1。
    epoch: AtomicU64,
}

impl DmxStream {
    /// 创建没有订阅者的通道流。
    ///
    /// # Returns
    ///
    /// 空的 [`DmxStream`]。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 订阅通道流；替换此前的订阅者（旧通道在锁外释放，Tauri 随即通知前端结束）。
    ///
    /// # Arguments
    ///
    /// * `channel` - 前端创建的通道。
    ///
    /// # Returns
    ///
    /// 本次订阅的 id（递增，从 `1` 开始）；取消时须原样传回 [`unsubscribe`](Self::unsubscribe)。
    pub fn subscribe(&self, channel: Channel<InvokeResponseBody>) -> u32 {
        let id = self.last_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let old = lock(&self.subscriber).replace(Subscriber { id, channel });
        self.epoch.fetch_add(1, Ordering::AcqRel);
        drop(old);
        id
    }

    /// 取消订阅；`id` 不是当前订阅者时什么也不做。
    ///
    /// React 严格模式下旧组件的取消可能晚于新组件的订阅到达，按 id 匹配可避免把新订阅清掉。
    ///
    /// # Arguments
    ///
    /// * `id` - [`subscribe`](Self::subscribe) 返回的订阅 id。
    ///
    /// # Returns
    ///
    /// 确实取消了当前订阅时为 `true`。
    pub fn unsubscribe(&self, id: u32) -> bool {
        let removed = {
            let mut slot = lock(&self.subscriber);
            if slot.as_ref().is_some_and(|s| s.id == id) {
                slot.take()
            } else {
                None
            }
        };
        let hit = removed.is_some();
        if hit {
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        drop(removed);
        hit
    }

    /// 是否有订阅者；没有时生产者应跳过全部通道工作。
    ///
    /// # Returns
    ///
    /// 有订阅者时为 `true`。
    #[must_use]
    pub fn has_subscriber(&self) -> bool {
        lock(&self.subscriber).is_some()
    }

    /// 全量代次：订阅变化或 [`request_full`](Self::request_full) 后改变。
    ///
    /// 生产者记录上次看到的值，不同即让下一帧为全量。
    ///
    /// # Returns
    ///
    /// 当前代次（数值本身无意义，只用于比较）。
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    /// 要求各生产者的下一帧为全量（如查看集合变化）。
    pub fn request_full(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }

    /// 向当前订阅者发送一帧。
    ///
    /// 只在锁内克隆通道句柄，发送在锁外进行。发送失败（webview 已关闭 / 重载）时清掉该订阅，
    /// 之后 [`has_subscriber`](Self::has_subscriber) 为 `false`，直到前端重新订阅。
    ///
    /// # Arguments
    ///
    /// * `frame` - 完整的帧字节（见模块文档的帧格式）。
    ///
    /// # Returns
    ///
    /// 已交给通道为 `true`；没有订阅者或发送失败为 `false`。
    pub fn send(&self, frame: Vec<u8>) -> bool {
        let Some((id, channel)) = lock(&self.subscriber)
            .as_ref()
            .map(|s| (s.id, s.channel.clone()))
        else {
            return false;
        };
        match channel.send(InvokeResponseBody::Raw(frame)) {
            Ok(()) => true,
            Err(e) => {
                tracing::debug!(error = %e, id, "DMX 通道流发送失败，清除订阅");
                drop(channel);
                self.unsubscribe(id);
                false
            }
        }
    }
}

/// 暂存的一个条目：数据位于 [`LiveChannels`] 暂存缓冲的 `start..start + len`。
#[derive(Debug, Clone, Copy)]
struct Staged {
    /// Universe 编号。
    universe: u16,
    /// 数据在暂存缓冲中的起点。
    start: usize,
    /// 数据长度；`0` 表示该 Universe 已无数据。
    len: usize,
}

/// 实时通道流的变化检测与编码（每个 UI 刷新周期一轮）。
///
/// 一轮分三步，让引擎锁的临界区只做查表与拷贝：
///
/// 1. 锁外 [`prepare`](Self::prepare)：同步查看集合与全量代次，决定本轮是否全量；
/// 2. 引擎锁内 [`collect`](Self::collect)：只拷贝 `data_gen` 变化（全量时为全部有数据）的
///    Universe 到复用的暂存缓冲；
/// 3. 锁外 [`encode`](Self::encode)：编码成帧；增量且无任何变化时不产生帧。
///
/// 触发全量的条件：查看集合变化、订阅变化（代次改变）、距上次全量满 [`FULL_FRAME_INTERVAL`]。
/// Universe 从有数据变为无数据时，增量帧里给出 `len = 0` 条目。
#[derive(Debug, Default)]
pub struct LiveChannels {
    /// 当前查看集合（按前端给出的顺序）。
    viewed: Vec<u16>,
    /// 与 `viewed` 一一对应：上次发给前端的数据代号；`None` 表示前端没有该 Universe 的数据。
    sent: Vec<Option<u64>>,
    /// 本轮暂存的条目。
    staged: Vec<Staged>,
    /// 本轮暂存的通道数据（复用，不随轮次分配）。
    scratch: Vec<u8>,
    /// 帧编码器。
    writer: FrameWriter,
    /// 上次看到的全量代次。
    epoch: Option<u64>,
    /// 上次全量帧的时刻。
    last_full: Option<Instant>,
    /// 本轮是否全量。
    full: bool,
}

impl LiveChannels {
    /// 创建变化检测器；第一轮必为全量。
    ///
    /// # Returns
    ///
    /// 空的 [`LiveChannels`]。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 第 1 步（锁外）：同步查看集合与全量代次，决定本轮是否全量，并清空暂存。
    ///
    /// # Arguments
    ///
    /// * `viewed` - 前端当前查看的 Universe。
    /// * `epoch` - 通道流的全量代次（[`DmxStream::epoch`]）。
    /// * `now` - 当前时刻。
    ///
    /// # Returns
    ///
    /// 本轮是否为全量帧。
    pub fn prepare(&mut self, viewed: &[u16], epoch: u64, now: Instant) -> bool {
        let viewed_changed = self.viewed != viewed;
        if viewed_changed {
            self.viewed.clear();
            self.viewed.extend_from_slice(viewed);
            self.sent.clear();
            self.sent.resize(viewed.len(), None);
        }
        let epoch_changed = self.epoch != Some(epoch);
        self.epoch = Some(epoch);
        let stale = self
            .last_full
            .is_none_or(|t| now.saturating_duration_since(t) >= FULL_FRAME_INTERVAL);
        self.full = viewed_changed || epoch_changed || stale;
        if self.full {
            self.last_full = Some(now);
        }
        self.staged.clear();
        self.scratch.clear();
        let needed = self.viewed.len() * DMX_CHANNELS;
        self.scratch.reserve(needed);
        self.full
    }

    /// 第 2 步（引擎锁内）：把需要发送的 Universe 数据拷进暂存缓冲。
    ///
    /// # Arguments
    ///
    /// * `engine` - 已加锁的信号引擎。
    pub fn collect(&mut self, engine: &SignalEngine) {
        for (&universe, sent) in self.viewed.iter().zip(self.sent.iter_mut()) {
            let data_gen = engine.data_gen(universe);
            if !self.full && data_gen == *sent {
                continue;
            }
            *sent = data_gen;
            match engine.merged(universe) {
                Some(data) => {
                    let start = self.scratch.len();
                    self.scratch.extend_from_slice(data);
                    self.staged.push(Staged {
                        universe,
                        start,
                        len: data.len(),
                    });
                }
                // 全量帧里省略即表示移除；增量帧需要显式的 len = 0
                None if !self.full => self.staged.push(Staged {
                    universe,
                    start: self.scratch.len(),
                    len: 0,
                }),
                None => {}
            }
        }
    }

    /// 第 3 步（锁外）：把暂存条目编码成帧。
    ///
    /// # Returns
    ///
    /// 需要发送时返回整帧字节；增量且没有任何变化时返回 `None`（不发送）。
    pub fn encode(&mut self) -> Option<Vec<u8>> {
        if !self.full && self.staged.is_empty() {
            return None;
        }
        let flags = if self.full { FLAG_FULL } else { 0 };
        self.writer.begin(StreamKind::Live, flags);
        for s in &self.staged {
            let data = self
                .scratch
                .get(s.start..s.start + s.len)
                .unwrap_or_default();
            self.writer.push(s.universe, data);
        }
        Some(self.writer.finish())
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use artnet_net::{Bytes, DmxFrame, Protocol};
    use signal_engine::{MergeMode, SignalEngine};
    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::{DmxStream, FrameWriter, LiveChannels, StreamKind, FLAG_FULL, HEADER_LEN};

    /// 解析后的帧：（类别, 标志位, 条目）。
    type Parsed = (u8, u8, Vec<(u16, Vec<u8>)>);

    /// 测试用解码器（与前端 `decodeDmxFrame` 同一格式）。
    fn parse(buf: &[u8]) -> Parsed {
        assert!(buf.len() >= HEADER_LEN);
        assert_eq!(&buf[..2], &[0x44, 1]);
        let count = u16::from_le_bytes([buf[4], buf[5]]);
        let mut at = HEADER_LEN;
        let mut entries = Vec::new();
        for _ in 0..count {
            let universe = u16::from_le_bytes([buf[at], buf[at + 1]]);
            let len = usize::from(u16::from_le_bytes([buf[at + 2], buf[at + 3]]));
            at += 4;
            entries.push((universe, buf[at..at + len].to_vec()));
            at += len;
        }
        assert_eq!(at, buf.len(), "帧尾不应有多余字节");
        (buf[2], buf[3], entries)
    }

    fn frame(universe: u16, ip: u8, data: &[u8]) -> DmxFrame {
        DmxFrame {
            protocol: Protocol::ArtNet,
            universe,
            data: Bytes::copy_from_slice(data),
            source: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, ip))),
            sequence: 0,
            received_at: Instant::now(),
        }
    }

    // ---- 帧编码器 ----

    /// 与前端 `dmxFrame.test.ts` 共用的字节向量。
    const SHARED_VECTOR: [u8; 17] = [
        0x44, 0x01, 0x01, 0x01, 0x02, 0x00, // 魔数 / 版本 / 实时 / 全量 / count=2
        0x01, 0x00, 0x03, 0x00, 10, 20, 30, // Universe 1，3 字节
        0x2C, 0x01, 0x00, 0x00, // Universe 300，len=0
    ];

    #[test]
    fn writer_matches_shared_byte_vector() {
        let mut w = FrameWriter::new();
        w.begin(StreamKind::Live, FLAG_FULL);
        assert!(w.push(1, &[10, 20, 30]));
        assert!(w.push(300, &[]));
        assert_eq!(w.count(), 2);
        assert_eq!(w.finish(), SHARED_VECTOR);
    }

    #[test]
    fn writer_encodes_empty_and_playback_frames_and_is_reusable() {
        let mut w = FrameWriter::new();
        w.begin(StreamKind::Live, FLAG_FULL);
        assert_eq!(w.finish(), [0x44, 1, 1, 1, 0, 0]);

        // 复用：上一帧的内容不会残留
        w.begin(StreamKind::Playback, 0);
        assert!(w.push(0x1234, &[7]));
        let bytes = w.finish();
        assert_eq!(bytes, [0x44, 1, 2, 0, 1, 0, 0x34, 0x12, 1, 0, 7]);
        assert_eq!(parse(&bytes), (2, 0, vec![(0x1234, vec![7])]));
    }

    #[test]
    fn writer_refuses_without_begin_and_truncates_long_entries() {
        let mut w = FrameWriter::new();
        assert!(!w.push(1, &[1]), "未 begin 不能写入");
        assert!(w.finish().is_empty());

        w.begin(StreamKind::Live, 0);
        assert!(w.push(9, &vec![5u8; 70_000]));
        let bytes = w.finish();
        assert_eq!(&bytes[HEADER_LEN + 2..HEADER_LEN + 4], &[0xFF, 0xFF]);
        assert_eq!(bytes.len(), HEADER_LEN + 4 + usize::from(u16::MAX));
        // finish 之后须重新 begin
        assert!(!w.push(1, &[1]));
    }

    #[test]
    fn writer_count_saturates_at_u16_max() {
        let mut w = FrameWriter::new();
        w.begin(StreamKind::Live, 0);
        for u in 0..u16::MAX {
            assert!(w.push(u, &[]));
        }
        assert_eq!(w.count(), u16::MAX);
        assert!(!w.push(0, &[1]), "条目数已满");
        let bytes = w.finish();
        assert_eq!(&bytes[4..6], &[0xFF, 0xFF]);
        assert_eq!(bytes.len(), HEADER_LEN + usize::from(u16::MAX) * 4);
    }

    // ---- 订阅槽 ----

    type Sink = Arc<Mutex<Vec<Vec<u8>>>>;

    /// 造一个把收到的 Raw 载荷记进 `sink` 的通道。
    fn recording_channel(sink: &Sink) -> Channel<InvokeResponseBody> {
        let sink = sink.clone();
        Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().push(bytes);
            }
            Ok(())
        })
    }

    #[test]
    fn subscribe_replaces_and_unsubscribe_requires_matching_id() {
        let stream = DmxStream::new();
        assert!(!stream.has_subscriber());
        assert!(!stream.send(vec![1]), "没有订阅者时不发送");

        let (a, b): (Sink, Sink) = Default::default();
        let e0 = stream.epoch();
        let id_a = stream.subscribe(recording_channel(&a));
        assert_ne!(stream.epoch(), e0, "订阅变化须改变代次");
        let id_b = stream.subscribe(recording_channel(&b));
        assert!(id_b > id_a);

        assert!(stream.send(vec![9, 9]));
        assert!(a.lock().unwrap().is_empty(), "旧订阅已被替换");
        assert_eq!(*b.lock().unwrap(), vec![vec![9, 9]]);

        // 旧组件迟到的取消不影响新订阅
        let e1 = stream.epoch();
        assert!(!stream.unsubscribe(id_a));
        assert!(stream.has_subscriber());
        assert_eq!(stream.epoch(), e1);

        assert!(stream.unsubscribe(id_b));
        assert!(!stream.has_subscriber());
        assert_ne!(stream.epoch(), e1);
    }

    #[test]
    fn failed_send_drops_the_subscription() {
        let stream = DmxStream::new();
        stream.subscribe(Channel::new(|_| Err(tauri::Error::WebviewNotFound)));
        assert!(!stream.send(vec![1]));
        assert!(!stream.has_subscriber());
    }

    #[test]
    fn request_full_changes_epoch() {
        let stream = DmxStream::new();
        let e = stream.epoch();
        stream.request_full();
        assert_ne!(stream.epoch(), e);
    }

    // ---- 实时变化检测 ----

    /// 跑一轮：prepare → collect → encode。
    fn round(
        live: &mut LiveChannels,
        engine: &SignalEngine,
        viewed: &[u16],
        epoch: u64,
        now: Instant,
    ) -> Option<Parsed> {
        live.prepare(viewed, epoch, now);
        live.collect(engine);
        live.encode().map(|b| parse(&b))
    }

    #[test]
    fn live_channels_sends_full_then_only_changes() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 1000);
        eng.ingest(&frame(1, 1, &[1, 2, 3]), 0);
        let mut live = LiveChannels::new();
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);

        // 首轮全量：只含有数据的 Universe（2 无数据，省略即表示移除）
        let first = round(&mut live, &eng, &[1, 2], 7, t0).unwrap();
        assert_eq!(first, (1, FLAG_FULL, vec![(1, vec![1, 2, 3])]));

        // 没有变化：不发送
        assert_eq!(round(&mut live, &eng, &[1, 2], 7, ms(33)), None);

        // 只有 Universe 2 出现数据：增量只含 2
        eng.ingest(&frame(2, 1, &[9]), 50);
        let inc = round(&mut live, &eng, &[1, 2], 7, ms(66)).unwrap();
        assert_eq!(inc, (1, 0, vec![(2, vec![9])]));

        // 未查看的 Universe 变化不触发发送
        eng.ingest(&frame(3, 1, &[4]), 60);
        assert_eq!(round(&mut live, &eng, &[1, 2], 7, ms(99)), None);

        // Universe 1 的来源超时被剔除（2 未受影响、代号不变）：增量只给出 1 的 len = 0
        eng.prune(1020);
        let gone = round(&mut live, &eng, &[1, 2], 7, ms(132)).unwrap();
        assert_eq!(gone, (1, 0, vec![(1, vec![])]));
        // 已告知移除：不重复发送
        assert_eq!(round(&mut live, &eng, &[1, 2], 7, ms(165)), None);
    }

    #[test]
    fn live_channels_forces_full_on_viewed_epoch_and_interval() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 10_000);
        eng.ingest(&frame(1, 1, &[1]), 0);
        eng.ingest(&frame(2, 1, &[2]), 0);
        let mut live = LiveChannels::new();
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        assert!(round(&mut live, &eng, &[1], 1, t0).is_some());
        assert_eq!(round(&mut live, &eng, &[1], 1, ms(10)), None);

        // 查看集合变化：全量
        let viewed = round(&mut live, &eng, &[2, 1], 1, ms(20)).unwrap();
        assert_eq!(viewed, (1, FLAG_FULL, vec![(2, vec![2]), (1, vec![1])]));

        // 订阅变化（代次改变）：全量
        let epoch = round(&mut live, &eng, &[2, 1], 2, ms(30)).unwrap();
        assert_eq!(epoch.1, FLAG_FULL);
        assert_eq!(round(&mut live, &eng, &[2, 1], 2, ms(500)), None);

        // 距上次全量满 1 秒：全量兜底
        let beat = round(&mut live, &eng, &[2, 1], 2, ms(1030)).unwrap();
        assert_eq!(beat.1, FLAG_FULL);
        assert_eq!(beat.2.len(), 2);

        // 查看集合清空：全量空帧，让前端清空通道表
        let empty = round(&mut live, &eng, &[], 2, ms(1040)).unwrap();
        assert_eq!(empty, (1, FLAG_FULL, vec![]));
    }
}
