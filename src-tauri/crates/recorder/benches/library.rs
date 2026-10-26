//! recorder 节目库微基准（带分配计数）。
//!
//! 首次使用时在系统临时目录 `recorder-bench-<pid>/library` 生成 50 个节目（只生成一次，基准结束后删除）：
//! 每个为 8 路 × 10 秒 @44Hz（440 帧、Zstd L3 全量帧、fade 码流）的 `.artrec`，并各写一个 sidecar。
//! sidecar 按**旧版**格式在 `overview` 字段塞入与 player 生成的 1024 桶 × 8 路概览同等大小的 JSON
//! （字段与 `player::Overview` 的 camelCase 序列化一致；`change` / `level` 各 8 条 Base64 字符串，
//! 每条由 1024 字节编码为 1368 字符），模拟"尚未迁移的旧 sidecar"这一最坏情况，
//! 与改动前的基线保持同一输入。生成后把各文件的修改时间设到一小时以前，越过节目库缓存的
//! racy 窗口（刚修改的文件不进缓存），热缓存项才能真正命中。
//!
//! - `list_library`：不经缓存列出整个目录（`list_library_uncached`：50 × [读 `.artrec` 头与
//!   Universe 表 + 读取并解析 sidecar]），与改动前的 `list_library` 同口径，少量采样。
//! - `list_library_cold_cache`：每次用一个空的 [`recorder::LibraryCache`] 列举（全部未命中，
//!   含指纹采集与写入缓存的开销）。
//! - `list_library_hot_cache`：预热过、文件无变化的缓存再次列举（只列目录、取元数据并复制条目）。
//! - `read_sidecar::with_overview`：读取并解析单个旧版带概览的 sidecar（概览字段被忽略但仍要扫过）。
//! - `read_sidecar::without_overview`：同样元数据但不含概览的 sidecar，作为对照。
//!
//! 运行：`cargo bench -p recorder --bench library`；冒烟：追加 `-- --sample-count 2`。

use std::io::Cursor;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

use artnet_net::Protocol;
use artrec_core::{ArtRecWriter, CompressAlgo, UniDesc};
use divan::counter::ItemsCount;
use divan::{black_box, Bencher};
use recorder::{sidecar_path, write_sidecar, LibraryCache, RecordFilter, Sidecar, SIDECAR_VERSION};

#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

/// 帧率（Hz）。
const FPS: u64 = 44;
/// 每路 DMX 通道数。
const DMX_LEN: usize = 512;
/// 每路 Universe 的 fade 灯具数（每台 4 通道：调光 + RGB）。
const FIXTURES: usize = 50;
/// 每个节目的 Universe 路数。
const UNIVERSES: usize = 8;
/// 每个节目的帧数：10 秒 @44Hz。
const FRAMES: usize = 440;
/// 节目个数。
const PROGRAMS: usize = 50;
/// 概览桶数（与 player 默认值一致）。
const BUCKETS: usize = 1024;
/// 伪随机种子。
const SEED: u64 = 0x9E37_79B9_7F4A_7C15;
/// Base64 标准字母表。
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 基准节目库目录（首次使用时生成 50 个节目与 sidecar，只生成一次）。
static LIBRARY: LazyLock<PathBuf> = LazyLock::new(|| {
    let dir = bench_dir().join("library");
    std::fs::create_dir_all(&dir).expect("创建基准临时目录失败");
    let mut rng = Rng(SEED);
    for i in 0..PROGRAMS {
        let path = dir.join(format!("show-{i:02}.artrec"));
        let bytes = build_program(i * 37);
        std::fs::write(&path, &bytes).expect("写入基准节目失败");
        let overview = overview_json(&mut rng, bytes.len() as u64);
        write_legacy_sidecar(&path, &sidecar(i, bytes.len() as u64), overview);
        // 各节目修改时间互不相同（排序确定），且都早于缓存的 racy 窗口
        let age = Duration::from_secs(3600 + i as u64 * 60);
        set_age(&path, age);
        set_age(&sidecar_path(&path), age);
    }
    dir
});

