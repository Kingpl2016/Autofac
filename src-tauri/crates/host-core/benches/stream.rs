//! 二进制 DMX 通道流微基准（带分配计数）：帧编码与实时变化检测。
//!
//! 引擎里有 256 个单来源 Universe（每路 512 字节伪随机数据），前端查看其中 8 个。
//!
//! - `encode::*`：[`FrameWriter`] 编码 1 / 8 个 Universe（`begin` → `push` → `finish`）；
//! - `legacy_json::one_universe`：被取代的 `engine:channels` JSON 载荷（`{universe, data}`）
//!   的序列化，作为对照；
//! - `live_channels::*`：一轮 [`LiveChannels`] 的 `prepare` → `collect` → `encode`：
//!   - `unchanged_8`：数据没有变化（稳态，不产生帧，目标 0 次分配）；
//!   - `changed_8`：8 个被查看 Universe 都有新帧（迭代内先摄取 8 帧，摄取成本一并计入）；
//!   - `full_8`：每轮订阅代次变化，强制全量。
//!
//! 进入 divan 之前用 `eprintln!` 打印新旧载荷体积。
//!
//! 运行：`cargo bench -p host-core --bench stream`；冒烟：追加 `-- --sample-count 5`。

mod common;

use std::net::{IpAddr, Ipv4Addr};
use std::time::Instant;

use artnet_net::{Bytes, DmxFrame, Protocol};
use divan::counter::{BytesCount, ItemsCount};
use divan::{black_box, Bencher};
use host_core::stream::{FrameWriter, LiveChannels, StreamKind, FLAG_FULL};
use serde::Serialize;
use signal_engine::{MergeMode, SignalEngine};

use common::{universe_data, SEED, UNIVERSES};

#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

/// 被查看的 Universe 数。
const VIEWED: u16 = 8;

/// 被取代的 `engine:channels` 事件载荷（与旧 host-core `ChannelsPayload` 同形）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyChannelsPayload {
    /// Universe 编号。
    universe: u16,
    /// 合并后的通道数据。
    data: Vec<u8>,
}

fn main() {
    let data = universe_data(SEED);
    let legacy_one = legacy_json_of(&data[0]).len();
    let frame_one = encode_frame(&data[..1]).len();
    let frame_eight = encode_frame(&data[..usize::from(VIEWED)]).len();
    eprintln!("== 通道数据载荷体积（512 字节伪随机数据 / Universe）==");
    eprintln!("旧 JSON engine:channels × 1  {legacy_one:>6} 字节（每个 Universe 一条事件）");
    eprintln!("新二进制帧 × 1 Universe       {frame_one:>6} 字节");
    eprintln!(
        "旧 JSON × {VIEWED}                  {:>6} 字节（{VIEWED} 条事件）",
        legacy_one * usize::from(VIEWED)
    );
    eprintln!("新二进制帧 × {VIEWED} Universe       {frame_eight:>6} 字节（1 帧）");
    divan::main();
}

/// 序列化旧 JSON 载荷。
///
/// # Arguments
///
/// * `data` - 通道数据。
///
/// # Returns
///
/// JSON 文本。
///
/// # Panics
///
/// 序列化失败时 panic（载荷只含数字，不会失败）。
fn legacy_json_of(data: &[u8]) -> String {
    serde_json::to_string(&LegacyChannelsPayload {
        universe: 1,
        data: data.to_vec(),
    })
    .expect("载荷只含数字，序列化不会失败")
}

/// 把若干 Universe 编成一个全量实时帧（Universe 编号即下标）。
///
/// # Arguments
///
/// * `data` - 各 Universe 的通道数据。
///
/// # Returns
///
/// 帧字节。
fn encode_frame(data: &[Vec<u8>]) -> Vec<u8> {
    let mut w = FrameWriter::new();
    w.begin(StreamKind::Live, FLAG_FULL);
    for (u, d) in (0u16..).zip(data) {
        w.push(u, d);
    }
    w.finish()
}

/// 构造一帧。
///
/// # Arguments
///
/// * `universe` - Universe 编号。
/// * `data` - 通道数据。
///
/// # Returns
///
/// 来自固定来源 IP 的 Art-Net 帧。
fn frame(universe: u16, data: Bytes) -> DmxFrame {
    DmxFrame {
        protocol: Protocol::ArtNet,
        universe,
        data,
        source: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
        sequence: 0,
        received_at: Instant::now(),
    }
}

