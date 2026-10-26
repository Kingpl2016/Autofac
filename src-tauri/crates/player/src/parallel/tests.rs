//! 一致性测试：参照实现（改动前原样副本）== 新串行实现 == 各种分段的并行实现。

use std::collections::BTreeSet;
use std::path::Path;

use artrec_core::{ArtRecReader, CompressAlgo};

use super::{overview_with, plan_overview, plan_series, scan_pool, series_with, Tuning};
use crate::overview::Overview;
use crate::reference;
use crate::series::{ChannelSeries, SeriesError, SeriesQuery};
use crate::testgen::{generate, Kind, Spec, TempFile, XorShift};
use crate::walker::FrameWalker;
use crate::{
    build_overview, build_overview_parallel, channel_series, channel_series_parallel, ScanError,
    PARALLEL_MIN_FRAMES,
};

/// debug 下缩小用例规模；release 下自动放大。
const SCALE: usize = if cfg!(debug_assertions) { 1 } else { 4 };

/// 强制走并行路径（不设帧数阈值）并指定分段数。
fn forced(segments: usize) -> Tuning {
    Tuning {
        min_frames: 0,
        segments: Some(segments),
    }
}

/// 覆盖"1 段 / 少量段 / 线程数附近 / 远多于线程 / 不少于帧数"的分段选择。
fn segment_choices(frames: usize) -> Vec<usize> {
    let mut v = vec![1, 2, 3, 4, 7, 16, 45, frames, frames + 3];
    v.sort_unstable();
    v.dedup();
    v
}

/// 指出两份概览第一个不同之处（断言失败时便于定位）。
fn describe_overview_diff(got: &Overview, want: &Overview) -> String {
    for (name, g, w) in [
        ("change", &got.change, &want.change),
        ("level", &got.level, &want.level),
    ] {
        if g.len() != w.len() {
            return format!("{name} 行数不同：{} vs {}", g.len(), w.len());
        }
        for (u, (gr, wr)) in g.iter().zip(w).enumerate() {
            if let Some(b) = gr.iter().zip(wr).position(|(x, y)| x != y) {
                return format!("{name}[{u}][{b}] = {} ，期望 {}", gr[b], wr[b]);
            }
        }
    }
    format!(
        "标量字段不同：frames {}/{} skipped {}/{} bytes {}/{} buckets {}/{}",
        got.frames,
        want.frames,
        got.skipped_frames,
        want.skipped_frames,
        got.file_bytes,
        want.file_bytes,
        got.buckets,
        want.buckets
    )
}

fn assert_overview_eq(got: &Overview, want: &Overview, ctx: &str) {
    assert!(got == want, "{ctx}: {}", describe_overview_diff(got, want));
    // serde 表示（Base64 行）也必须逐字节相同
    assert_eq!(
        serde_json::to_string(got).unwrap(),
        serde_json::to_string(want).unwrap(),
        "{ctx}"
    );
}

/// 对一个节目核对概览：参照 == 新串行 == 各分段并行 == 默认参数的公开并行入口。
fn check_overview(bytes: &[u8], buckets: u32, ctx: &str) -> Overview {
    let mem = ArtRecReader::open(bytes.to_vec()).unwrap();
    let want = reference::build_overview(&mem, buckets);
    assert_overview_eq(
        &build_overview(&mem, buckets),
        &want,
        &format!("{ctx} 新串行"),
    );

    let file = TempFile::new(bytes);
    let disk = ArtRecReader::open_file(file.path()).unwrap();
    assert_overview_eq(
        &build_overview(&disk, buckets),
        &want,
        &format!("{ctx} 磁盘串行"),
    );
    for p in segment_choices(mem.index().len()) {
        let got = overview_with(&disk, file.path(), buckets, &forced(p)).unwrap();
        assert_overview_eq(&got, &want, &format!("{ctx} 并行 {p} 段"));
    }
    let got = build_overview_parallel(&disk, file.path(), buckets).unwrap();
    assert_overview_eq(&got, &want, &format!("{ctx} 公开并行"));
    // 内存读取器 + 路径也可用（reader 只提供头与索引）
    let got = overview_with(&mem, file.path(), buckets, &forced(5)).unwrap();
    assert_overview_eq(&got, &want, &format!("{ctx} 内存 reader 并行"));
    want
}

