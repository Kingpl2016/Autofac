//! 确定性随机节目生成与损坏注入（仅测试，不引入随机数依赖）。

use std::collections::{BTreeSet, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use artrec_core::{
    ArtRecReader, ArtRecWriter, CompressAlgo, DiffChange, UniDesc, CHUNKHDR_SIZE, FLAG_DIFF_FRAME,
    MAX_UNIVERSE,
};

/// xorshift64 伪随机数发生器（种子经 splitmix64 打散）。
pub struct XorShift(u64);

impl XorShift {
    pub fn new(seed: u64) -> Self {
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        Self((z ^ (z >> 31)) | 1)
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// `[0, n)` 内的随机数；`n == 0` 时返回 0。
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next_u64() % n
        }
    }

    /// `[lo, hi]` 内的随机数。
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }

    pub fn byte(&mut self) -> u8 {
        (self.next_u64() >> 24) as u8
    }

    /// 以 `pct`% 的概率返回 `true`。
    pub fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }

    pub fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len() as u64) as usize]
    }

    /// 偏向 0 / 255 的通道值。
    fn value(&mut self) -> u8 {
        match self.below(10) {
            0 => 0,
            1 => 255,
            _ => self.byte(),
        }
    }
}

/// 节目类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 未置 ALLOW_DIFF_FRAME，全部为全量帧。
    Full,
    /// 未置 ALLOW_DIFF_FRAME，却混入少量差分帧（应用时被拒绝 → 跳过）。
    StrayDiff,
    /// 置 ALLOW_DIFF_FRAME，全量帧与差分帧混合（并行应回落串行）。
    Diff,
}

/// 随机节目规格。
#[derive(Debug, Clone)]
pub struct Spec {
    pub seed: u64,
    pub unis: usize,
    pub frames: usize,
    pub algo: CompressAlgo,
    pub kind: Kind,
    /// 混入非 512 的 `dmx_len`（含 0、1 与非 32/64 整数倍的长度）。
    pub short_lens: bool,
    /// 每帧被随机损坏的概率（百分比）。
    pub corrupt_pct: u64,
    /// 额外指定要损坏的帧（越界的忽略）。
    pub corrupt: Vec<usize>,
}

impl Spec {
    pub fn new(seed: u64, unis: usize, frames: usize) -> Self {
        Self {
            seed,
            unis,
            frames,
            algo: CompressAlgo::None,
            kind: Kind::Full,
            short_lens: false,
            corrupt_pct: 0,
            corrupt: Vec::new(),
        }
    }
}

/// 生成结果。
pub struct Program {
    pub bytes: Vec<u8>,
    /// 被动过手脚的帧（不保证每个都会解码失败，例如 Zstd 改坏的字节可能不影响输出）。
    pub damaged: BTreeSet<usize>,
}

/// 按规格生成节目字节。
pub fn generate(spec: &Spec) -> Program {
    let mut rng = XorShift::new(spec.seed);
    let mut used = HashSet::new();
    let unis: Vec<UniDesc> = (0..spec.unis)
        .map(|_| {
            let u = loop {
                let u = rng.below(u64::from(MAX_UNIVERSE) + 1) as u16;
                if used.insert(u) {
                    break u;
                }
            };
            let len = if spec.short_lens && rng.chance(40) {
                rng.pick(&[0u16, 1, 2, 24, 31, 33, 63, 64, 65, 100, 255, 300, 511])
            } else {
                512
            };
            UniDesc::from_universe(u, len).unwrap()
        })
        .collect();
    let lens: Vec<usize> = unis.iter().map(|u| usize::from(u.dmx_len)).collect();
    let flags = if spec.kind == Kind::Diff {
        FLAG_DIFF_FRAME
    } else {
        0
    };
    let mut w = ArtRecWriter::new(Cursor::new(Vec::new()), unis, spec.algo, 1, flags, 0).unwrap();

    let mut cur: Vec<Vec<u8>> = lens.iter().map(|&l| vec![0u8; l]).collect();
    let mut t = if rng.chance(50) {
        0
    } else {
        rng.range(1, 3_000_000)
    };
    for i in 0..spec.frames {
        if i > 0 {
            t += match rng.below(100) {
                0..=14 => 0, // 同一时间戳的多帧
                15..=89 => rng.range(1, 40_000),
                90..=97 => rng.range(40_000, 600_000),
                _ => rng.range(1_000_000, 8_000_000), // 长空档：大量空桶
            };
        }
        let edits = random_edits(&mut rng, &lens);
        for &(u, ch, v) in &edits {
            cur[u][ch] = v;
        }
        let as_diff = match spec.kind {
            Kind::Full => false,
            Kind::StrayDiff => i > 0 && rng.chance(10),
            Kind::Diff => i > 0 && rng.chance(70),
        };
        if as_diff {
            let mut changes: Vec<DiffChange> = edits
                .iter()
                .map(|&(u, ch, v)| DiffChange {
                    uni_idx: u as u16,
                    ch_addr: ch as u16,
                    ch_val: v,
                })
                .collect();
            if rng.chance(15) {
                // 越界的 Universe / 通道：读取端应忽略
                changes.push(DiffChange {
                    uni_idx: (lens.len() + 3) as u16,
                    ch_addr: 0,
                    ch_val: rng.byte(),
                });
                changes.push(DiffChange {
                    uni_idx: 0,
                    ch_addr: 600,
                    ch_val: rng.byte(),
                });
            }
            changes.truncate(artrec_core::MAX_DIFF_CHANGES);
            w.add_diff_frame(t, &changes).unwrap();
        } else {
            w.add_full_frame(t, &cur).unwrap();
        }
    }
    let total_us = match rng.below(10) {
        0 => 0,                           // 时长为 0：全部落在第 0 桶
        1 => t / 2,                       // 时长短于最后一帧：超出部分落在末桶
        2 => t,                           // 恰为最后一帧时间
        _ => t + rng.range(0, 2_000_000), // 常规：尾部有空桶
    };
    let mut bytes = w.finish(total_us).unwrap().into_inner();

    let mut damaged = BTreeSet::new();
    for i in 0..spec.frames {
        if rng.chance(spec.corrupt_pct) {
            damaged.insert(i);
        }
    }
    damaged.extend(spec.corrupt.iter().copied().filter(|&i| i < spec.frames));
    corrupt(&mut bytes, &damaged, &mut rng);
    Program { bytes, damaged }
}

