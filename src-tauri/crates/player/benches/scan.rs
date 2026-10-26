//! player 扫描与回放推进微基准（带分配计数）。
//!
//! 测试节目：64 路 Universe × 2 分钟 @44Hz（5280 帧）、Zstd L3 全量帧、fade 码流
//! （每路 50 台灯具 × 4 通道：调光通道静止 255，RGB 三通道逐帧缓慢渐变，其余通道为 0），
//! 首次使用时写入系统临时目录 `player-bench-<pid>`（只生成一次），基准结束后删除。
//! 所有基准都经 `ArtRecReader::open_file` 流式读盘，与宿主层打开节目的方式一致。
//!
//! - `build_overview`：单线程整段扫描生成 1024 桶时间线概览（单次较慢，少量采样）。
//! - `build_overview_parallel`：同上，经专用线程池并行扫描（结果与串行逐字节一致）。
//! - `channel_series`：单线程查询第一路 Universe 的 16 个通道、全程、最多 1200 点的 min/max 降采样。
//! - `channel_series_parallel`：同上，按桶边界切段并行。
//! - `player_poll_10s`：`Player` 从停止状态开始播放，在 44Hz 帧时刻逐帧 `poll`，推进 10 秒节目内容
//!   （440 帧；fade 码流每帧 64 路都变化，因此每次 `poll` 都输出 64 路数据）。
//! - `player_seek_20`：`Player::seek` 到整段节目内 20 个均匀分布的位置，每次输出全部 64 路的完整状态。
//!
//! 并行基准的计时包含每次调用为各段重新打开文件、建立读取器的开销。注意 divan 的分配计数是
//! 线程本地的：并行基准只统计调用线程上的分配（建段、合并、组装结果），线程池工作线程里的
//! 分配（各段状态、解压缓冲等）不计入。线程池在首次调用时创建，基准先预热一次，
//! 避免把建池时间计入样本。
//!
//! 运行：`cargo bench -p player --bench scan`；冒烟：追加 `-- --sample-count 2`。

use std::io::Cursor;
use std::path::PathBuf;
use std::sync::LazyLock;

use artrec_core::{ArtRecReader, ArtRecWriter, CompressAlgo, UniDesc};
use divan::counter::ItemsCount;
use divan::{black_box, Bencher};
use player::{Player, PlayerConfig};

#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

/// 帧率（Hz）。
const FPS: u64 = 44;
/// 每路 DMX 通道数。
const DMX_LEN: usize = 512;
/// 每路 Universe 的 fade 灯具数（每台 4 通道：调光 + RGB）。
const FIXTURES: usize = 50;
/// 节目 Universe 路数。
const UNIVERSES: usize = 64;
/// 节目帧数：2 分钟 @44Hz。
const FRAMES: usize = 5280;
/// 概览桶数（与默认值一致）。
const BUCKETS: u32 = 1024;
/// 曲线查询的通道数（单次查询上限）。
const SERIES_CHANNELS: u16 = 16;
/// 曲线查询的最大点数。
const SERIES_POINTS: u32 = 1200;
/// 回放推进基准覆盖的帧数：10 秒 @44Hz。
const POLL_FRAMES: usize = 440;
/// seek 基准每次迭代的跳转次数（均匀分布在整段节目内）。
const SEEKS: usize = 20;

/// 基准节目文件路径（首次使用时写入临时目录，只生成一次）。
static PROGRAM: LazyLock<PathBuf> = LazyLock::new(|| {
    let dir = bench_dir();
    std::fs::create_dir_all(&dir).expect("创建基准临时目录失败");
    let path = dir.join("scan-64x5280.artrec");
    std::fs::write(&path, build_program()).expect("写入基准节目失败");
    path
});

fn main() {
    divan::main();
    // 基准结束后清理临时目录；未生成过时目录不存在，忽略错误即可。
    let _ = std::fs::remove_dir_all(bench_dir());
}

