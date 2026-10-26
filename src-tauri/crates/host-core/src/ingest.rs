//! 实时摄取流水线：接收通道 → 帧旁路 → 合并引擎 → 路由解析 → 发送。
//!
//! 从运行时的接收循环抽出，不依赖 `AppHandle`，便于测试与基准：
//!
//! - [`IngestPipeline::process_batch`]（同步）：处理一批帧，产出发送任务；
//! - [`IngestPipeline::run`]（异步）：用 `recv_many` 批量取帧，逐批处理并发送。
//!
//! 每批的处理顺序：
//!
//! 1. 按原有规则丢弃：回放 / 播放器模式下丢弃全部帧（避免回放输出被自己重新摄取形成回环，
//!    并丢弃接收任务拆除后通道里残留的迟到帧）；sACN 关闭时丢弃 sACN 帧。两个开关每批读取一次；
//! 2. 逐帧旁路给帧接收器（录制等），各自非阻塞处理；
//! 3. **整批只加一次引擎锁**，按到达顺序逐帧摄取；该 Universe 有路由时立即取该帧之后的合并结果
//!    （单来源零拷贝），无路由的 Universe 不取合并结果、不分配；
//! 4. 解锁后逐条解析路由并限速（同一 Universe 一批内多次出现时逐帧处理，由限速器决定去留），
//!    与原逐帧处理等价。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use artnet_net::{Bytes, DmxFrame, Protocol};
use signal_engine::SignalEngine;
use tokio::sync::mpsc;

use crate::dispatch::{Dispatcher, ForwardJob};
use crate::mode::{FrameFanout, RuntimeMode};
use crate::util::lock;

/// 每批最多取的帧数。
pub const BATCH_LIMIT: usize = 256;

/// 一帧摄取后待解析路由的合并结果。
struct Pending {
    universe: u16,
    data: Bytes,
    now_ms: u64,
}

/// 实时摄取流水线。
pub struct IngestPipeline {
    engine: Arc<Mutex<SignalEngine>>,
    dispatcher: Dispatcher,
    fanout: FrameFanout,
    mode: Arc<RuntimeMode>,
    sacn_gate: Arc<AtomicBool>,
    /// 运行时起点：帧的逻辑时间 = 接收时刻 - 起点（毫秒，饱和）。
    start: Instant,
    /// 待解析路由的暂存区（逐批复用容量，稳态零分配）。
    scratch: Mutex<Vec<Pending>>,
}

impl IngestPipeline {
    /// 由运行时共享的组件构造。
    ///
    /// # Arguments
    ///
    /// * `engine` - 合并引擎（与界面推送任务共享）。
    /// * `dispatcher` - 输出分发器；其 sACN 开关同时决定是否摄取 sACN 帧。
    /// * `fanout` - 帧旁路扇出（录制等）。
    /// * `mode` - 运行模式仲裁；回放 / 播放器模式下丢弃全部帧。
    /// * `start` - 运行时起点，帧的逻辑时间据此计算。
    ///
    /// # Returns
    ///
    /// 新的 [`IngestPipeline`]。
    #[must_use]
    pub fn new(
        engine: Arc<Mutex<SignalEngine>>,
        dispatcher: Dispatcher,
        fanout: FrameFanout,
        mode: Arc<RuntimeMode>,
        start: Instant,
    ) -> Self {
        let sacn_gate = dispatcher.sacn_gate();
        Self {
            engine,
            dispatcher,
            fanout,
            mode,
            sacn_gate,
            start,
            scratch: Mutex::new(Vec::new()),
        }
    }

