//! signal-engine 接收管线热路径微基准（divan，带分配计数）。
//!
//! 度量以下路径的单次耗时与堆分配次数 / 字节数（基准名沿用优化前的基线，便于对比）：
//!
//! - `ingest_then_merged_output::{single_source, dual_source}`：256 个 Universe，
//!   循环对第 `i % 256` 个 Universe 做一次 [`SignalEngine::ingest`] +
//!   [`SignalEngine::merged_output`]，模拟摄取热路径的每包开销；双来源版本中
//!   每轮 256 个 Universe 换一个源 IP（两个 IP 交替）。
//! - `ingest_then_merged_bytes::{single_source, dual_source}`：同上，但读取改用
//!   [`SignalEngine::merged_bytes`]（单来源零拷贝零分配，多来源一次拷贝）。
//! - `ingest_then_merged::{single_source, dual_source}`：同上，但读取改用借用切片的
//!   [`SignalEngine::merged`]（零拷贝零分配）。
//! - `ingest_only::{single_source, dual_source}`：同上但只 `ingest`（含急切合并），
//!   用于从上面几项中拆出读取的成本。
//! - `snapshot_256`：256 个单来源 Universe 就绪后调用 [`SignalEngine::snapshot`]；
//!   每次迭代都是刚摄取完的新引擎（贴近“推送周期之间有新包到达”的真实情况）。
//! - `snapshot_256_cached`：同一引擎反复 `snapshot()`（优化前合并缓存全部命中；
//!   现已无合并缓存，保留该名以便对比）。
//! - `snapshot_64_dual`：64 个双来源 Universe 的 `snapshot()`（含惰性冲突计数）。
//! - `merge_two_sources`：直接调用公开的 [`merge`]，两个 512 字节来源，
//!   HTP / LTP / Priority 三种模式（含冲突计数）。
//! - `rate_tracker_apply::{in_window, window_elapsed}`：对 256 Universe 快照调用
//!   [`RateTracker::apply`]，分别为窗口内沿用旧速率与窗口结束重新计算两条分支。
//! - `source_stats_256`：256 个单来源 Universe 的 [`SignalEngine::source_stats`]。
//!
//! 运行：`cargo bench -p signal-engine --bench engine`。

use std::net::{IpAddr, Ipv4Addr};
use std::time::Instant;

use artnet_net::{DmxFrame, Protocol};
use bytes::Bytes;
use divan::counter::{BytesCount, ItemsCount};
use divan::{black_box, Bencher};
use signal_engine::{merge, MergeMode, RateTracker, SignalEngine, SourceView, RATE_WINDOW_MS};

/// 带分配计数的全局分配器：divan 据此在结果中报告每次迭代的分配次数与字节数。
#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

fn main() {
    divan::main();
}

/// 一帧 DMX 的通道数。
const CHANNELS: usize = 512;

/// 大规模场景的 Universe 数。
const UNIVERSES: u16 = 256;

/// 双来源快照场景的 Universe 数。
const DUAL_UNIVERSES: u16 = 64;

/// 源超时（毫秒），与宿主默认值同量级；基准期间不会触发剔除。
const TIMEOUT_MS: u64 = 2500;

/// 引擎合并模式（宿主默认 HTP）。
const MODE: MergeMode = MergeMode::Htp;

/// Art-Net 默认优先级（引擎对全部来源统一使用该值）。
const PRIORITY: u8 = 100;

/// 第 `source` 个来源的 IP（`10.0.0.1`、`10.0.0.2` ……）。
///
/// # Arguments
///
/// * `source` - 来源序号（从 0 起）。
///
/// # Returns
///
/// 该来源的 IPv4 地址。
fn source_ip(source: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(10, 0, 0, source + 1))
}

/// 生成某 Universe、某来源的确定性 512 通道数据（不同来源相位错开，制造合并冲突）。
///
/// # Arguments
///
/// * `universe` - Universe 编号。
/// * `source` - 来源序号。
///
/// # Returns
///
/// 512 字节通道数据。
fn channels(universe: u16, source: u8) -> Vec<u8> {
    let base = usize::from(universe) * 7 + usize::from(source) * 64;
    // cast_possible_truncation 已在 crate 级允许：取模后必然落在 u8 范围内。
    (0..CHANNELS).map(|ch| ((base + ch) % 256) as u8).collect()
}

/// 构造一帧 Art-Net DMX 帧。
///
/// # Arguments
///
/// * `universe` - Universe 编号。
/// * `source` - 来源序号（决定源 IP 与通道图案）。
///
/// # Returns
///
/// 可直接交给 [`SignalEngine::ingest`] 的帧。
fn frame(universe: u16, source: u8) -> DmxFrame {
    DmxFrame {
        protocol: Protocol::ArtNet,
        universe,
        data: Bytes::from(channels(universe, source)),
        source: Some(source_ip(source)),
        sequence: 0,
        received_at: Instant::now(),
    }
}