/// 本进程专属的基准临时目录。
///
/// # Returns
///
/// `std::env::temp_dir()/player-bench-<pid>`（不保证已创建）。
fn bench_dir() -> PathBuf {
    std::env::temp_dir().join(format!("player-bench-{}", std::process::id()))
}

/// 三角波：周期 512 帧，在 0~255 间往返，每帧变化 1。
///
/// # Arguments
///
/// * `phase` - 相位（帧）。
///
/// # Returns
///
/// 该相位的通道值。
fn triangle(phase: usize) -> u8 {
    let p = phase % 512;
    // p < 256 时上升、其后下降，结果必在 0~255，截断安全
    (if p < 256 { p } else { 511 - p }) as u8
}

/// 生成 fade 码流第 `frame` 帧的各路 DMX 缓冲。
///
/// # Arguments
///
/// * `frame` - 帧序号（决定渐变相位）。
///
/// # Returns
///
/// 64 路、每路 512 字节的缓冲：每路 50 台灯具，调光通道静止 255，RGB 缓慢渐变，其余为 0。
fn fade_frame(frame: usize) -> Vec<Vec<u8>> {
    (0..UNIVERSES)
        .map(|ui| {
            let mut buf = vec![0u8; DMX_LEN];
            for fx in 0..FIXTURES {
                let base = fx * 4;
                let phase = frame + fx * 5 + ui * 7;
                buf[base] = 255;
                buf[base + 1] = triangle(phase);
                buf[base + 2] = triangle(phase + 170);
                buf[base + 3] = triangle(phase + 340);
            }
            buf
        })
        .collect()
}

/// 第 `f` 帧的时间戳（44Hz 等间隔）。
///
/// # Arguments
///
/// * `f` - 帧序号。
///
/// # Returns
///
/// 相对节目起点的微秒数。
fn frame_time_us(f: usize) -> u64 {
    f as u64 * 1_000_000 / FPS
}

/// 生成 64 路 × 5280 帧的 fade 全量帧节目（Zstd L3，与录制默认配置一致）。
///
/// # Returns
///
/// 完整 `.artrec` 文件字节，总时长 120 秒。
fn build_program() -> Vec<u8> {
    let unis: Vec<UniDesc> = (0..UNIVERSES)
        .map(|u| {
            UniDesc::from_universe(u as u16, DMX_LEN as u16).expect("基准 Universe 编号不会越界")
        })
        .collect();
    let mut w = ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 3, 0, 0)
        .expect("基准 Universe 表合法");
    for f in 0..FRAMES {
        w.add_full_frame(frame_time_us(f), &fade_frame(f))
            .expect("写入全量帧不应失败");
    }
    w.finish(frame_time_us(FRAMES))
        .expect("收尾写索引不应失败")
        .into_inner()
}

/// 以流式方式打开基准节目（每个基准各自一份读取器）。
///
/// # Returns
///
/// 基准节目的磁盘读取器。
fn open_program() -> ArtRecReader<std::fs::File> {
    ArtRecReader::open_file(&PROGRAM).expect("基准节目可解析")
}

/// `build_overview(&reader, 1024)`：整段 5280 帧扫描生成时间线概览。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench(sample_count = 10, sample_size = 1)]
fn build_overview(bencher: Bencher) {
    let reader = open_program();
    bencher
        .counter(ItemsCount::new(FRAMES))
        .bench_local(|| player::build_overview(&reader, black_box(BUCKETS)));
}

/// `build_overview_parallel(&reader, path, 1024)`：专用线程池并行扫描生成时间线概览。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench(sample_count = 10, sample_size = 1)]
fn build_overview_parallel(bencher: Bencher) {
    let reader = open_program();
    // 预热：首次调用会创建线程池
    let warm = player::build_overview_parallel(&reader, &PROGRAM, BUCKETS).expect("基准节目可扫描");
    assert_eq!(
        warm,
        player::build_overview(&reader, BUCKETS),
        "并行与串行结果应一致"
    );
    bencher.counter(ItemsCount::new(FRAMES)).bench_local(|| {
        player::build_overview_parallel(&reader, &PROGRAM, black_box(BUCKETS))
            .expect("基准节目可扫描")
    });
}