/// 256 个单来源 Universe 的引擎，以及预构造的各 Universe 帧数据。
///
/// # Returns
///
/// `(引擎, 各 Universe 的 Bytes 数据)`。
fn engine_256() -> (SignalEngine, Vec<Bytes>) {
    let data: Vec<Bytes> = universe_data(SEED).into_iter().map(Bytes::from).collect();
    let mut eng = SignalEngine::new(MergeMode::Htp, 60_000);
    for (u, d) in (0..UNIVERSES).zip(&data) {
        eng.ingest(&frame(u, d.clone()), 0);
    }
    (eng, data)
}

/// 被查看的 Universe：在 256 个中均匀挑 8 个。
///
/// # Returns
///
/// Universe 编号列表。
fn viewed() -> Vec<u16> {
    (0..VIEWED).map(|i| i * (UNIVERSES / VIEWED)).collect()
}

/// 帧编码。
mod encode {
    use super::{
        black_box, universe_data, Bencher, BytesCount, FrameWriter, StreamKind, FLAG_FULL,
    };
    use super::{SEED, VIEWED};

    /// 公共实现：每次迭代编码 `n` 个 Universe。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按帧字节数计。
    /// * `n` - Universe 数。
    fn run(bencher: Bencher, n: usize) {
        let data = universe_data(SEED);
        let data = &data[..n];
        let mut w = FrameWriter::new();
        let len = super::encode_frame(data).len();
        bencher.counter(BytesCount::new(len)).bench_local(|| {
            w.begin(StreamKind::Live, FLAG_FULL);
            for (u, d) in (0u16..).zip(black_box(data)) {
                w.push(u, d);
            }
            w.finish()
        });
    }

    /// 1 个 Universe。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn one_universe(bencher: Bencher) {
        run(bencher, 1);
    }

    /// 8 个 Universe。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn viewed_8(bencher: Bencher) {
        run(bencher, usize::from(VIEWED));
    }
}

/// 旧 JSON 载荷对照。
mod legacy_json {
    use super::{black_box, legacy_json_of, universe_data, Bencher, BytesCount, SEED};

    /// 序列化 1 个 Universe 的 `engine:channels` JSON（含拷贝成 `Vec<u8>`，与旧实现一致）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按 JSON 字节数计。
    #[divan::bench]
    fn one_universe(bencher: Bencher) {
        let data = universe_data(SEED).swap_remove(0);
        let len = legacy_json_of(&data).len();
        bencher
            .counter(BytesCount::new(len))
            .bench_local(|| legacy_json_of(black_box(&data)));
    }
}

/// 实时变化检测一轮。
mod live_channels {
    use std::time::Instant;

    use super::{black_box, engine_256, frame, viewed, Bencher, ItemsCount, LiveChannels, VIEWED};

    /// 数据没有变化：不产生帧。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按被查看 Universe 数计。
    #[divan::bench]
    fn unchanged_8(bencher: Bencher) {
        let (eng, _) = engine_256();
        let viewed = viewed();
        let now = Instant::now();
        let mut live = LiveChannels::new();
        // 先发一次全量；之后同一时刻、同一代次只做增量检测
        live.prepare(&viewed, 0, now);
        live.collect(&eng);
        black_box(live.encode());
        bencher.counter(ItemsCount::new(VIEWED)).bench_local(|| {
            live.prepare(black_box(&viewed), 0, now);
            live.collect(&eng);
            live.encode()
        });
    }

    /// 8 个被查看 Universe 都有新帧（迭代内先摄取，成本一并计入）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按被查看 Universe 数计。
    #[divan::bench]
    fn changed_8(bencher: Bencher) {
        let (mut eng, data) = engine_256();
        let viewed = viewed();
        let frames: Vec<_> = viewed
            .iter()
            .map(|&u| frame(u, data[usize::from(u)].clone()))
            .collect();
        let now = Instant::now();
        let mut live = LiveChannels::new();
        live.prepare(&viewed, 0, now);
        live.collect(&eng);
        black_box(live.encode());
        let mut t = 0u64;
        bencher.counter(ItemsCount::new(VIEWED)).bench_local(|| {
            t += 1;
            for f in &frames {
                eng.ingest(f, t);
            }
            live.prepare(black_box(&viewed), 0, now);
            live.collect(&eng);
            live.encode()
        });
    }

    /// 每轮订阅代次变化，强制全量。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按被查看 Universe 数计。
    #[divan::bench]
    fn full_8(bencher: Bencher) {
        let (eng, _) = engine_256();
        let viewed = viewed();
        let now = Instant::now();
        let mut live = LiveChannels::new();
        let mut epoch = 0u64;
        bencher.counter(ItemsCount::new(VIEWED)).bench_local(|| {
            epoch += 1;
            live.prepare(black_box(&viewed), epoch, now);
            live.collect(&eng);
            live.encode()
        });
    }
}