    /// 处理一批帧：丢弃 → 旁路 → 摄取（整批一次引擎锁）→ 解析路由，任务追加到 `jobs`。
    ///
    /// # Arguments
    ///
    /// * `frames` - 按到达顺序排列的帧。
    /// * `jobs` - 发送任务输出缓冲（追加，不清空；调用方复用以免重复分配）。
    pub fn process_batch(&self, frames: &[DmxFrame], jobs: &mut Vec<ForwardJob>) {
        // 回放 / 播放器模式：整批丢弃
        if self.mode.is_playback() || self.mode.is_player() {
            return;
        }
        // sACN 已关闭：丢弃通道里迟到的 sACN 帧，避免关闭后又被摄取、录制或转发
        let sacn_on = self.sacn_gate.load(Ordering::Relaxed);
        let keep = move |f: &&DmxFrame| sacn_on || f.protocol != Protocol::Sacn;

        // 旁路给已注册的帧接收器（录制等）：各自非阻塞处理，不影响下方合并与转发
        self.fanout.offer_each(frames.iter().filter(keep));

        let routes = self.dispatcher.routes();
        let mut pending = lock(&self.scratch);
        pending.clear();
        {
            let mut engine = lock(&self.engine);
            for frame in frames.iter().filter(keep) {
                let now_ms = self.now_ms(frame);
                engine.ingest(frame, now_ms);
                if routes.has_routes(frame.universe) {
                    if let Some(data) = engine.merged_bytes(frame.universe) {
                        pending.push(Pending {
                            universe: frame.universe,
                            data,
                            now_ms,
                        });
                    }
                }
            }
        }
        // 解析路由 + 限速，与回放共用同一分发器
        for p in pending.drain(..) {
            self.dispatcher
                .plan_routes_into(&routes, p.universe, p.data, p.now_ms, true, jobs);
        }
    }

    /// 帧的逻辑时间（毫秒）：接收时刻相对运行时起点，早于起点时为 `0`。
    fn now_ms(&self, frame: &DmxFrame) -> u64 {
        u64::try_from(
            frame
                .received_at
                .saturating_duration_since(self.start)
                .as_millis(),
        )
        .unwrap_or(u64::MAX)
    }