/// 一次曲线查询的参数。
#[derive(Debug, Clone)]
struct Query {
    universe: u16,
    channels: Vec<u16>,
    t0: u64,
    t1: u64,
    max_points: u32,
}

fn random_query(rng: &mut XorShift, r: &ArtRecReader) -> Query {
    let unis = r.unis();
    let idx = r.index();
    let (universe, dmx_len) = if unis.is_empty() || rng.chance(4) {
        (4095, 512) // 不存在的 Universe
    } else {
        let u = rng.pick(unis);
        (u.universe, u64::from(u.dmx_len))
    };
    let nch = match rng.below(25) {
        0 => 0,
        1 => 17, // 超过上限
        _ => rng.range(1, 16),
    };
    let channels = (0..nch)
        .map(|_| {
            if rng.chance(10) {
                rng.range(dmx_len, dmx_len + 100) as u16 // 超出 dmx_len：忽略
            } else {
                rng.below(dmx_len.max(1)) as u16
            }
        })
        .collect();
    let last = idx.last().map_or(0, |f| f.time_us);
    let end = last + 1_000_000;
    let frame_time = |rng: &mut XorShift| {
        if idx.is_empty() {
            0
        } else {
            idx[rng.below(idx.len() as u64) as usize].time_us
        }
    };
    let (t0, t1) = match rng.below(10) {
        0 => (0, end),
        1 => (rng.below(end), rng.below(end)), // 可能 t1 < t0
        2 => {
            let t = rng.below(end);
            (t, t)
        }
        3 => (idx.first().map_or(0, |f| f.time_us), last),
        4 | 5 => {
            // 端点恰为帧时间（区间起点帧、终点帧的边界）
            let a = frame_time(rng);
            let b = frame_time(rng);
            (a.min(b), a.max(b))
        }
        _ => {
            let a = rng.below(end);
            (a, a + rng.below(end))
        }
    };
    let max_points = match rng.below(12) {
        0 => 0,
        1 => 1,
        2 => 2,
        3 => 3,
        4 => 4096,
        5 => 5000,
        6 => 1200,
        7 => 64,
        _ => rng.range(2, 400) as u32,
    };
    Query {
        universe,
        channels,
        t0,
        t1,
        max_points,
    }
}

/// 对一个节目核对若干次曲线查询。
fn check_series(bytes: &[u8], queries: &[Query], ctx: &str) {
    let mem = ArtRecReader::open(bytes.to_vec()).unwrap();
    let file = TempFile::new(bytes);
    let disk = ArtRecReader::open_file(file.path()).unwrap();
    for q in queries {
        let ctx = format!("{ctx} {q:?}");
        let want: Result<Vec<ChannelSeries>, SeriesError> =
            reference::channel_series(&mem, q.universe, &q.channels, q.t0, q.t1, q.max_points);
        let serial = channel_series(&mem, q.universe, &q.channels, q.t0, q.t1, q.max_points);
        assert_eq!(serial, want, "{ctx} 新串行");

        let public = channel_series_parallel(
            &disk,
            file.path(),
            q.universe,
            &q.channels,
            q.t0,
            q.t1,
            q.max_points,
        );
        match (&public, &want) {
            (Ok(g), Ok(w)) => assert_eq!(g, w, "{ctx} 公开并行"),
            (Err(ScanError::Series(g)), Err(w)) => assert_eq!(g, w, "{ctx} 公开并行错误"),
            _ => panic!("{ctx} 公开并行结果类型不符: {public:?} vs {want:?}"),
        }
        let Ok(want) = want else {
            continue;
        };
        let pq =
            SeriesQuery::new(&disk, q.universe, &q.channels, q.t0, q.t1, q.max_points).unwrap();
        for p in segment_choices(pq.n) {
            let got = series_with(&disk, file.path(), &pq, &forced(p)).unwrap();
            assert_eq!(got, want, "{ctx} 并行 {p} 段");
        }
    }
}

