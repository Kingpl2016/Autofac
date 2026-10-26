//! artrec-core 编解码微基准（带分配计数）。
//!
//! 原有基准名（`compress`、`decompress`、`read_chunk`、`resolve_frame`、`add_full_frame`、
//! `crc16_ccitt_64k`、`open_file`）保持不变，便于与优化前的基线对比。
//!
//! 度量内容：
//!
//! - `compress` / `decompress`：Zstd L3 压缩、解压单帧全量原始 Payload，覆盖 64 路与 127 路
//!   （127 × 512 = 65024 字节，贴近 `payload_raw_sz` 为 u16 的上限）。码流两种：
//!   - `fade`：每路 50 台灯具 × 4 通道（调光通道静止于 255，RGB 三通道逐帧缓慢渐变），
//!     即每路约 150 个通道变化、50 个通道静止、其余 312 个通道为 0；
//!   - `random`：全部通道随机（几乎不可压缩的最坏情况）。
//! - `crc16_ccitt_64k`：CRC16-CCITT 对 64 KiB 随机缓冲。
//! - `add_full_frame`：64 路 fade 帧写入内存 `Cursor<Vec<u8>>`（装配 + 压缩 + CRC + 写出 + 索引追加）；
//!   写入器在基准外构造，每次迭代追加一帧。
//! - `read_chunk` / `resolve_frame`：内存中 64 路 × 2000 帧（fade、全量帧）文件，按顺序与随机下标读帧。
//! - `read_chunk_into`：同 `read_chunk`，但复用调用方的 Payload 缓冲（稳态零分配）。
//! - `open_file`：系统临时目录（`artrec-bench-<pid>`）中 64 路 × 5280 帧（2 分钟 @44Hz）文件的打开耗时
//!   （读文件头、Universe 表与帧索引）。
//! - `scan_5280`：对同一磁盘文件按帧号顺序 `read_chunk_into` 全部 5280 帧（概览 / 曲线扫描的读盘模式），
//!   对比直接读 `File`（`file`）与经 1 MiB 窗口 `ReadAhead`（`read_ahead`）。每次迭代扫描整段节目。
//!
//! 运行：`cargo bench -p artrec-core --bench codec`；冒烟：追加 `-- --sample-count 2`。

use std::io::Cursor;
use std::path::PathBuf;
use std::sync::LazyLock;

use artrec_core::{assemble_full, ArtRecReader, ArtRecWriter, CompressAlgo, UniDesc};
use divan::Bencher;

#[global_allocator]
static ALLOC: divan::AllocProfiler = divan::AllocProfiler::system();

/// 帧率（Hz）。
const FPS: u64 = 44;
/// 每路 DMX 通道数。
const DMX_LEN: usize = 512;
/// 每路 Universe 的 fade 灯具数（每台 4 通道：调光 + RGB）。
const FIXTURES: usize = 50;
/// Zstd 压缩等级（与录制默认配置一致）。
const ZSTD_LEVEL: u8 = 3;
/// 读写基准使用的 Universe 路数。
const UNIVERSES: usize = 64;
/// 写入基准循环使用的预生成帧数（避免在计时区内生成码流）。
const FRAME_CYCLE: usize = 128;
/// 内存读帧基准的帧数。
const READ_FRAMES: usize = 2000;
/// `open_file` 基准的帧数：2 分钟 @44Hz。
const OPEN_FRAMES: usize = 5280;
/// 随机读帧基准预生成的随机下标个数。
const RANDOM_PICKS: usize = 1024;
/// 写入基准的内存流上限：超过即换新写入器，保证偏移字段（u32）不溢出。
const WRITER_RESET_BYTES: u64 = 1 << 30;
/// 伪随机种子。
const SEED: u64 = 0x9E37_79B9_7F4A_7C15;

/// 内存读帧基准用的 64 路 × 2000 帧文件字节（首次使用时生成，只生成一次）。
static READ_FILE: LazyLock<Vec<u8>> = LazyLock::new(|| build_file(UNIVERSES, READ_FRAMES));

