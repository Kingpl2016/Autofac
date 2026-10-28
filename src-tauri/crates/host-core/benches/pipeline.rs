//! host-core 实时摄取流水线微基准（带分配计数）：`IngestPipeline::process_batch`。
//!
//! 每次迭代模拟一个输出周期：256 个 Universe（每路 512 字节）× N 个来源的帧，按
//! `IngestPipeline::run` 的批大小（256 帧）切批后逐批 `process_batch`（丢弃判定 → 旁路 →
//! 整批一次引擎锁摄取 → 解析路由与限速），生成的发送任务写入复用的缓冲、不发送。
//! 周期间逻辑时间按 18~27 ms 抖动递增（≈44Hz），帧的 `received_at` 每周期更新。
//! 帧本身（含数据缓冲）在计时区外预先构造并逐周期复用，因此分配计数只含流水线本身。
//!
//! - `pipeline::single_source`：1 个来源、8 个目的地（`common::routed_table`），每周期 1 批；
//!   单来源合并结果零拷贝，稳态目标 0 次分配；
//! - `pipeline::dual_source`：2 个来源（HTP 合并），每周期 2 批；多来源合并结果每帧拷贝一次；
//! - `pipeline::no_routes`：1 个来源，全部 Universe 都没有路由（`common::unrouted_table`），
//!   目标每帧 0 次分配。
//!
//! 运行：`cargo bench -p host-core --bench pipeline`；冒烟：追加 `-- --sample-count 5`。

mod common;

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use artnet_net::{Bytes, DmxFrame, Protocol};
use divan::counter::ItemsCount;
use parking_lot::Mutex;
use divan::{black_box, Bencher};
use forwarding::ForwardingTable;
use host_core::ingest::BATCH_LIMIT;
use host_core::mode::{FrameFanout, RuntimeMode};
use host_core::{Dispatcher, IngestPipeline, SenderSlot};
use signal_engine::{MergeMode, SignalEngine};

use common::{jitter_steps, universe_data, SEED, STEPS, UNIVERSES};

#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

fn main() {
    divan::main();
}

/// 构造流水线与一个周期的帧（按 Universe 交错排列各来源的帧）。
///
/// # Arguments
///
/// * `table` - 转发表。
/// * `sources` - 来源个数（1 或 2）。
///
/// # Returns
///
/// `(流水线, 一个周期的帧, 运行时起点)`。
fn fixture(table: ForwardingTable, sources: u8) -> (IngestPipeline, Vec<DmxFrame>, Instant) {
    let start = Instant::now();
    let engine = Arc::new(Mutex::new(SignalEngine::new(MergeMode::Htp, 60_000)));
    let dispatcher = Dispatcher::with_table(table, SenderSlot::default());
    let pipeline = IngestPipeline::new(
        engine,
        dispatcher,
        FrameFanout::new(),
        Arc::new(RuntimeMode::new()),
        start,
    );
    let data: Vec<Vec<Bytes>> = (0..sources)
        .map(|s| {
            universe_data(SEED ^ (u64::from(s) * 0x1234_5678))
                .into_iter()
                .map(Bytes::from)
                .collect()
        })
        .collect();
    let mut frames = Vec::with_capacity(usize::from(UNIVERSES) * usize::from(sources));
    for u in 0..UNIVERSES {
        for (s, per_source) in data.iter().enumerate() {
            frames.push(DmxFrame {
                protocol: Protocol::ArtNet,
                universe: u,
                data: per_source[usize::from(u)].clone(),
                source: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1 + s as u8))),
                sequence: 0,
                received_at: start,
            });
        }
    }
    (pipeline, frames, start)
}

/// 在计时区内逐周期处理一个周期的帧（切成 [`BATCH_LIMIT`] 帧一批）。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
/// * `table` - 转发表。
/// * `sources` - 来源个数。
fn run(bencher: Bencher, table: ForwardingTable, sources: u8) {
    let (pipeline, mut frames, start) = fixture(table, sources);
    let steps = jitter_steps();
    let mut now_ms = 0u64;
    let mut k = 0usize;
    let mut jobs = Vec::new();
    bencher
        .counter(ItemsCount::new(frames.len()))
        .bench_local(|| {
            now_ms += steps[k % STEPS];
            k += 1;
            let at = start + Duration::from_millis(now_ms);
            for f in &mut frames {
                f.received_at = at;
            }
            jobs.clear();
            for batch in frames.chunks(BATCH_LIMIT) {
                pipeline.process_batch(black_box(batch), &mut jobs);
            }
            black_box(&jobs);
            jobs.len()
        });
}

/// 摄取流水线：每次迭代一个输出周期（256 Universe × 来源数 帧）。
#[divan::bench_group]
mod pipeline {
    use divan::Bencher;

    use super::common::{routed_table, unrouted_table};
    use super::run;

    /// 单来源、8 个目的地（每周期 1 批 256 帧）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn single_source(bencher: Bencher) {
        run(bencher, routed_table(), 1);
    }

    /// 双来源 HTP 合并、8 个目的地（每周期 2 批，共 512 帧）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn dual_source(bencher: Bencher) {
        run(bencher, routed_table(), 2);
    }

    /// 单来源、全部 Universe 都没有路由（每周期 1 批 256 帧）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn no_routes(bencher: Bencher) {
        run(bencher, unrouted_table(), 1);
    }
}