/// 段边界附近（±1）与跨越整段的连续损坏帧。
fn boundary_damage(rng: &mut XorShift, frames: usize) -> Vec<usize> {
    let mut out = BTreeSet::new();
    if frames == 0 {
        return Vec::new();
    }
    for p in [2usize, 3, 4, 7, 16, 45] {
        for s in 1..p {
            let a = s * frames / p;
            if rng.chance(35) {
                for d in [a.saturating_sub(1), a, a + 1] {
                    if rng.chance(60) {
                        out.insert(d);
                    }
                }
            }
        }
    }
    // 首帧、开头连续若干帧
    if rng.chance(50) {
        out.insert(0);
    }
    if rng.chance(30) {
        out.extend(0..rng.range(1, (frames as u64 / 3).max(1)) as usize);
    }
    // 跨越多个段的长串损坏
    if rng.chance(50) {
        let start = rng.below(frames as u64) as usize;
        let len = rng.range(1, (frames as u64 / 2).max(1)) as usize;
        out.extend(start..(start + len).min(frames));
    }
    // 末帧
    if rng.chance(30) {
        out.insert(frames - 1);
    }
    out.into_iter().filter(|&i| i < frames).collect()
}

/// 生成一批规格各异的随机节目。
fn random_specs(seed: u64, count: usize) -> Vec<Spec> {
    let mut rng = XorShift::new(seed);
    (0..count)
        .map(|i| {
            let unis = rng.pick(&[1usize, 1, 8, 8, 64]);
            // 64 路时控制帧数，避免 debug 下过慢
            let cap = if unis == 64 { 160 * SCALE } else { 700 * SCALE };
            let frames = match rng.below(10) {
                0 => rng.pick(&[0usize, 1, 2, 3]),
                1 | 2 => rng.range(4, 40) as usize,
                _ => rng.range(40, cap as u64) as usize,
            };
            let mut spec = Spec::new(seed.wrapping_mul(1000) + i as u64, unis, frames);
            spec.algo = if rng.chance(35) {
                CompressAlgo::Zstd
            } else {
                CompressAlgo::None
            };
            spec.kind = match rng.below(10) {
                0 => Kind::Diff,
                1 => Kind::StrayDiff,
                _ => Kind::Full,
            };
            spec.short_lens = rng.chance(40);
            spec.corrupt_pct = rng.pick(&[0u64, 0, 1, 3, 10, 40, 100]);
            spec.corrupt = boundary_damage(&mut rng, frames);
            spec
        })
        .collect()
}

#[test]
fn overview_parallel_and_serial_match_reference_on_random_programs() {
    let mut rng = XorShift::new(0x0E5E_0001);
    for spec in random_specs(1, 40) {
        let prog = generate(&spec);
        let odd = rng.range(16, 300) as u32;
        let buckets = rng.pick(&[0u32, 16, 17, 100, 1024, 4096, 9999, odd]);
        let ctx = format!("{spec:?} buckets={buckets}");
        let o = check_overview(&prog.bytes, buckets, &ctx);
        if spec.algo == CompressAlgo::None && spec.kind == Kind::Full && prog.damaged.is_empty() {
            assert_eq!(o.skipped_frames, 0, "{ctx}");
        }
    }
}

