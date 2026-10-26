//! host-core 输出分发路由解析微基准（带分配计数）。
//!
//! 每次迭代模拟一个输出周期，对 256 个 Universe（每路 512 字节数据）各解析一次发送任务；
//! 周期间 `now_ms` 按 18~27 ms 的确定性抖动递增（均值约 22.5 ms ≈ 44Hz），
//! 使 44Hz 限速器（最小间隔 22 ms）既有放行也有丢弃（丢弃计入输出统计）。
//! 发送器槽位为空，解析本身不发送。转发表见 `common::routed_table`（8 个目的地）。
//!
//! - `plan::*`：兼容接口 `Dispatcher::plan(universe, &[u8], …) -> Vec<ForwardJob>`
//!   （有任务时拷贝一次数据、每次调用分配一个 `Vec`）；
//! - `plan_into::*`：热路径接口 `Dispatcher::plan_into(universe, Bytes, …, &mut out)`
//!   （数据以共享 `Bytes` 传入、输出缓冲复用，稳态零分配）。
//!
//! 每组三个场景：`rate_limited`（实时链路，开启限速）、`unlimited`（回放链路，不限速）、
//! `no_routes`（8 个目的地全部为 `selected` 且不含这 256 个 Universe，无路由快速返回）。
//!
//! 运行：`cargo bench -p host-core --bench dispatch`；冒烟：追加 `-- --sample-count 5`。

mod common;

use artnet_net::Bytes;
use divan::counter::ItemsCount;
use divan::{black_box, Bencher};
use forwarding::ForwardingTable;
use host_core::{DispatchTarget, Dispatcher, SenderSlot};

use common::{jitter_steps, universe_data, SEED, STEPS, UNIVERSES};

#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

fn main() {
    divan::main();
}

/// 由转发表构造分发器（发送器为空）。
///
/// # Arguments
///
/// * `table` - 转发表。
///
/// # Returns
///
/// 独立使用的 [`Dispatcher`]（sACN 默认开启）。
fn dispatcher(table: ForwardingTable) -> Dispatcher {
    Dispatcher::with_table(table, SenderSlot::default())
}

/// 在计时区内逐周期对 256 个 Universe 调用 `plan`。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
/// * `table` - 转发表。
/// * `rate_limited` - 是否应用 44Hz 限速。
fn run_plan(bencher: Bencher, table: ForwardingTable, rate_limited: bool) {
    let d = dispatcher(table);
    let data = universe_data(SEED);
    let steps = jitter_steps();
    let target = DispatchTarget::Forwarding;
    let mut now_ms = 0u64;
    let mut k = 0usize;
    bencher.counter(ItemsCount::new(UNIVERSES)).bench_local(|| {
        now_ms += steps[k % STEPS];
        k += 1;
        let mut jobs = 0usize;
        for (u, buf) in (0..UNIVERSES).zip(&data) {
            let out = d.plan(u, black_box(buf), now_ms, &target, rate_limited);
            jobs += out.len();
            black_box(out);
        }
        jobs
    });
}

/// 在计时区内逐周期对 256 个 Universe 调用 `plan_into`（输出缓冲每周期清空复用）。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
/// * `table` - 转发表。
/// * `rate_limited` - 是否应用 44Hz 限速。
fn run_plan_into(bencher: Bencher, table: ForwardingTable, rate_limited: bool) {
    let d = dispatcher(table);
    let data: Vec<Bytes> = universe_data(SEED).into_iter().map(Bytes::from).collect();
    let steps = jitter_steps();
    let target = DispatchTarget::Forwarding;
    let mut now_ms = 0u64;
    let mut k = 0usize;
    let mut out = Vec::new();
    bencher.counter(ItemsCount::new(UNIVERSES)).bench_local(|| {
        now_ms += steps[k % STEPS];
        k += 1;
        out.clear();
        for (u, buf) in (0..UNIVERSES).zip(&data) {
            d.plan_into(
                u,
                black_box(buf.clone()),
                now_ms,
                &target,
                rate_limited,
                &mut out,
            );
        }
        black_box(&out);
        out.len()
    });
}

/// 兼容接口：解析 256 个 Universe 的发送任务（每次迭代一个输出周期）。
#[divan::bench_group]
mod plan {
    use divan::Bencher;

    use super::common::{routed_table, unrouted_table};
    use super::run_plan;

    /// 实时链路：开启 44Hz 限速（部分帧被丢弃并计入统计）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn rate_limited(bencher: Bencher) {
        run_plan(bencher, routed_table(), true);
    }

    /// 回放链路：不限速。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn unlimited(bencher: Bencher) {
        run_plan(bencher, routed_table(), false);
    }

    /// 该 Universe 没有任何路由（全部目的地为 `selected` 且不含它）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn no_routes(bencher: Bencher) {
        run_plan(bencher, unrouted_table(), true);
    }
}

/// 热路径接口：共享 `Bytes` 负载 + 复用输出缓冲。
#[divan::bench_group]
mod plan_into {
    use divan::Bencher;

    use super::common::{routed_table, unrouted_table};
    use super::run_plan_into;

    /// 实时链路：开启 44Hz 限速。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn rate_limited(bencher: Bencher) {
        run_plan_into(bencher, routed_table(), true);
    }

    /// 回放链路：不限速。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn unlimited(bencher: Bencher) {
        run_plan_into(bencher, routed_table(), false);
    }

    /// 无任何路由。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn no_routes(bencher: Bencher) {
        run_plan_into(bencher, unrouted_table(), true);
    }
}