/// `open_file` 基准用的磁盘文件路径（首次使用时写入临时目录，只生成一次）。
static OPEN_FILE: LazyLock<PathBuf> = LazyLock::new(|| {
    let dir = bench_dir();
    std::fs::create_dir_all(&dir).expect("创建基准临时目录失败");
    let path = dir.join("open-64x5280.artrec");
    std::fs::write(&path, build_file(UNIVERSES, OPEN_FRAMES)).expect("写入基准临时文件失败");
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
/// `std::env::temp_dir()/artrec-bench-<pid>`（不保证已创建）。
fn bench_dir() -> PathBuf {
    std::env::temp_dir().join(format!("artrec-bench-{}", std::process::id()))
}

/// 确定性 xorshift64 伪随机数发生器（与 `recorder/examples/bench.rs` 同款，避免引入额外依赖）。
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

    /// 产出 `[0, bound)` 内的伪随机下标。
    ///
    /// # Arguments
    ///
    /// * `bound` - 上界（不含），须大于 0。
    ///
    /// # Returns
    ///
    /// `[0, bound)` 内的下标（取模，轻微偏差对基准无影响）。
    fn below(&mut self, bound: usize) -> usize {
        (self.next_u64() % bound as u64) as usize
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
/// * `n` - Universe 路数。
/// * `frame` - 帧序号（决定渐变相位）。
///
/// # Returns
///
/// `n` 路、每路 512 字节的缓冲：每路 50 台灯具，调光通道静止 255，RGB 缓慢渐变，其余为 0。
fn fade_frame(n: usize, frame: usize) -> Vec<Vec<u8>> {
    (0..n)
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

/// 生成全随机码流的一帧。
///
/// # Arguments
///
/// * `n` - Universe 路数。
/// * `rng` - 伪随机发生器。
///
/// # Returns
///
/// `n` 路、每路 512 字节的随机缓冲。
fn random_frame(n: usize, rng: &mut Rng) -> Vec<Vec<u8>> {
    (0..n)
        .map(|_| (0..DMX_LEN).map(|_| rng.next_u64() as u8).collect())
        .collect()
}

/// 构造编号 `0..n`、每路 512 通道的 Universe 描述表。
///
/// # Arguments
///
/// * `n` - Universe 路数（≤ 127）。
///
/// # Returns
///
/// 升序的 [`UniDesc`] 列表。
fn unis(n: usize) -> Vec<UniDesc> {
    (0..n)
        .map(|u| {
            UniDesc::from_universe(u as u16, DMX_LEN as u16).expect("基准 Universe 编号不会越界")
        })
        .collect()
}

/// fade 码流单帧全量原始 Payload。
///
/// # Arguments
///
/// * `n` - Universe 路数。
///
/// # Returns
///
/// `n × 512` 字节的原始 Payload（取节目中段的一帧）。
fn fade_payload(n: usize) -> Vec<u8> {
    assemble_full(&unis(n), &fade_frame(n, 1000)).expect("缓冲长度与描述表一致")
}

/// 随机码流单帧全量原始 Payload。
///
/// # Arguments
///
/// * `n` - Universe 路数。
///
/// # Returns
///
/// `n × 512` 字节的随机原始 Payload。
fn random_payload(n: usize) -> Vec<u8> {
    let mut rng = Rng(SEED);
    assemble_full(&unis(n), &random_frame(n, &mut rng)).expect("缓冲长度与描述表一致")
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

/// 新建写入内存流的 Zstd L3 写入器。
///
/// # Arguments
///
/// * `n` - Universe 路数。
///
/// # Returns
///
/// 已写出头占位与 Universe 表的写入器。
fn new_writer(n: usize) -> ArtRecWriter<Cursor<Vec<u8>>> {
    ArtRecWriter::new(
        Cursor::new(Vec::new()),
        unis(n),
        CompressAlgo::Zstd,
        ZSTD_LEVEL,
        0,
        0,
    )
    .expect("基准 Universe 表合法")
}

/// 生成 `n` 路 × `frames` 帧的 fade 全量帧节目。
///
/// # Arguments
///
/// * `n` - Universe 路数。
/// * `frames` - 帧数（44Hz）。
///
/// # Returns
///
/// 完整 `.artrec` 文件字节，总时长为 `frames / 44` 秒。
fn build_file(n: usize, frames: usize) -> Vec<u8> {
    let mut w = new_writer(n);
    for f in 0..frames {
        w.add_full_frame(frame_time_us(f), &fade_frame(n, f))
            .expect("写入全量帧不应失败");
    }
    w.finish(frame_time_us(frames))
        .expect("收尾写索引不应失败")
        .into_inner()
}

/// 打开内存读帧基准用的节目。
///
/// # Returns
///
/// 64 路 × 2000 帧节目的内存读取器（每个基准各自一份，互不共享游标）。
fn memory_reader() -> ArtRecReader {
    ArtRecReader::open(READ_FILE.clone()).expect("基准节目可解析")
}

/// 预生成随机帧下标。
///
/// # Returns
///
/// [`RANDOM_PICKS`] 个 `[0, READ_FRAMES)` 内的随机下标。
fn random_picks() -> Vec<usize> {
    let mut rng = Rng(SEED);
    (0..RANDOM_PICKS).map(|_| rng.below(READ_FRAMES)).collect()
}

/// Zstd L3 压缩单帧全量原始 Payload。
#[divan::bench_group]
mod compress {
    use artrec_core::{compress, CompressAlgo};
    use divan::counter::BytesCount;
    use divan::{black_box, Bencher};

    use super::{fade_payload, random_payload, ZSTD_LEVEL};

    /// fade 码流。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    /// * `n` - Universe 路数。
    #[divan::bench(args = [64, 127])]
    fn fade(bencher: Bencher, n: usize) {
        let raw = fade_payload(n);
        bencher.counter(BytesCount::of_slice(&raw)).bench(|| {
            compress(CompressAlgo::Zstd, ZSTD_LEVEL, black_box(&raw)).expect("Zstd 压缩不应失败")
        });
    }

    /// 随机码流（最坏情况）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    /// * `n` - Universe 路数。
    #[divan::bench(args = [64, 127])]
    fn random(bencher: Bencher, n: usize) {
        let raw = random_payload(n);
        bencher.counter(BytesCount::of_slice(&raw)).bench(|| {
            compress(CompressAlgo::Zstd, ZSTD_LEVEL, black_box(&raw)).expect("Zstd 压缩不应失败")
        });
    }
}

/// Zstd 解压单帧全量 Payload（吞吐按解压后字节计）。
#[divan::bench_group]
mod decompress {
    use artrec_core::{compress, decompress, CompressAlgo};
    use divan::counter::BytesCount;
    use divan::{black_box, Bencher};

    use super::{fade_payload, random_payload, ZSTD_LEVEL};

    /// 压缩后在计时区内反复解压。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    /// * `raw` - 原始 Payload。
    fn run(bencher: Bencher, raw: &[u8]) {
        let packed = compress(CompressAlgo::Zstd, ZSTD_LEVEL, raw).expect("Zstd 压缩不应失败");
        let raw_sz = raw.len();
        bencher.counter(BytesCount::new(raw_sz)).bench(|| {
            decompress(CompressAlgo::Zstd, black_box(&packed), raw_sz).expect("Zstd 解压不应失败")
        });
    }

    /// fade 码流。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    /// * `n` - Universe 路数。
    #[divan::bench(args = [64, 127])]
    fn fade(bencher: Bencher, n: usize) {
        run(bencher, &fade_payload(n));
    }

    /// 随机码流（最坏情况）。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    /// * `n` - Universe 路数。
    #[divan::bench(args = [64, 127])]
    fn random(bencher: Bencher, n: usize) {
        run(bencher, &random_payload(n));
    }
}

/// CRC16-CCITT 对 64 KiB 随机缓冲。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench]
fn crc16_ccitt_64k(bencher: Bencher) {
    let mut rng = Rng(SEED);
    let buf: Vec<u8> = (0..64 * 1024).map(|_| rng.next_u64() as u8).collect();
    bencher
        .counter(divan::counter::BytesCount::of_slice(&buf))
        .bench(|| artrec_core::crc16_ccitt(divan::black_box(&buf)));
}

/// `ArtRecWriter::add_full_frame`：64 路 fade 帧追加到内存流（每次迭代一帧）。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench]
fn add_full_frame(bencher: Bencher) {
    let frames: Vec<Vec<Vec<u8>>> = (0..FRAME_CYCLE).map(|f| fade_frame(UNIVERSES, f)).collect();
    let mut writer = new_writer(UNIVERSES);
    let mut k = 0usize;
    bencher
        .counter(divan::counter::BytesCount::new(UNIVERSES * DMX_LEN))
        .bench_local(|| {
            // 防御：内存流过大时换新写入器（正常采样量远达不到该上限）
            if writer.bytes_written() > WRITER_RESET_BYTES {
                writer = new_writer(UNIVERSES);
                k = 0;
            }
            let entry = writer
                .add_full_frame(frame_time_us(k), divan::black_box(&frames[k % FRAME_CYCLE]))
                .expect("写入全量帧不应失败");
            k += 1;
            entry
        });
}

/// `ArtRecReader::read_chunk`：读取并解压校验单个 Chunk（64 路全量帧）。
#[divan::bench_group]
mod read_chunk {
    use divan::counter::BytesCount;
    use divan::{black_box, Bencher};

    use super::{memory_reader, random_picks, DMX_LEN, RANDOM_PICKS, READ_FRAMES, UNIVERSES};

    /// 顺序下标。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn sequential(bencher: Bencher) {
        let reader = memory_reader();
        let mut i = 0usize;
        bencher
            .counter(BytesCount::new(UNIVERSES * DMX_LEN))
            .bench_local(|| {
                let out = reader
                    .read_chunk(black_box(i % READ_FRAMES))
                    .expect("读取 Chunk 不应失败");
                i += 1;
                out
            });
    }

    /// 随机下标。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn random(bencher: Bencher) {
        let reader = memory_reader();
        let picks = random_picks();
        let mut i = 0usize;
        bencher
            .counter(BytesCount::new(UNIVERSES * DMX_LEN))
            .bench_local(|| {
                let out = reader
                    .read_chunk(black_box(picks[i % RANDOM_PICKS]))
                    .expect("读取 Chunk 不应失败");
                i += 1;
                out
            });
    }
}

/// `ArtRecReader::read_chunk_into`：同 `read_chunk`，但复用 Payload 缓冲（64 路全量帧）。
#[divan::bench_group]
mod read_chunk_into {
    use divan::counter::BytesCount;
    use divan::{black_box, Bencher};

    use super::{memory_reader, random_picks, DMX_LEN, RANDOM_PICKS, READ_FRAMES, UNIVERSES};

    /// 顺序下标。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn sequential(bencher: Bencher) {
        let reader = memory_reader();
        let mut raw = Vec::new();
        let mut i = 0usize;
        bencher
            .counter(BytesCount::new(UNIVERSES * DMX_LEN))
            .bench_local(|| {
                let hdr = reader
                    .read_chunk_into(black_box(i % READ_FRAMES), &mut raw)
                    .expect("读取 Chunk 不应失败");
                i += 1;
                black_box(&raw);
                hdr
            });
    }

    /// 随机下标。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn random(bencher: Bencher) {
        let reader = memory_reader();
        let picks = random_picks();
        let mut raw = Vec::new();
        let mut i = 0usize;
        bencher
            .counter(BytesCount::new(UNIVERSES * DMX_LEN))
            .bench_local(|| {
                let hdr = reader
                    .read_chunk_into(black_box(picks[i % RANDOM_PICKS]), &mut raw)
                    .expect("读取 Chunk 不应失败");
                i += 1;
                black_box(&raw);
                hdr
            });
    }
}

/// 磁盘文件按帧号顺序扫描全部 5280 帧（`read_chunk_into` + 复用缓冲）。
///
/// 每次迭代扫描整段节目，吞吐按帧计。读取器在计时区外构造，计时区只含扫描本身。
#[divan::bench_group(sample_count = 10)]
mod scan_5280 {
    use std::fs::File;
    use std::io::{Read, Seek};

    use artrec_core::{ArtRecReader, ReadAhead};
    use divan::counter::ItemsCount;
    use divan::{black_box, Bencher};

    use super::{OPEN_FILE, OPEN_FRAMES};

    /// 顺序读完全部帧。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    /// * `reader` - 待扫描的读取器。
    fn run<R: Read + Seek>(bencher: Bencher, reader: &ArtRecReader<R>) {
        let mut raw = Vec::new();
        bencher
            .counter(ItemsCount::new(OPEN_FRAMES))
            .bench_local(|| {
                for i in 0..reader.index().len() {
                    reader
                        .read_chunk_into(i, &mut raw)
                        .expect("读取 Chunk 不应失败");
                    black_box(&raw);
                }
            });
    }

    /// 直接读 `File`：每帧一次 `seek` + 一次 `read`。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn file(bencher: Bencher) {
        let reader = ArtRecReader::open_file(OPEN_FILE.as_path()).expect("打开基准文件不应失败");
        run(bencher, &reader);
    }

    /// 经 1 MiB 窗口 `ReadAhead`：窗口内 `seek` 只移动游标。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn read_ahead(bencher: Bencher) {
        let path = OPEN_FILE.as_path();
        let base = ArtRecReader::open_file(path).expect("打开基准文件不应失败");
        let reader = base
            .with_source(ReadAhead::new(
                File::open(path).expect("打开基准文件不应失败"),
                1 << 20,
            ))
            .expect("同一文件长度一致");
        run(bencher, &reader);
    }
}