#[test]
fn overview_handles_degenerate_programs() {
    // 0 帧 / 1 帧 / 全部损坏 / 只有首帧损坏 / 同一时间戳的大量帧 / 0 路 Universe
    let mut cases: Vec<Spec> = Vec::new();
    for (unis, frames) in [(1, 0), (8, 0), (1, 1), (64, 1), (8, 2), (0, 30), (1, 300)] {
        cases.push(Spec::new(unis as u64 * 31 + frames as u64, unis, frames));
    }
    let mut all_bad = Spec::new(77, 8, 200);
    all_bad.corrupt_pct = 100;
    cases.push(all_bad);
    let mut first_bad = Spec::new(78, 8, 200);
    first_bad.corrupt = vec![0];
    cases.push(first_bad);
    let mut head_bad = Spec::new(79, 1, 200);
    head_bad.corrupt = (0..150).collect();
    cases.push(head_bad);
    let mut tail_bad = Spec::new(80, 1, 200);
    tail_bad.corrupt = (60..200).collect();
    cases.push(tail_bad);
    for spec in cases {
        let prog = generate(&spec);
        for buckets in [16u32, 1024] {
            check_overview(&prog.bytes, buckets, &format!("{spec:?} buckets={buckets}"));
        }
    }
}

#[test]
fn overview_with_many_frames_per_timestamp_and_zero_duration() {
    use std::io::Cursor;

    use artrec_core::{ArtRecWriter, UniDesc};
    // 手工构造：所有帧同一时间戳（含首帧不在 0）、总时长为 0 / 短于帧时间
    for (times, total) in [
        (vec![5_000u64; 50], 0u64),
        (vec![5_000u64; 50], 10_000),
        ((0..60).map(|i| 1_000 + i / 7 * 3).collect::<Vec<_>>(), 50),
    ] {
        let unis = vec![
            UniDesc::from_universe(3, 512).unwrap(),
            UniDesc::from_universe(9, 7).unwrap(),
        ];
        let mut w =
            ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::None, 0, 0, 0).unwrap();
        for (i, &t) in times.iter().enumerate() {
            let a: Vec<u8> = (0..512).map(|c| ((c * 3 + i * 11) % 256) as u8).collect();
            let b: Vec<u8> = (0..7).map(|c| ((c + i) % 3) as u8 * 100).collect();
            w.add_full_frame(t, &[a, b]).unwrap();
        }
        let bytes = w.finish(total).unwrap().into_inner();
        check_overview(&bytes, 16, &format!("times={times:?} total={total}"));
    }
}

#[test]
fn overview_default_tuning_runs_parallel_above_threshold() {
    let frames = PARALLEL_MIN_FRAMES + 137;
    let mut spec = Spec::new(0xBEEF, 1, frames);
    spec.corrupt_pct = 2;
    let prog = generate(&spec);
    let mem = ArtRecReader::open(prog.bytes.clone()).unwrap();
    if scan_pool().is_some_and(|p| p.current_num_threads() >= 2) {
        assert!(
            plan_overview(&mem, &Tuning::DEFAULT).is_some(),
            "超过阈值应走并行"
        );
    }
    check_overview(&prog.bytes, 1024, "default");
    // 低于阈值：走串行
    let small = generate(&Spec::new(1, 1, PARALLEL_MIN_FRAMES - 1));
    let small = ArtRecReader::open(small.bytes).unwrap();
    assert!(plan_overview(&small, &Tuning::DEFAULT).is_none());
}

#[test]
fn diff_programs_fall_back_to_serial() {
    let mut spec = Spec::new(0xD1FF, 8, 300);
    spec.kind = Kind::Diff;
    spec.corrupt_pct = 5;
    let prog = generate(&spec);
    let mem = ArtRecReader::open(prog.bytes.clone()).unwrap();
    assert!(mem.header().allows_diff());
    assert!(
        plan_overview(&mem, &forced(4)).is_none(),
        "允许差分的文件不应并行"
    );
    let q = SeriesQuery::new(
        &mem,
        mem.unis()[0].universe,
        &[0, 1, 2],
        0,
        u64::MAX / 4,
        300,
    )
    .unwrap();
    assert!(plan_series(&mem, &q, &forced(4)).is_none());
    check_overview(&prog.bytes, 256, "diff");
    let mut rng = XorShift::new(9);
    let queries: Vec<Query> = (0..20).map(|_| random_query(&mut rng, &mem)).collect();
    check_series(&prog.bytes, &queries, "diff");
}

