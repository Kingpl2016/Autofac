//! recorder 录制 tick 路径微基准（带分配计数）。
//!
//! 场景：64 路 Universe（编号 0..64）、默认编码配置（Zstd L3、仅全量帧）、HTP 合并、单一来源。
//! 每次迭代模拟一个 44Hz 录制周期：先 `ingest` 64 个 `DmxFrame`（每路一帧，fade 码流：每路 50 台灯具，
//! 调光通道静止 255、RGB 逐帧缓慢渐变，其余为 0；预生成 128 组循环使用，`Bytes` 共享无深拷贝），
//! 再调用一次 `tick()`——合并输出写入复用快照缓冲、与上一帧的变更检测、全量帧装配、Zstd 压缩、CRC 与写出。
//! fade 码流每帧都有变化，因此每次 `tick` 都会写一帧。
//!
//! 稳态（前 128 次迭代之后）每次迭代应为 0 次 Rust 堆分配；前 128 次迭代里每路帧的 `Bytes`
//! 首次被克隆时会各分配一次共享头（基准数据本身的一次性开销），小样本冒烟时会计入。
//!
//! - `tick::memory`：`RecorderSession<Cursor<Vec<u8>>>` 写入内存流（纯 CPU 路径）。
//! - `tick::file`：`FileRecorder` 写入临时目录 `recorder-bench-<pid>` 下的 `.part` 文件（64 KiB `BufWriter`）
//!   并在本地暂存索引日志条目，与宿主层录制路径一致；不调用 `checkpoint`（`sync_data` 在后台刷盘线程执行，
//!   不占用录制线程，不计入）。结束后取消录制并删除临时文件。
//!
//! 运行：`cargo bench -p recorder --bench session`；冒烟：追加 `-- --sample-count 2`。

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::time::Instant;

use artnet_net::{Bytes, DmxFrame, Protocol};
use recorder::{EncoderConfig, RecordFilter, SessionConfig};
use signal_engine::MergeMode;

#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

/// 帧率（Hz）。
const FPS: u64 = 44;
/// 每路 DMX 通道数。
const DMX_LEN: usize = 512;
/// 每路 Universe 的 fade 灯具数（每台 4 通道：调光 + RGB）。
const FIXTURES: usize = 50;
/// 录制的 Universe 路数。
const UNIVERSES: usize = 64;
/// 预生成并循环使用的帧组数（避免在计时区内生成码流）。
const FRAME_CYCLE: usize = 128;
/// 合并引擎源超时（毫秒，与宿主默认一致）。
const SOURCE_TIMEOUT_MS: u64 = 2500;
/// 唯一来源地址。
const SOURCE: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 7));

fn main() {
    divan::main();
    // 基准结束后清理临时目录；未生成过时目录不存在，忽略错误即可。
    let _ = std::fs::remove_dir_all(bench_dir());
}

/// 本进程专属的基准临时目录。
///
/// # Returns
///
/// `std::env::temp_dir()/recorder-bench-<pid>`（不保证已创建）。
fn bench_dir() -> PathBuf {
    std::env::temp_dir().join(format!("recorder-bench-{}", std::process::id()))
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

/// 生成 fade 码流第 `frame` 帧第 `ui` 路的 DMX 数据。
///
/// # Arguments
///
/// * `frame` - 帧序号（决定渐变相位）。
/// * `ui` - Universe 下标。
///
/// # Returns
///
/// 512 字节缓冲：50 台灯具，调光通道静止 255，RGB 缓慢渐变，其余为 0。
fn fade_universe(frame: usize, ui: usize) -> Vec<u8> {
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
}

/// 预生成 [`FRAME_CYCLE`] 组、每组 64 个（每路一个）待摄入的 Art-Net 帧。
///
/// # Returns
///
/// `cycle[k][u]` 为第 `k` 组第 `u` 路的帧。
fn frame_cycle() -> Vec<Vec<DmxFrame>> {
    let received_at = Instant::now();
    (0..FRAME_CYCLE)
        .map(|f| {
            (0..UNIVERSES)
                .map(|ui| DmxFrame {
                    protocol: Protocol::ArtNet,
                    universe: ui as u16,
                    data: Bytes::from(fade_universe(f, ui)),
                    source: Some(SOURCE),
                    sequence: (f % 256) as u8,
                    received_at,
                })
                .collect()
        })
        .collect()
}

/// 第 `k` 个录制周期的时间戳（44Hz 等间隔）。
///
/// # Arguments
///
/// * `k` - 周期序号。
///
/// # Returns
///
/// 相对录制起点的微秒数。
fn tick_time_us(k: usize) -> u64 {
    k as u64 * 1_000_000 / FPS
}

/// 64 路、默认编码配置（Zstd L3、仅全量帧）、HTP 合并的会话配置。
///
/// # Returns
///
/// 不做任何过滤的 [`SessionConfig`]。
fn session_config() -> SessionConfig {
    SessionConfig {
        filter: RecordFilter::default(),
        universes: (0..UNIVERSES as u16).collect(),
        merge_mode: MergeMode::Htp,
        encoder: EncoderConfig::default(),
        rec_start_unix_us: 0,
    }
}

/// 一个录制 tick：摄入 64 路帧后调用一次 `tick()`。
#[divan::bench_group]
mod tick {
    use std::io::Cursor;

    use divan::counter::ItemsCount;
    use divan::{black_box, Bencher};
    use recorder::{FileRecorder, RecorderSession, StartParams};

    use super::{
        bench_dir, frame_cycle, session_config, tick_time_us, FRAME_CYCLE, SOURCE_TIMEOUT_MS,
        UNIVERSES,
    };

    /// `RecorderSession` 写入内存 `Cursor<Vec<u8>>`。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn memory(bencher: Bencher) {
        let cycle = frame_cycle();
        let mut session =
            RecorderSession::new(Cursor::new(Vec::new()), session_config(), SOURCE_TIMEOUT_MS)
                .expect("基准 Universe 集合合法");
        let mut k = 0usize;
        bencher.counter(ItemsCount::new(UNIVERSES)).bench_local(|| {
            let t_us = tick_time_us(k);
            for frame in &cycle[k % FRAME_CYCLE] {
                session.ingest(black_box(frame), t_us);
            }
            k += 1;
            session.tick().expect("写帧不应失败")
        });
    }

    /// `FileRecorder` 写入临时目录（`.part` + 索引日志，不做 `checkpoint`）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn file(bencher: Bencher) {
        let cycle = frame_cycle();
        let params = StartParams {
            dir: bench_dir(),
            stem: "tick".into(),
            name: "tick".into(),
            notes: String::new(),
            created_unix_ms: 0,
            app_version: "bench".into(),
            merge_mode: "htp".into(),
            source_timeout_ms: SOURCE_TIMEOUT_MS,
        };
        let mut rec = FileRecorder::start(params, session_config()).expect("临时目录可写");
        let mut k = 0usize;
        bencher.counter(ItemsCount::new(UNIVERSES)).bench_local(|| {
            let t_us = tick_time_us(k);
            for frame in &cycle[k % FRAME_CYCLE] {
                rec.ingest(black_box(frame), t_us);
            }
            k += 1;
            rec.tick().expect("写帧不应失败")
        });
        // 取消录制：删除 `.part` 与索引日志
        rec.cancel();
    }
}
