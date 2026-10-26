//! 推送载荷 JSON 序列化成本与体积基准（divan，带分配计数）。
//!
//! 宿主层把引擎状态以 JSON（`serde_json`）推送给前端，这里度量“改动前”的
//! 序列化耗时、分配次数与载荷体积：
//!
//! - `snapshot_256_json`：256 个单来源 Universe 的 [`SignalEngine::snapshot`] 结果。
//! - `channels_payload_json::random`：与旧 host-core `ChannelsPayload`（`engine:channels` 事件，
//!   现已由二进制通道流取代，见 `cargo bench -p host-core --bench stream`）同形的结构，
//!   `data` 为 512 个确定性 xorshift 伪随机字节（JSON 中多为 2~3 位数字）。
//! - `channels_payload_json::zeros`：同上但 `data` 全 0（JSON 体积下限）。
//!
//! 吞吐量以 [`BytesCount`] 报告序列化输出字节数；进入 divan 之前还会用
//! `eprintln!` 打印每种载荷的字节数，便于记录基线体积。
//!
//! 运行：`cargo bench -p signal-engine --bench payload`。

use std::net::{IpAddr, Ipv4Addr};
use std::time::Instant;

use artnet_net::{DmxFrame, Protocol};
use bytes::Bytes;
use divan::counter::BytesCount;
use divan::{black_box, Bencher};
use serde::Serialize;
use signal_engine::{MergeMode, SignalEngine, UniverseSnapshot};

/// 带分配计数的全局分配器：divan 据此在结果中报告每次迭代的分配次数与字节数。
#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

fn main() {
    // 基线体积：在基准开始前打印，避免与 divan 的表格输出交织。
    eprintln!("== 载荷 JSON 体积（serde_json::to_string）==");
    eprintln!(
        "snapshot_256            {:>7} 字节",
        to_json(&snapshot_256()).len()
    );
    eprintln!(
        "channels_payload/random {:>7} 字节",
        to_json(&channels_random()).len()
    );
    eprintln!(
        "channels_payload/zeros  {:>7} 字节",
        to_json(&channels_zeros()).len()
    );
    divan::main();
}

/// 一帧 DMX 的通道数。
const CHANNELS: usize = 512;

/// 快照场景的 Universe 数。
const UNIVERSES: u16 = 256;

/// 通道载荷场景使用的 Universe 编号。
const PAYLOAD_UNIVERSE: u16 = 1;

/// xorshift 伪随机种子（非 0）。
const XORSHIFT_SEED: u32 = 0x2545_F491;

/// 与旧 host-core `ChannelsPayload`（已移除的 `engine:channels` 事件载荷）同形的本地结构。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelsPayload {
    /// Universe 编号。
    universe: u16,
    /// 合并后的通道数据。
    data: Vec<u8>,
}

/// 序列化为 JSON 字符串。
///
/// # Arguments
///
/// * `value` - 待序列化的值。
///
/// # Returns
///
/// JSON 文本。
///
/// # Panics
///
/// 序列化失败时 panic（这些载荷只含数字 / 字符串，不会失败）。
fn to_json(value: &impl Serialize) -> String {
    serde_json::to_string(value).expect("载荷只含数字与字符串，序列化不会失败")
}

/// 用 xorshift32 生成确定性的伪随机字节。
///
/// # Arguments
///
/// * `len` - 字节数。
/// * `seed` - 非 0 种子。
///
/// # Returns
///
/// 长度为 `len` 的字节序列（取每步状态的高 8 位）。
fn xorshift_bytes(len: usize, seed: u32) -> Vec<u8> {
    let mut x = seed;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            // cast_possible_truncation 已在 crate 级允许：右移 24 位后只剩 8 位。
            (x >> 24) as u8
        })
        .collect()
}

/// 构造 256 个单来源 Universe 的引擎并取快照。
///
/// # Returns
///
/// 按 Universe 升序的 256 条快照。
fn snapshot_256() -> Vec<UniverseSnapshot> {
    let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
    let ip = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));
    for universe in 0..UNIVERSES {
        let frame = DmxFrame {
            protocol: Protocol::ArtNet,
            universe,
            data: Bytes::from(xorshift_bytes(
                CHANNELS,
                XORSHIFT_SEED ^ u32::from(universe),
            )),
            source: Some(ip),
            sequence: 0,
            received_at: Instant::now(),
        };
        eng.ingest(&frame, u64::from(universe));
    }
    eng.snapshot()
}

/// 构造 `data` 为 512 个伪随机字节的通道载荷。
///
/// # Returns
///
/// 随机样数据的 [`ChannelsPayload`]。
fn channels_random() -> ChannelsPayload {
    ChannelsPayload {
        universe: PAYLOAD_UNIVERSE,
        data: xorshift_bytes(CHANNELS, XORSHIFT_SEED),
    }
}

/// 构造 `data` 为 512 个 0 的通道载荷。
///
/// # Returns
///
/// 全 0 数据的 [`ChannelsPayload`]。
fn channels_zeros() -> ChannelsPayload {
    ChannelsPayload {
        universe: PAYLOAD_UNIVERSE,
        data: vec![0; CHANNELS],
    }
}

/// 序列化 256 Universe 快照。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按 JSON 输出字节数计。
#[divan::bench]
fn snapshot_256_json(bencher: Bencher) {
    let snap = snapshot_256();
    let len = to_json(&snap).len();
    bencher
        .counter(BytesCount::new(len))
        .bench(|| serde_json::to_string(black_box(&snap)));
}

/// 序列化单个 Universe 的通道数据载荷。
mod channels_payload_json {
    use super::{
        black_box, channels_random, channels_zeros, to_json, Bencher, BytesCount, ChannelsPayload,
    };

    /// 基准公共实现：按载荷 JSON 长度设置吞吐量后序列化。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    /// * `payload` - 待序列化的载荷。
    fn bench_payload(bencher: Bencher, payload: &ChannelsPayload) {
        let len = to_json(payload).len();
        bencher
            .counter(BytesCount::new(len))
            .bench(|| serde_json::to_string(black_box(payload)));
    }

    /// `data` 为 512 个伪随机字节。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn random(bencher: Bencher) {
        bench_payload(bencher, &channels_random());
    }

    /// `data` 全 0。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn zeros(bencher: Bencher) {
        bench_payload(bencher, &channels_zeros());
    }
}