#[test]
fn series_parallel_and_serial_match_reference_on_random_programs() {
    let mut rng = XorShift::new(0x005E_21E5);
    for spec in random_specs(2, 30) {
        let prog = generate(&spec);
        let mem = ArtRecReader::open(prog.bytes.clone()).unwrap();
        let queries: Vec<Query> = (0..12).map(|_| random_query(&mut rng, &mem)).collect();
        check_series(&prog.bytes, &queries, &format!("{spec:?}"));
    }
}

#[test]
fn series_default_tuning_runs_parallel_above_threshold() {
    let frames = PARALLEL_MIN_FRAMES * 2;
    let mut spec = Spec::new(0x5EED, 1, frames);
    spec.corrupt = boundary_damage(&mut XorShift::new(4), frames);
    let prog = generate(&spec);
    let mem = ArtRecReader::open(prog.bytes.clone()).unwrap();
    let u = mem.unis()[0].universe;
    let last = mem.index().last().unwrap().time_us;
    let q = SeriesQuery::new(&mem, u, &[0, 5, 511], 0, last, 1200).unwrap();
    if scan_pool().is_some_and(|p| p.current_num_threads() >= 2) {
        assert!(
            plan_series(&mem, &q, &Tuning::DEFAULT).is_some(),
            "超过阈值应走并行"
        );
    }
    let queries = vec![
        Query {
            universe: u,
            channels: vec![0, 5, 511],
            t0: 0,
            t1: last,
            max_points: 1200,
        },
        Query {
            universe: u,
            channels: (0..16).collect(),
            t0: mem.index()[17].time_us,
            t1: last + 10,
            max_points: 4096,
        },
    ];
    check_series(&prog.bytes, &queries, "default");
}

#[test]
fn series_start_frame_corruption_and_boundary_frames() {
    // 区间起点帧损坏时串行从全零开始（不回看更早的帧），并行必须复现这一点
    let mut spec = Spec::new(0xC0DE, 8, 400);
    spec.corrupt = vec![
        0, 100, 101, 199, 200, 201, 250, 251, 252, 253, 254, 255, 399,
    ];
    let prog = generate(&spec);
    let mem = ArtRecReader::open(prog.bytes.clone()).unwrap();
    let idx = mem.index();
    let mut queries = Vec::new();
    for &k in &[0usize, 1, 100, 101, 102, 200, 252, 255, 256, 398, 399] {
        for &u in &[0usize, 3, 7] {
            let uni = mem.unis()[u];
            queries.push(Query {
                universe: uni.universe,
                channels: vec![0, 1, 7, 100, 511],
                t0: idx[k].time_us,
                t1: idx[(k + 150).min(idx.len() - 1)].time_us,
                max_points: 37,
            });
            queries.push(Query {
                universe: uni.universe,
                channels: vec![2],
                t0: idx[k].time_us.saturating_sub(1),
                t1: idx[k].time_us + 1,
                max_points: 2,
            });
        }
    }
    check_series(&prog.bytes, &queries, "start-corruption");
}

#[test]
fn walker_matches_reference_walker() {
    let mut rng = XorShift::new(0x3A1C);
    for spec in random_specs(3, 25) {
        let prog = generate(&spec);
        let reader = ArtRecReader::open(prog.bytes).unwrap();
        let frames = reader.index().len();
        let starts = [
            0usize,
            1,
            frames / 2,
            frames.saturating_sub(1),
            frames,
            frames + 5,
            rng.below(frames as u64 + 1) as usize,
        ];
        for start in starts {
            let mut new = FrameWalker::from_frame(&reader, start);
            let mut old = reference::RefWalker::from_frame(&reader, start);
            assert_eq!(new.peek_time(), old.peek_time());
            assert_eq!(new.buffers(), old.buffers(), "{spec:?} start={start}");
            loop {
                let (t_new, t_old) = (new.advance(), old.advance());
                assert_eq!(t_new, t_old);
                assert_eq!(new.buffers(), old.buffers(), "{spec:?} start={start}");
                assert_eq!(new.skipped(), old.skipped());
                if t_new.is_none() {
                    break;
                }
            }
        }
    }
}