/// 生成一轮摄取的帧序列：来源 0 的 Universe `0..universes`，接着来源 1 的同一批 ……
///
/// 按下标 `i` 循环取帧时，Universe 恰为 `i % universes`，来源每轮交替。
///
/// # Arguments
///
/// * `universes` - Universe 数。
/// * `sources` - 每个 Universe 的来源数。
///
/// # Returns
///
/// 长度为 `universes * sources` 的帧序列。
fn frames(universes: u16, sources: u8) -> Vec<DmxFrame> {
    (0..sources)
        .flat_map(|s| (0..universes).map(move |u| frame(u, s)))
        .collect()
}

/// 构造一个已摄取完一轮数据（每个 Universe × 每个来源各一帧）的引擎。
///
/// # Arguments
///
/// * `universes` - Universe 数。
/// * `sources` - 每个 Universe 的来源数。
///
/// # Returns
///
/// 就绪的引擎（合并结果已在摄取时算好）。
fn engine_with(universes: u16, sources: u8) -> SignalEngine {
    let mut eng = SignalEngine::new(MODE, TIMEOUT_MS);
    for (now_ms, f) in (0u64..).zip(&frames(universes, sources)) {
        eng.ingest(f, now_ms);
    }
    eng
}

/// 摄取热路径的公共实现：每次迭代摄取一帧，再用 `read` 读取该 Universe 的合并结果。
///
/// `read` 的返回值交给 divan（在计时区外丢弃），与优化前直接返回
/// `merged_output` 结果的写法一致。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
/// * `sources` - 每个 Universe 的来源数（`1` 或 `2`）。
/// * `read` - 摄取后的读取方式（参数为引擎与刚摄取的 Universe 编号）。
fn bench_ingest<R>(bencher: Bencher, sources: u8, mut read: impl FnMut(&SignalEngine, u16) -> R) {
    let mut eng = engine_with(UNIVERSES, sources);
    let frames = frames(UNIVERSES, sources);
    let mut i = 0usize;
    // 逻辑时间从预热数据之后开始单调推进，保证不会触发超时剔除。
    let mut now_ms = 1_000_000u64;
    bencher.counter(BytesCount::new(CHANNELS)).bench_local(|| {
        let f = &frames[i];
        i = (i + 1) % frames.len();
        now_ms += 1;
        eng.ingest(black_box(f), now_ms);
        read(&eng, f.universe)
    });
}

/// 每包 `ingest` + `merged_output`（摄取热路径，读取分配一份 `Vec`）。
mod ingest_then_merged_output {
    use super::{bench_ingest, Bencher, SignalEngine};

    /// 256 Universe、单来源。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn single_source(bencher: Bencher) {
        bench_ingest(bencher, 1, SignalEngine::merged_output);
    }

    /// 256 Universe、每个 Universe 两个来源（两个 IP 交替）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn dual_source(bencher: Bencher) {
        bench_ingest(bencher, 2, SignalEngine::merged_output);
    }
}

/// 每包 `ingest` + `merged_bytes`（转发路径：取一份可共享所有权的数据）。
mod ingest_then_merged_bytes {
    use super::{bench_ingest, Bencher, SignalEngine};

    /// 256 Universe、单来源（来源 `Bytes` 引用计数克隆，零拷贝零分配）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn single_source(bencher: Bencher) {
        bench_ingest(bencher, 1, SignalEngine::merged_bytes);
    }

    /// 256 Universe、每个 Universe 两个来源（合并结果拷贝一次）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn dual_source(bencher: Bencher) {
        bench_ingest(bencher, 2, SignalEngine::merged_bytes);
    }
}

/// 每包 `ingest` + `merged`（借用切片，零拷贝零分配）。
mod ingest_then_merged {
    use super::{bench_ingest, black_box, Bencher};

    /// 256 Universe、单来源。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn single_source(bencher: Bencher) {
        bench_ingest(bencher, 1, |eng, u| {
            eng.merged(u).map(|d| black_box(d).len())
        });
    }

    /// 256 Universe、每个 Universe 两个来源。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn dual_source(bencher: Bencher) {
        bench_ingest(bencher, 2, |eng, u| {
            eng.merged(u).map(|d| black_box(d).len())
        });
    }
}

/// 每包仅 `ingest`（含急切合并；用于拆分摄取与读取成本）。
mod ingest_only {
    use super::{bench_ingest, Bencher};