/// 不含概览的对照 sidecar 对应的 `.artrec` 路径（只写 sidecar，本体不需要存在）。
static PLAIN: LazyLock<PathBuf> = LazyLock::new(|| {
    let dir = bench_dir().join("plain");
    std::fs::create_dir_all(&dir).expect("创建基准临时目录失败");
    let path = dir.join("plain.artrec");
    write_sidecar(&path, &sidecar(0, 0)).expect("写入 sidecar 失败");
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
/// `std::env::temp_dir()/recorder-bench-<pid>`（不保证已创建）。
fn bench_dir() -> PathBuf {
    std::env::temp_dir().join(format!("recorder-bench-{}", std::process::id()))
}

/// 确定性 xorshift64 伪随机数发生器（与 `examples/bench.rs` 同款，避免引入额外依赖）。
struct Rng(u64);

impl Rng {
    /// 产出下一个 64 位伪随机数。
    ///
    /// # Returns
    ///
    /// 下一个伪随机数（种子非 0 时永不为 0）。
    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
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
/// 8 路、每路 512 字节的缓冲：每路 50 台灯具，调光通道静止 255，RGB 缓慢渐变，其余为 0。
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

/// 生成一个 8 路 × 440 帧的 fade 全量帧节目（Zstd L3，与录制默认配置一致）。
///
/// # Arguments
///
/// * `phase` - 起始相位偏移，让各节目内容互不相同。
///
/// # Returns
///
/// 完整 `.artrec` 文件字节，总时长 10 秒。
fn build_program(phase: usize) -> Vec<u8> {
    let unis: Vec<UniDesc> = (0..UNIVERSES)
        .map(|u| {
            UniDesc::from_universe(u as u16, DMX_LEN as u16).expect("基准 Universe 编号不会越界")
        })
        .collect();
    let mut w = ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 3, 0, 0)
        .expect("基准 Universe 表合法");
    for f in 0..FRAMES {
        w.add_full_frame(frame_time_us(f), &fade_frame(phase + f))
            .expect("写入全量帧不应失败");
    }
    w.finish(frame_time_us(FRAMES))
        .expect("收尾写索引不应失败")
        .into_inner()
}

/// 标准 Base64（带 `=` 填充）编码，与 player 概览矩阵的序列化格式一致。
///
/// # Arguments
///
/// * `bytes` - 待编码的原始字节。
///
/// # Returns
///
/// Base64 字符串（1024 字节输入得到 1368 字符）。
fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(chunk[0]) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(char::from(B64[(n >> 18) as usize & 63]));
        out.push(char::from(B64[(n >> 12) as usize & 63]));
        out.push(if chunk.len() > 1 {
            char::from(B64[(n >> 6) as usize & 63])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(B64[n as usize & 63])
        } else {
            '='
        });
    }
    out
}

/// 构造与 player 1024 桶 × 8 路概览同等大小的 JSON 值。
///
/// # Arguments
///
/// * `rng` - 伪随机发生器（填充矩阵内容）。
/// * `file_bytes` - 对应 `.artrec` 的字节数。
///
/// # Returns
///
/// 字段与 `player::Overview` 序列化结果一致的 JSON 对象。
fn overview_json(rng: &mut Rng, file_bytes: u64) -> serde_json::Value {
    let mut rows = || -> Vec<String> {
        (0..UNIVERSES)
            .map(|_| {
                let row: Vec<u8> = (0..BUCKETS).map(|_| rng.next_u64() as u8).collect();
                base64(&row)
            })
            .collect()
    };
    let change = rows();
    let level = rows();
    serde_json::json!({
        "version": 1,
        "durationUs": frame_time_us(FRAMES),
        "buckets": BUCKETS,
        "universes": (0..UNIVERSES).collect::<Vec<usize>>(),
        "change": change,
        "level": level,
        "frames": FRAMES,
        "skippedFrames": 0,
        "fileBytes": file_bytes,
    })
}

/// 按旧版格式写 sidecar：在正常字段之外内嵌 `overview` 概览。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 路径（写入其对应的 sidecar）。
/// * `meta` - 元数据。
/// * `overview` - 要内嵌的概览 JSON。
fn write_legacy_sidecar(artrec: &Path, meta: &Sidecar, overview: serde_json::Value) {
    let mut v = serde_json::to_value(meta).expect("sidecar 可序列化");
    v["overview"] = overview;
    let text = serde_json::to_string_pretty(&v).expect("JSON 可序列化");
    std::fs::write(sidecar_path(artrec), text).expect("写入 sidecar 失败");
}

/// 把文件的修改时间设为"现在之前 `age`"。
///
/// # Arguments
///
/// * `path` - 文件路径。
/// * `age` - 距现在的时长。
fn set_age(path: &Path, age: Duration) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .and_then(|f| f.set_modified(SystemTime::now() - age))
        .expect("设置修改时间失败");
}

