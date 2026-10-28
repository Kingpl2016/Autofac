//! 压缩与帧策略基准测试：用合成码流对比各编码配置的文件体积、写入耗时与 seek 回溯长度。
//!
//! 运行：`cargo run --release -p recorder --example bench`
//!
//! 码流模式：
//! - static：几乎静止，每 2 秒有一个通道变化；
//! - fade：50 台 RGB 灯具（每台 3 通道）同时缓慢渐变，每帧约 150 通道变化；
//! - chase：单通道逐个点亮的跑马灯，每帧 2 通道变化；
//! - random：全部通道每帧随机（最坏情况，几乎不可压缩）。

#![allow(clippy::cast_precision_loss)]

use std::io::Cursor;
use std::time::Instant;

use artrec_core::{ArtRecReader, ArtRecWriter, CompressAlgo, UniDesc};
use recorder::{EncoderConfig, FrameEncoder};

const FPS: u64 = 44;
const SECONDS: u64 = 60;

/// 简易确定性伪随机（xorshift），避免引入额外依赖。
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

#[derive(Clone, Copy)]
enum Pattern {
    Static,
    Fade,
    Chase,
    Random,
}

impl Pattern {
    fn name(self) -> &'static str {
        match self {
            Pattern::Static => "static",
            Pattern::Fade => "fade",
            Pattern::Chase => "chase",
            Pattern::Random => "random",
        }
    }
}

/// 生成第 `frame` 帧的 `n` 路 Universe 数据。
fn gen_frame(pattern: Pattern, n: usize, frame: u64, rng: &mut Rng) -> Vec<Vec<u8>> {
    let mut out = vec![vec![0u8; 512]; n];
    for (ui, buf) in out.iter_mut().enumerate() {
        match pattern {
            Pattern::Static => {
                buf[0] = 255;
                buf[100] = 128;
                // 每 2 秒（88 帧）翻转一个通道
                buf[200] = ((frame / (FPS * 2)) % 2) as u8 * 200;
            }
            Pattern::Fade => {
                for fixture in 0..170usize {
                    let phase = (frame as usize + fixture * 3 + ui * 7) % 512;
                    let v = if phase < 256 { phase } else { 511 - phase } as u8;
                    buf[fixture * 3] = v;
                    buf[fixture * 3 + 1] = v / 2;
                    buf[fixture * 3 + 2] = 255 - v;
                }
            }
            Pattern::Chase => {
                let pos = (frame as usize + ui * 11) % 512;
                buf[pos] = 255;
            }
            Pattern::Random => {
                for b in buf.iter_mut() {
                    *b = (rng.next() & 0xFF) as u8;
                }
            }
        }
    }
    out
}

struct Row {
    size: usize,
    millis: f64,
    max_chain: u32,
    frames: usize,
    ok: bool,
}

fn run(pattern: Pattern, n: usize, cfg: EncoderConfig) -> Row {
    let unis: Vec<UniDesc> = (0..n as u16)
        .map(|u| UniDesc::from_universe(u, 512).unwrap())
        .collect();
    let mut w = ArtRecWriter::new(
        Cursor::new(Vec::new()),
        unis,
        cfg.algo,
        cfg.level,
        cfg.file_flags(),
        0,
    )
    .unwrap();
    let mut enc = FrameEncoder::new(cfg);
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let period_us = 1_000_000 / FPS;

    // 预生成样本用于最终校验（仅抽查若干帧，避免占用过多内存）
    let mut samples: Vec<(u64, Vec<Vec<u8>>)> = Vec::new();
    let t0 = Instant::now();
    for f in 0..FPS * SECONDS {
        let t = f * period_us;
        let data = gen_frame(pattern, n, f, &mut rng);
        if enc.encode(&mut w, t, &data).unwrap().is_some() && f % 97 == 0 {
            samples.push((t, data));
        }
    }
    let total = FPS * SECONDS * period_us;
    enc.encode_tail(&mut w, total).unwrap();
    let frames = w.frame_count();
    let bytes = w.finish(total).unwrap().into_inner();
    let millis = t0.elapsed().as_secs_f64() * 1000.0;

    let size = bytes.len();
    let reader = ArtRecReader::open(bytes).unwrap();
    let ok = samples
        .iter()
        .all(|(t, d)| reader.frame_at(*t).unwrap().as_ref() == Some(d));
    Row {
        size,
        millis,
        max_chain: enc.max_chain(),
        frames,
        ok,
    }
}

fn main() {
    let configs: [(&str, EncoderConfig); 5] = [
        (
            "None/全量",
            EncoderConfig {
                algo: CompressAlgo::None,
                allow_diff: false,
                ..EncoderConfig::default()
            },
        ),
        (
            "None/差分+1s关键帧",
            EncoderConfig {
                algo: CompressAlgo::None,
                allow_diff: true,
                ..EncoderConfig::default()
            },
        ),
        (
            "Zstd1/差分+1s关键帧",
            EncoderConfig {
                algo: CompressAlgo::Zstd,
                level: 1,
                allow_diff: true,
                ..EncoderConfig::default()
            },
        ),
        (
            "Zstd3/差分+1s关键帧",
            EncoderConfig {
                algo: CompressAlgo::Zstd,
                level: 3,
                allow_diff: true,
                ..EncoderConfig::default()
            },
        ),
        (
            "Zstd3/全量",
            EncoderConfig {
                algo: CompressAlgo::Zstd,
                level: 3,
                allow_diff: false,
                ..EncoderConfig::default()
            },
        ),
    ];

    println!("{FPS}Hz × {SECONDS}s，单位 KiB / ms / 帧数 / 最长链");
    for pattern in [Pattern::Static, Pattern::Fade, Pattern::Chase, Pattern::Random] {
        for n in [1usize, 10, 50] {
            println!("\n== {} × {} Universe ==", pattern.name(), n);
            for (name, cfg) in &configs {
                let r = run(pattern, n, *cfg);
                println!(
                    "{:<22} {:>10.1} KiB {:>8.0} ms {:>6} 帧 链 {:>3} {}",
                    name,
                    r.size as f64 / 1024.0,
                    r.millis,
                    r.frames,
                    r.max_chain,
                    if r.ok { "✓" } else { "✗ 校验失败" }
                );
            }
        }
    }
}
