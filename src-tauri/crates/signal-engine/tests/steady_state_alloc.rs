//! 稳态热路径分配次数验证：用按线程计数的全局分配器统计摄取 + 读取路径的堆分配。
//!
//! 基准里新建的帧 `Bytes`（`Bytes::from(Vec)`）第一次被克隆时会提升为共享表示并分配
//! 24 B，这里预先克隆一次消除该一次性开销，只度量引擎自身的稳态分配。计数只针对当前
//! 线程，避免测试框架其它线程的干扰。

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::hint::black_box;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Instant;

use artnet_net::{Bytes, DmxFrame, Protocol};
use signal_engine::{MergeMode, RateTracker, SignalEngine, RATE_WINDOW_MS};

/// 统计当前线程分配次数的全局分配器（实际分配委托给 [`System`]）。
struct CountingAlloc;

thread_local! {
    /// 当前线程累计的分配次数（含 `realloc`）。
    static ALLOCS: Cell<usize> = const { Cell::new(0) };
}

/// 当前线程分配计数加一（线程销毁阶段取不到 TLS 时忽略）。
fn bump() {
    let _ = ALLOCS.try_with(|c| c.set(c.get() + 1));
}

// SAFETY: 全部操作原样委托给 `System`，只额外维护一个线程局部计数器（const 初始化，不分配）。
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        bump();
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        bump();
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        bump();
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

/// 统计执行 `f` 期间当前线程的分配次数。
fn allocs_during(f: impl FnOnce()) -> usize {
    let before = ALLOCS.with(Cell::get);
    f();
    ALLOCS.with(Cell::get) - before
}

/// 256 个 Universe × `sources` 个来源的 512 通道帧（来源相位错开，制造合并冲突）。
fn frames(sources: u8) -> Vec<DmxFrame> {
    (0..sources)
        .flat_map(|s| {
            (0..256u16).map(move |u| {
                let base = usize::from(u) * 7 + usize::from(s) * 64;
                let data: Vec<u8> = (0..512).map(|ch| ((base + ch) % 256) as u8).collect();
                DmxFrame {
                    protocol: Protocol::ArtNet,
                    universe: u,
                    data: Bytes::from(data),
                    source: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, s + 1))),
                    sequence: 0,
                    received_at: Instant::now(),
                }
            })
        })
        .collect()
}

#[test]
fn hot_paths_do_not_allocate_in_steady_state() {
    for sources in [1u8, 2] {
        let frames = frames(sources);
        // 预先克隆一次，消除 `Bytes` 首次克隆时的一次性提升分配
        for f in &frames {
            drop(f.data.clone());
        }
        let mut eng = SignalEngine::new(MergeMode::Htp, u64::MAX);
        let mut now_ms = 0u64;
        // 预热：每个 Universe × 来源各摄取一次，建立来源表
        for f in &frames {
            now_ms += 1;
            eng.ingest(f, now_ms);
        }
        let mut out = [0u8; 512];
        for mode in [MergeMode::Htp, MergeMode::Ltp, MergeMode::Priority] {
            let n = allocs_during(|| eng.set_mode(mode));
            assert_eq!(n, 0, "set_mode 重算不应分配");

            let n = allocs_during(|| {
                for f in &frames {
                    now_ms += 1;
                    eng.ingest(f, now_ms);
                    black_box(eng.merged(f.universe));
                    black_box(eng.merged_into(f.universe, &mut out));
                    black_box(eng.data_gen(f.universe));
                }
            });
            assert_eq!(
                n, 0,
                "{sources} 来源 / {mode:?}：ingest + merged 稳态应零分配"
            );

            let n = allocs_during(|| {
                for f in &frames {
                    now_ms += 1;
                    eng.ingest(f, now_ms);
                    black_box(eng.merged_bytes(f.universe));
                }
            });
            // 单来源直接克隆来源 `Bytes`（零分配）；多来源每次拷贝合并结果一次
            let expected = if sources == 1 { 0 } else { frames.len() };
            assert_eq!(
                n, expected,
                "{sources} 来源 / {mode:?}：merged_bytes 分配次数"
            );
        }

        // 速率追踪：窗口内零分配；窗口结束在表容量就绪后也零分配
        let mut snap = eng.snapshot();
        let total = eng.total_packets();
        let mut tracker = RateTracker::new();
        tracker.apply(&mut snap, total, 0);
        tracker.apply(&mut snap, total, RATE_WINDOW_MS);
        tracker.apply(&mut snap, total, 2 * RATE_WINDOW_MS);
        let n = allocs_during(|| {
            black_box(tracker.apply(&mut snap, total, 2 * RATE_WINDOW_MS + 10));
        });
        assert_eq!(n, 0, "RateTracker 窗口内不应分配");
        let n = allocs_during(|| {
            black_box(tracker.apply(&mut snap, total, 3 * RATE_WINDOW_MS));
        });
        assert_eq!(n, 0, "RateTracker 窗口结束（表容量已就绪）不应分配");
    }
}