    /// 持续从 `rx` 批量取帧（每批至多 [`BATCH_LIMIT`] 帧）、处理并发送，直到通道关闭。
    ///
    /// # Arguments
    ///
    /// * `rx` - 接收任务写入的帧通道。
    pub async fn run(self, mut rx: mpsc::Receiver<DmxFrame>) {
        let mut batch: Vec<DmxFrame> = Vec::with_capacity(BATCH_LIMIT);
        let mut jobs: Vec<ForwardJob> = Vec::new();
        while rx.recv_many(&mut batch, BATCH_LIMIT).await > 0 {
            self.process_batch(&batch, &mut jobs);
            batch.clear();
            self.dispatcher.send_batch(&mut jobs).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, Weak};
    use std::time::{Duration, Instant};

    use artnet_net::artnet::{self, ArtNetPacket};
    use artnet_net::socket::DmxSender;
    use artnet_net::{Bytes, DmxFrame, Protocol};
    use forwarding::{ForwardDestination, ForwardMode, ForwardProtocol, ForwardingTable};
    use signal_engine::{MergeMode, SignalEngine};
    use tokio::net::UdpSocket;

    use super::IngestPipeline;
    use crate::dispatch::Dispatcher;
    use crate::mode::{FrameFanout, FrameSink, RuntimeMode};
    use crate::sender::SenderSlot;

    #[derive(Default)]
    struct Counter(AtomicUsize);

    impl FrameSink for Counter {
        fn offer(&self, _frame: &DmxFrame) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    struct Rig {
        pipeline: IngestPipeline,
        engine: Arc<Mutex<SignalEngine>>,
        dispatcher: Dispatcher,
        mode: Arc<RuntimeMode>,
        sink: Arc<Counter>,
        start: Instant,
    }

    fn dest(id: &str, protocol: ForwardProtocol, port: u16, offset: i32) -> ForwardDestination {
        ForwardDestination {
            id: id.into(),
            name: id.into(),
            target_ip: "127.0.0.1".into(),
            protocol,
            port,
            mode: ForwardMode::All,
            universe_offset: offset,
            default_delay_ms: 0,
            description: String::new(),
            enabled: true,
            overrides: Vec::new(),
        }
    }

    fn rig(table: ForwardingTable, sender: SenderSlot) -> Rig {
        let engine = Arc::new(Mutex::new(SignalEngine::new(MergeMode::Htp, 3000)));
        let dispatcher = Dispatcher::with_table(table, sender);
        let mode = Arc::new(RuntimeMode::new());
        let fanout = FrameFanout::new();
        let sink = Arc::new(Counter::default());
        let weak: Weak<dyn FrameSink> = Arc::downgrade(&(sink.clone() as Arc<dyn FrameSink>));
        fanout.register(weak);
        let start = Instant::now();
        let pipeline = IngestPipeline::new(
            engine.clone(),
            dispatcher.clone(),
            fanout,
            mode.clone(),
            start,
        );
        Rig {
            pipeline,
            engine,
            dispatcher,
            mode,
            sink,
            start,
        }
    }

    fn frame(
        rig: &Rig,
        protocol: Protocol,
        universe: u16,
        src: u8,
        data: &[u8],
        at_ms: u64,
    ) -> DmxFrame {
        DmxFrame {
            protocol,
            universe,
            data: Bytes::copy_from_slice(data),
            source: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, src))),
            sequence: 0,
            received_at: rig.start + Duration::from_millis(at_ms),
        }
    }

    fn two_dests() -> ForwardingTable {
        ForwardingTable {
            destinations: vec![
                dest("art", ForwardProtocol::ArtNet, 6454, 100),
                dest("sacn", ForwardProtocol::Sacn, 5568, 1),
            ],
        }
    }

    /// 喂帧 → 生成的任务携带该帧之后的合并结果；多来源按 HTP 合并；单来源零拷贝。
    #[test]
    fn batch_produces_jobs_with_merged_data() {
        let r = rig(two_dests(), SenderSlot::default());
        let a = frame(&r, Protocol::ArtNet, 3, 1, &[10, 200, 0], 0);
        let b = frame(&r, Protocol::ArtNet, 3, 2, &[50, 100, 7], 30);
        let mut jobs = Vec::new();
        r.pipeline.process_batch(&[a.clone(), b], &mut jobs);

        assert_eq!(r.sink.0.load(Ordering::Relaxed), 2, "每帧都旁路给接收器");
        // 第一帧：单来源（零拷贝，与帧共享缓冲）；第二帧：双来源 HTP 合并
        let targets: Vec<(&str, u16)> = jobs
            .iter()
            .map(|j| (&*j.endpoint.id, j.target_universe))
            .collect();
        assert_eq!(
            targets,
            vec![("art", 103), ("sacn", 4), ("art", 103), ("sacn", 4)]
        );
        assert_eq!(jobs[0].data, vec![10, 200, 0]);
        assert_eq!(jobs[0].data.as_ptr(), a.data.as_ptr(), "单来源零拷贝");
        assert_eq!(jobs[2].data, vec![50, 200, 7]);
        assert_eq!(
            r.engine.lock().unwrap().merged(3),
            Some(&[50u8, 200, 7][..])
        );
    }

    /// 同一 Universe 一批内多次出现时逐帧由限速器决定去留；逻辑时间取自帧的接收时刻。
    #[test]
    fn repeated_universe_in_one_batch_is_rate_limited_per_frame() {
        let r = rig(
            ForwardingTable {
                destinations: vec![dest("art", ForwardProtocol::ArtNet, 6454, 0)],
            },
            SenderSlot::default(),
        );
        let frames: Vec<DmxFrame> = [0u64, 10, 25, 30]
            .into_iter()
            .map(|t| frame(&r, Protocol::ArtNet, 1, 1, &[t as u8], t))
            .collect();
        let mut jobs = Vec::new();
        r.pipeline.process_batch(&frames, &mut jobs);
        let sent: Vec<u8> = jobs.iter().map(|j| j.data[0]).collect();
        assert_eq!(sent, vec![0, 25], "10ms 与 30ms 的帧距上次放行不足 22ms");
        assert_eq!(r.dispatcher.output_stats().snapshot().dropped, 2);
        assert_eq!(
            r.engine.lock().unwrap().total_packets(),
            4,
            "被限速的帧照常摄取"
        );
    }

    /// 无路由的 Universe 照常摄取与旁路，但不产出任务。
    #[test]
    fn universes_without_routes_are_ingested_but_not_planned() {
        let mut sel = dest("sel", ForwardProtocol::ArtNet, 6454, 0);
        sel.mode = ForwardMode::Selected;
        let r = rig(
            ForwardingTable {
                destinations: vec![sel],
            },
            SenderSlot::default(),
        );
        let mut jobs = Vec::new();
        r.pipeline
            .process_batch(&[frame(&r, Protocol::ArtNet, 9, 1, &[1, 2], 0)], &mut jobs);
        assert!(jobs.is_empty());
        assert_eq!(r.sink.0.load(Ordering::Relaxed), 1);
        assert_eq!(r.engine.lock().unwrap().merged(9), Some(&[1u8, 2][..]));
    }

    /// sACN 关闭时 sACN 帧既不摄取、不旁路，也不转发；Art-Net 帧不受影响。
    #[test]
    fn sacn_frames_are_dropped_when_sacn_is_off() {
        let r = rig(two_dests(), SenderSlot::default());
        r.dispatcher.set_sacn_enabled(false);
        let mut jobs = Vec::new();
        r.pipeline.process_batch(
            &[
                frame(&r, Protocol::Sacn, 5, 1, &[1], 0),
                frame(&r, Protocol::ArtNet, 6, 1, &[2], 0),
            ],
            &mut jobs,
        );
        assert_eq!(r.sink.0.load(Ordering::Relaxed), 1);
        let e = r.engine.lock().unwrap();
        assert!(e.merged(5).is_none(), "sACN 帧不应被摄取");
        assert!(e.merged(6).is_some());
        drop(e);
        // 只剩 Art-Net 目的地的任务
        let targets: Vec<(&str, u16)> = jobs
            .iter()
            .map(|j| (&*j.endpoint.id, j.target_universe))
            .collect();
        assert_eq!(targets, vec![("art", 106)]);
    }

    /// 回放 / 播放器模式下整批丢弃。
    #[test]
    fn playback_and_player_modes_drop_everything() {
        let r = rig(two_dests(), SenderSlot::default());
        let mut jobs = Vec::new();
        for (playback, player) in [(true, false), (false, true)] {
            r.mode.set_playback(playback);
            r.mode.set_player(player);
            r.pipeline
                .process_batch(&[frame(&r, Protocol::ArtNet, 1, 1, &[1], 0)], &mut jobs);
            assert!(jobs.is_empty());
            assert_eq!(r.sink.0.load(Ordering::Relaxed), 0);
            assert_eq!(r.engine.lock().unwrap().total_packets(), 0);
        }
        r.mode.set_playback(false);
        r.mode.set_player(false);
        r.pipeline
            .process_batch(&[frame(&r, Protocol::ArtNet, 1, 1, &[1], 0)], &mut jobs);
        assert_eq!(jobs.len(), 2, "回到实时后恢复");
    }

    /// 早于运行时起点的帧（时钟边界）逻辑时间饱和为 0。
    #[test]
    fn frames_before_start_saturate_to_zero() {
        let r = rig(two_dests(), SenderSlot::default());
        let mut f = frame(&r, Protocol::ArtNet, 1, 1, &[1], 0);
        f.received_at = r
            .start
            .checked_sub(Duration::from_millis(5))
            .unwrap_or(r.start);
        assert_eq!(r.pipeline.now_ms(&f), 0);
        assert_eq!(
            r.pipeline
                .now_ms(&frame(&r, Protocol::ArtNet, 1, 1, &[1], 1234)),
            1234
        );
    }

    /// 端到端：经通道喂帧，`run` 批量处理并把 Art-Net 包发到本机套接字；通道关闭后返回。
    #[tokio::test]
    async fn run_forwards_frames_from_the_channel() {
        let rx_sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx_sock.local_addr().unwrap().port();
        let sender: SenderSlot = Arc::new(arc_swap::ArcSwapOption::new(Some(Arc::new(
            DmxSender::new([0u8; 16]).await.unwrap(),
        ))));
        let r = rig(
            ForwardingTable {
                destinations: vec![dest("art", ForwardProtocol::ArtNet, port, 100)],
            },
            sender,
        );
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tx.send(frame(&r, Protocol::ArtNet, 7, 1, &[1, 2, 3], 0))
            .await
            .unwrap();
        drop(tx);
        let Rig {
            pipeline,
            dispatcher,
            ..
        } = r;
        tokio::time::timeout(Duration::from_secs(2), pipeline.run(rx))
            .await
            .expect("通道关闭后应返回");

        let mut buf = [0u8; 2048];
        let (n, _) = tokio::time::timeout(Duration::from_secs(2), rx_sock.recv_from(&mut buf))
            .await
            .expect("应收到包")
            .unwrap();
        match artnet::parse(&buf[..n]) {
            Some(ArtNetPacket::Dmx {
                port_address, data, ..
            }) => {
                assert_eq!(port_address, 107);
                assert_eq!(&data[..3], &[1, 2, 3]);
            }
            other => panic!("期望 ArtDmx，实际 {other:?}"),
        }
        assert_eq!(dispatcher.output_stats().snapshot().sent, 1);
    }
}