/// 构造一份贴近真实录制结果的 sidecar。
///
/// # Arguments
///
/// * `i` - 节目序号（用于名称与来源 IP）。
/// * `bytes` - 对应 `.artrec` 的字节数。
///
/// # Returns
///
/// 填好名称、来源、协议、时长等字段的 [`Sidecar`]。
fn sidecar(i: usize, bytes: u64) -> Sidecar {
    Sidecar {
        version: SIDECAR_VERSION,
        name: format!("演出节目 {i:02}"),
        notes: "基准生成的节目，用于度量节目库列表开销".into(),
        created_unix_ms: 1_700_000_000_000 + i as u64 * 60_000,
        app_version: "0.1.0".into(),
        filter: RecordFilter::default(),
        universes: (0..UNIVERSES as u16).collect(),
        merge_mode: "htp".into(),
        sources: vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, (i % 250) as u8 + 1))],
        protocols: vec![Protocol::ArtNet],
        ignored_universes: Vec::new(),
        duration_us: frame_time_us(FRAMES),
        frames: FRAMES as u64,
        bytes,
        recovered: false,
    }
}

/// sidecar 文件字节数（用作吞吐计数）。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 路径。
///
/// # Returns
///
/// 对应 sidecar 的字节数。
fn sidecar_len(artrec: &Path) -> u64 {
    std::fs::metadata(recorder::sidecar_path(artrec))
        .expect("sidecar 已生成")
        .len()
}

/// 不经缓存列出 50 个节目（读每个 `.artrec` 的头与 Universe 表并解析其 sidecar），
/// 与改动前的 `list_library` 同口径。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench(sample_count = 20, sample_size = 1)]
fn list_library(bencher: Bencher) {
    let dir = LIBRARY.as_path();
    // 计时前先列一次：校验节目数，同时让文件进入系统缓存（度量 OS 页缓存已热时的开销）
    let warm = recorder::list_library_uncached(dir);
    assert_eq!(warm.len(), PROGRAMS, "基准节目库应含 50 个节目");
    assert!(warm.iter().all(|e| e.valid && e.frames == FRAMES as u64));
    bencher
        .counter(ItemsCount::new(PROGRAMS))
        .bench(|| recorder::list_library_uncached(black_box(dir)));
}

/// 冷缓存列举：每次都用一个空的 [`LibraryCache`]（全部未命中）。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench(sample_count = 20, sample_size = 1)]
fn list_library_cold_cache(bencher: Bencher) {
    let dir = LIBRARY.as_path();
    assert_eq!(LibraryCache::new().list(dir).len(), PROGRAMS);
    bencher
        .counter(ItemsCount::new(PROGRAMS))
        .with_inputs(LibraryCache::new)
        .bench_refs(|cache| cache.list(black_box(dir)));
}

/// 热缓存列举：缓存已预热、文件无变化（只列目录、取元数据比对指纹并复制条目）。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench]
fn list_library_hot_cache(bencher: Bencher) {
    let dir = LIBRARY.as_path();
    let cache = LibraryCache::new();
    let warm = cache.list(dir);
    assert_eq!(warm.len(), PROGRAMS);
    assert_eq!(cache.cached_count(), PROGRAMS, "全部节目应已进入缓存");
    assert_eq!(cache.list(dir), warm, "预热后结果不变");
    assert_eq!(
        warm,
        recorder::list_library_uncached(dir),
        "缓存结果与直读一致"
    );
    bencher
        .counter(ItemsCount::new(PROGRAMS))
        .bench(|| cache.list(black_box(dir)));
}

/// `read_sidecar`：读取并解析单个 sidecar。
#[divan::bench_group]
mod read_sidecar {
    use std::path::Path;

    use divan::counter::BytesCount;
    use divan::{black_box, Bencher};

    use super::{sidecar_len, LIBRARY, PLAIN};

    /// 在计时区内反复读取并解析 `artrec` 对应的 sidecar。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    /// * `artrec` - `.artrec` 路径。
    fn run(bencher: Bencher, artrec: &Path) {
        bencher
            .counter(BytesCount::new(sidecar_len(artrec)))
            .bench(|| recorder::read_sidecar(black_box(artrec)).expect("sidecar 存在且合法"));
    }

    /// 带 1024 桶 × 8 路概览的 sidecar（约 23 KB）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn with_overview(bencher: Bencher) {
        run(bencher, &LIBRARY.join("show-00.artrec"));
    }

    /// 不含概览的对照 sidecar。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn without_overview(bencher: Bencher) {
        run(bencher, &PLAIN);
    }
}