/// `ArtRecReader::resolve_frame`：解析单帧为各路 DMX 缓冲（全量帧，无需回溯差分）。
#[divan::bench_group]
mod resolve_frame {
    use divan::counter::BytesCount;
    use divan::{black_box, Bencher};

    use super::{memory_reader, random_picks, DMX_LEN, RANDOM_PICKS, READ_FRAMES, UNIVERSES};

    /// 顺序下标。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn sequential(bencher: Bencher) {
        let reader = memory_reader();
        let mut i = 0usize;
        bencher
            .counter(BytesCount::new(UNIVERSES * DMX_LEN))
            .bench_local(|| {
                let out = reader
                    .resolve_frame(black_box(i % READ_FRAMES))
                    .expect("解析帧不应失败");
                i += 1;
                out
            });
    }

    /// 随机下标。
    ///
    /// # Arguments
    ///
    /// * `bencher` - divan 计时器。
    #[divan::bench]
    fn random(bencher: Bencher) {
        let reader = memory_reader();
        let picks = random_picks();
        let mut i = 0usize;
        bencher
            .counter(BytesCount::new(UNIVERSES * DMX_LEN))
            .bench_local(|| {
                let out = reader
                    .resolve_frame(black_box(picks[i % RANDOM_PICKS]))
                    .expect("解析帧不应失败");
                i += 1;
                out
            });
    }
}

/// `ArtRecReader::open_file`：打开 64 路 × 5280 帧磁盘文件（读头、Universe 表与帧索引）。
///
/// 吞吐按帧索引条目数计。
///
/// # Arguments
///
/// * `bencher` - divan 计时器。
#[divan::bench]
fn open_file(bencher: Bencher) {
    let path = OPEN_FILE.as_path();
    bencher
        .counter(divan::counter::ItemsCount::new(OPEN_FRAMES))
        .bench(|| ArtRecReader::open_file(divan::black_box(path)).expect("打开基准文件不应失败"));
}