#[test]
fn scan_pool_is_dedicated_and_named() {
    let pool = scan_pool().expect("测试环境应能创建线程池");
    let avail = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    assert_eq!(pool.current_num_threads(), avail.saturating_sub(1).max(1));
    let name = pool.install(|| std::thread::current().name().map(str::to_owned));
    let name = name.expect("工作线程应有名字");
    assert!(name.starts_with("artrec-scan-"), "{name}");
    assert!(std::ptr::eq(pool, scan_pool().unwrap()), "线程池只创建一次");
}

#[test]
fn errors_are_reported_and_validation_comes_first() {
    let prog = generate(&Spec::new(5, 2, 50));
    let file = TempFile::new(&prog.bytes);
    let disk = ArtRecReader::open_file(file.path()).unwrap();
    let missing = file.path().with_extension("missing");
    assert!(matches!(
        build_overview_parallel(&disk, &missing, 64),
        Err(ScanError::Open(_))
    ));
    // 长度不一致：不是同一份文件
    let other = TempFile::new(&generate(&Spec::new(6, 3, 10)).bytes);
    assert!(matches!(
        build_overview_parallel(&disk, other.path(), 64),
        Err(ScanError::Reader(
            artrec_core::ArtRecError::SourceLenMismatch { .. }
        ))
    ));
    let u = disk.unis()[0].universe;
    assert!(matches!(
        channel_series_parallel(&disk, &missing, u, &[0], 0, 10, 4),
        Err(ScanError::Open(_))
    ));
    // 参数校验先于文件操作
    let many: Vec<u16> = (0..17).collect();
    assert!(matches!(
        channel_series_parallel(&disk, &missing, u, &many, 0, 10, 4),
        Err(ScanError::Series(SeriesError::TooManyChannels))
    ));
    assert!(matches!(
        channel_series_parallel(&disk, Path::new("nope"), 4095, &[0], 0, 10, 4),
        Err(ScanError::Series(SeriesError::UnknownUniverse(4095)))
    ));
}

/// 大文件一致性（release 下手动运行：`cargo test -p player --release -- --ignored`）。
#[test]
#[ignore = "大文件用例，debug 下过慢；release 下用 --ignored 运行"]
fn large_programs_match_reference() {
    let mut specs = Vec::new();
    let mut s = Spec::new(0xB16, 64, 6000);
    s.algo = CompressAlgo::Zstd;
    s.corrupt_pct = 1;
    s.corrupt = boundary_damage(&mut XorShift::new(1), 6000);
    specs.push(s);
    let mut s = Spec::new(0xB17, 8, 20_000);
    s.short_lens = true;
    s.kind = Kind::StrayDiff;
    s.corrupt = boundary_damage(&mut XorShift::new(2), 20_000);
    specs.push(s);
    let mut s = Spec::new(0xB18, 64, 3000);
    s.corrupt_pct = 100;
    specs.push(s);
    let mut s = Spec::new(0xB19, 1, 50_000);
    s.corrupt = (10_000..30_000).collect();
    specs.push(s);
    let mut rng = XorShift::new(0xB1);
    for spec in specs {
        let prog = generate(&spec);
        for buckets in [16u32, 1024, 4096] {
            check_overview(&prog.bytes, buckets, &format!("{spec:?} buckets={buckets}"));
        }
        let mem = ArtRecReader::open(prog.bytes.clone()).unwrap();
        let queries: Vec<Query> = (0..10).map(|_| random_query(&mut rng, &mem)).collect();
        check_series(&prog.bytes, &queries, &format!("{spec:?}"));
    }
}