/// `channel_series`：第一路 Universe、16 个通道、全程、最多 1200 点。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench(sample_count = 10, sample_size = 1)]
fn channel_series(bencher: Bencher) {
    let reader = open_program();
    let universe = reader.unis()[0].universe;
    let channels: Vec<u16> = (0..SERIES_CHANNELS).collect();
    let t1 = reader.header().total_duration_us;
    bencher.counter(ItemsCount::new(FRAMES)).bench_local(|| {
        player::channel_series(
            &reader,
            universe,
            black_box(&channels),
            0,
            t1,
            SERIES_POINTS,
        )
        .expect("Universe 存在且通道数未超限")
    });
}

/// `channel_series_parallel`：同 `channel_series` 的查询，按桶边界切段并行。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench(sample_count = 10, sample_size = 1)]
fn channel_series_parallel(bencher: Bencher) {
    let reader = open_program();
    let universe = reader.unis()[0].universe;
    let channels: Vec<u16> = (0..SERIES_CHANNELS).collect();
    let t1 = reader.header().total_duration_us;
    let query = || {
        player::channel_series_parallel(
            &reader,
            &PROGRAM,
            universe,
            black_box(&channels),
            0,
            t1,
            SERIES_POINTS,
        )
        .expect("Universe 存在且通道数未超限")
    };
    // 预热：首次调用会创建线程池
    let warm = query();
    let serial = player::channel_series(&reader, universe, &channels, 0, t1, SERIES_POINTS)
        .expect("Universe 存在且通道数未超限");
    assert_eq!(warm, serial, "并行与串行结果应一致");
    bencher.counter(ItemsCount::new(FRAMES)).bench_local(query);
}

/// `Player` 从停止状态开始播放，逐帧 `poll` 推进 10 秒（440 帧）节目内容。
///
/// 每次迭代先 `stop()` 再 `play(0)` 回到开头（首帧会输出全部 64 路），随后在每个帧时刻
/// 调用一次 `poll`；返回的输出在计时区内丢弃，与宿主层消费后释放的行为一致。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench(sample_count = 20, sample_size = 1)]
fn player_poll_10s(bencher: Bencher) {
    let mut p = Player::new(open_program(), PlayerConfig::default());
    bencher
        .counter(ItemsCount::new(POLL_FRAMES))
        .bench_local(|| {
            p.stop();
            p.play(0);
            let mut universes = 0usize;
            for f in 0..POLL_FRAMES {
                let out = p.poll(black_box(frame_time_us(f)));
                universes += out.iter().map(|e| e.universes.len()).sum::<usize>();
                black_box(out);
            }
            universes
        });
}

/// `Player::seek` 到 20 个均匀分布的位置，每次输出全部 64 路的完整状态。
///
/// 全量帧节目里每次 seek 只需解析目标帧本身（读一块 + 解压 + 拆分到各路缓冲），
/// 因此本基准主要衡量 seek 路径的缓冲拷贝与分配。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench(sample_count = 20, sample_size = 1)]
fn player_seek_20(bencher: Bencher) {
    let mut p = Player::new(open_program(), PlayerConfig::default());
    p.play(0);
    let duration = frame_time_us(FRAMES);
    bencher.counter(ItemsCount::new(SEEKS)).bench_local(|| {
        let mut universes = 0usize;
        for i in 0..SEEKS {
            let pos = duration * i as u64 / SEEKS as u64;
            let out = p.seek(0, black_box(pos));
            universes += out.iter().map(|e| e.universes.len()).sum::<usize>();
            black_box(out);
        }
        universes
    });
}