    /// 256 Universe、单来源。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn single_source(bencher: Bencher) {
        bench_ingest(bencher, 1, |_, _| ());
    }

    /// 256 Universe、每个 Universe 两个来源（两个 IP 交替）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn dual_source(bencher: Bencher) {
        bench_ingest(bencher, 2, |_, _| ());
    }
}

/// 256 个单来源 Universe 的 `snapshot()`，每次迭代都使用刚摄取完的新引擎。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按 Universe 数计。
#[divan::bench]
fn snapshot_256(bencher: Bencher) {
    bencher
        .counter(ItemsCount::new(UNIVERSES))
        .with_inputs(|| engine_with(UNIVERSES, 1))
        .bench_local_refs(|eng| eng.snapshot());
}

/// 256 个单来源 Universe 的 `snapshot()`，同一引擎反复快照（优化前为合并缓存全部命中）。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按 Universe 数计。
#[divan::bench]
fn snapshot_256_cached(bencher: Bencher) {
    let eng = engine_with(UNIVERSES, 1);
    // 预热一次（优化前用于填满合并缓存；现实现无缓存，保留以与基线一致）。
    black_box(eng.snapshot());
    bencher
        .counter(ItemsCount::new(UNIVERSES))
        .bench_local(|| black_box(&eng).snapshot());
}

/// 64 个双来源 Universe 的 `snapshot()`，每次迭代都使用刚摄取完的新引擎。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按 Universe 数计。
#[divan::bench]
fn snapshot_64_dual(bencher: Bencher) {
    bencher
        .counter(ItemsCount::new(DUAL_UNIVERSES))
        .with_inputs(|| engine_with(DUAL_UNIVERSES, 2))
        .bench_local_refs(|eng| eng.snapshot());
}

/// 直接调用公开的 `merge`：两个 512 字节来源，按模式合并（含冲突计数）。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按两个来源的总字节数计。
/// * `mode` - 合并模式。
#[divan::bench(args = [MergeMode::Htp, MergeMode::Ltp, MergeMode::Priority])]
fn merge_two_sources(bencher: Bencher, mode: MergeMode) {
    let a = channels(0, 0);
    let b = channels(0, 1);
    let views = [
        SourceView {
            data: &a,
            priority: PRIORITY,
            last_seen_ms: 10,
            order: 1,
        },
        SourceView {
            data: &b,
            priority: PRIORITY,
            last_seen_ms: 11,
            order: 2,
        },
    ];
    bencher
        .counter(BytesCount::new(a.len() + b.len()))
        .bench_local(|| merge(black_box(&views), black_box(mode)));
}

/// 对 256 Universe 快照调用 `RateTracker::apply`（按宿主推送循环的真实用法构造）。
mod rate_tracker_apply {
    use super::{
        black_box, engine_with, Bencher, ItemsCount, RateTracker, RATE_WINDOW_MS, UNIVERSES,
    };

    /// 窗口内：只收集计数器并沿用上次速率（推送循环中最常见的分支）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按 Universe 数计。
    #[divan::bench]
    fn in_window(bencher: Bencher) {
        let eng = engine_with(UNIVERSES, 1);
        let mut snap = eng.snapshot();
        let total = eng.total_packets();
        let mut tracker = RateTracker::new();
        // 第一次调用只建立基线。
        tracker.apply(&mut snap, total, 0);
        let now_ms = RATE_WINDOW_MS / 2;
        bencher
            .counter(ItemsCount::new(UNIVERSES))
            .bench_local(|| tracker.apply(black_box(&mut snap), total, black_box(now_ms)));
    }

    /// 窗口结束：每次调用都满一个窗口，重新计算并替换全部速率表。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器；吞吐量按 Universe 数计。
    #[divan::bench]
    fn window_elapsed(bencher: Bencher) {
        let eng = engine_with(UNIVERSES, 1);
        let mut snap = eng.snapshot();
        let total = eng.total_packets();
        let mut tracker = RateTracker::new();
        tracker.apply(&mut snap, total, 0);
        let mut now_ms = 0u64;
        bencher.counter(ItemsCount::new(UNIVERSES)).bench_local(|| {
            now_ms += RATE_WINDOW_MS;
            tracker.apply(black_box(&mut snap), total, black_box(now_ms))
        });
    }
}

/// 256 个单来源 Universe 的 `source_stats()`（按源 IP 聚合）。
///
/// # Arguments
///
/// * `bencher` - divan 计时器；吞吐量按 Universe 数计。
#[divan::bench]
fn source_stats_256(bencher: Bencher) {
    let eng = engine_with(UNIVERSES, 1);
    bencher
        .counter(ItemsCount::new(UNIVERSES))
        .bench_local(|| black_box(&eng).source_stats());
}