/// 一帧的随机修改：`(universe 下标, 通道, 值)`。
fn random_edits(rng: &mut XorShift, lens: &[usize]) -> Vec<(usize, usize, u8)> {
    let live: Vec<usize> = (0..lens.len()).filter(|&u| lens[u] > 0).collect();
    if live.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    match rng.below(100) {
        0..=24 => {} // 与上一帧完全相同
        25..=69 => {
            for _ in 0..rng.range(1, 8) {
                let u = rng.pick(&live);
                out.push((u, rng.below(lens[u] as u64) as usize, rng.value()));
            }
        }
        70..=84 => {
            // 渐变：若干路的一批通道一起变
            for _ in 0..rng.range(1, live.len() as u64) {
                let u = rng.pick(&live);
                let step = rng.range(1, 4) as usize;
                let v = rng.value();
                for ch in (0..lens[u]).step_by(step) {
                    out.push((u, ch, v.wrapping_add(ch as u8)));
                }
            }
        }
        85..=94 => {
            let u = rng.pick(&live);
            for ch in 0..lens[u] {
                out.push((u, ch, rng.byte()));
            }
        }
        _ => {
            // 全场归零或满亮
            let v = if rng.chance(50) { 0 } else { 255 };
            for &u in &live {
                for ch in 0..lens[u] {
                    out.push((u, ch, v));
                }
            }
        }
    }
    out
}

/// 按索引定位并改坏指定帧（多种方式：Payload 位翻转、CRC、块类型、长度字段）。
fn corrupt(bytes: &mut [u8], frames: &BTreeSet<usize>, rng: &mut XorShift) {
    if frames.is_empty() {
        return;
    }
    let r = ArtRecReader::open(bytes.to_vec()).unwrap();
    let pool = r.header().chunk_pool_offset as usize;
    for &i in frames {
        let fi = r.index()[i];
        let base = pool + fi.chunk_pos as usize;
        let cmp = usize::from(u16::from_be_bytes([bytes[base + 4], bytes[base + 5]]));
        match rng.below(10) {
            0..=5 if cmp > 0 => {
                let off = base + CHUNKHDR_SIZE + rng.below(cmp as u64) as usize;
                bytes[off] ^= 1 << rng.below(8);
            }
            6 => bytes[base + 7] ^= 0x5A, // CRC 字段
            7 => bytes[base + 1] ^= 1,    // 块类型：全量 ↔ 差分
            8 => bytes[base + 3] ^= 0x10, // payload_raw_sz
            _ => bytes[base + 5] ^= 0x01, // payload_cmp_sz：与索引不一致 → 读取回退路径
        }
    }
}

/// 测试用临时文件，离开作用域时删除。
pub struct TempFile(PathBuf);

impl TempFile {
    pub fn new(bytes: &[u8]) -> Self {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "player-eq-{}-{}.artrec",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, bytes).unwrap();
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
