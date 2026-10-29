//! 时间线概览（热力图数据）：整段节目按时间分桶，统计每路 Universe 的变化强度与最大电平。
//!
//! 概览在打开节目时由后台线程扫描一次生成，并缓存到二进制文件 `名称.artrec.ovw`（编解码见
//! [`crate::ovw`]）；前端只拿到固定大小的
//! 字节矩阵（Universe × 桶），用 `<canvas>` 绘制，不需要加载整个节目。

use std::io::{Read, Seek};

use artrec_core::ArtRecReader;
use serde::{Deserialize, Serialize};

use crate::kernels::{count_diff, max_byte};
use crate::walker::FrameWalker;

/// 概览格式版本；算法或字段变化时递增，旧缓存自动失效。
pub const OVERVIEW_VERSION: u32 = 1;
/// 默认桶数（够覆盖常见屏宽，且单路仅 1 KiB）。
pub const DEFAULT_BUCKETS: u32 = 1024;
/// 允许的桶数范围。
pub const MIN_BUCKETS: u32 = 16;
/// 允许的最大桶数。
pub const MAX_BUCKETS: u32 = 4096;

/// 时间线概览。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Overview {
    /// 概览格式版本。
    pub version: u32,
    /// 节目总时长（微秒）。
    pub duration_us: u64,
    /// 时间桶数。
    pub buckets: u32,
    /// 各行对应的 Universe 编号。
    pub universes: Vec<u16>,
    /// 变化强度矩阵：`change[universe 行][桶]`，0 = 无变化，255 = 变化最密集（平方根刻度）。
    #[serde(with = "crate::b64::rows")]
    #[cfg_attr(feature = "ts", ts(type = "Array<string>"))]
    pub change: Vec<Vec<u8>>,
    /// 最大电平矩阵：`level[universe 行][桶]`，该桶内该 Universe 出现过的最大通道值。
    #[serde(with = "crate::b64::rows")]
    #[cfg_attr(feature = "ts", ts(type = "Array<string>"))]
    pub level: Vec<Vec<u8>>,
    /// 节目帧数。
    pub frames: u64,
    /// 扫描时被跳过的损坏帧数。
    pub skipped_frames: u64,
    /// 生成概览时的文件字节数，用于判断缓存是否仍与文件匹配。
    pub file_bytes: u64,
}

impl Overview {
    /// 缓存是否仍适用于当前文件（版本、文件大小、帧数都一致）。
    ///
    /// # Arguments
    ///
    /// * `file_bytes` - 当前文件的字节数。
    /// * `frames` - 当前文件的帧数。
    ///
    /// # Returns
    ///
    /// 概览版本等于 [`OVERVIEW_VERSION`]，且 `file_bytes` 与 `frames` 均与缓存一致时返回 `true`，否则返回 `false`。
    #[must_use]
    pub fn matches(&self, file_bytes: u64, frames: u64) -> bool {
        self.version == OVERVIEW_VERSION && self.file_bytes == file_bytes && self.frames == frames
    }
}

/// 时间 `t` 所在的桶下标。
///
/// # Arguments
///
/// * `t` - 帧时间戳（微秒）。
/// * `duration` - 节目总时长（微秒）；为 0 时所有帧都落在第 0 桶。
/// * `buckets` - 桶数（不小于 1）。
///
/// # Returns
///
/// `[0, buckets)` 内的桶下标；超出总时长的帧落在最后一桶。随 `t` 单调不减。
pub(crate) fn bucket_of(t: u64, duration: u64, buckets: usize) -> usize {
    if duration == 0 {
        return 0;
    }
    let b = (u128::from(t) * buckets as u128 / u128::from(duration)) as usize;
    b.min(buckets.saturating_sub(1))
}

/// 一段连续帧的桶累积器：逐帧执行与串行概览完全相同的运算，只写 `[lo, hi]` 内的桶。
///
/// 串行概览用一个覆盖 `[0, buckets)` 的累积器跑完全部帧；并行概览让每段各用一个
/// 累积器，初始状态取"该段第一帧之前"的串行状态，最后按"计数饱和相加、电平取最大"
/// 合并。电平的所有写入（空桶延续、桶首并入旧状态、帧最大值）都等价于"与某值取最大"
/// （空桶在被延续前必为 0），计数是非负数的饱和累加，两者都与合并顺序无关，
/// 因此合并结果与串行逐字节一致。
pub(crate) struct BucketAccum {
    /// 全局桶数。
    nb: usize,
    /// 节目总时长（微秒）。
    duration: u64,
    /// 本累积器负责的最小桶下标（局部数组的起点）。
    lo: usize,
    /// 局部桶数（`hi - lo + 1`）。
    width: usize,
    /// 变化计数：`counts[u * width + (b - lo)]`。
    counts: Vec<u32>,
    /// 最大电平：`level[u * width + (b - lo)]`。
    level: Vec<u8>,
    /// 上一帧各路状态（比较基准）。
    prev: Vec<Vec<u8>>,
    /// 上一帧各路最大值（恒等于 `prev` 各路的最大字节）。
    cur_max: Vec<u8>,
    /// 已处理帧所在的最大桶下标（全局下标）。
    last_b: usize,
}

impl BucketAccum {
    /// 以给定的"段首之前"状态创建累积器。
    ///
    /// # Arguments
    ///
    /// * `nb` - 全局桶数（不小于 1）。
    /// * `duration` - 节目总时长（微秒）。
    /// * `last_b` - 段首之前串行算法的 `last_b`（即前一帧所在的桶；整段从第 0 帧开始时为 0），
    ///   同时作为局部数组起点。
    /// * `hi` - 本段会写到的最大桶下标（含）；负责"末尾延续"的累积器须为 `nb - 1`。
    /// * `prev` - 段首之前的各路状态（串行时为全零缓冲）。
    ///
    /// # Returns
    ///
    /// 计数与电平全零、`cur_max` 由 `prev` 求得的累积器。
    pub(crate) fn new(
        nb: usize,
        duration: u64,
        last_b: usize,
        hi: usize,
        prev: Vec<Vec<u8>>,
    ) -> Self {
        let lo = last_b.min(nb.saturating_sub(1));
        let width = hi.max(lo).min(nb.saturating_sub(1)) - lo + 1;
        let n = prev.len();
        let cur_max = prev.iter().map(|b| max_byte(b)).collect();
        Self {
            nb,
            duration,
            lo,
            width,
            counts: vec![0; n * width],
            level: vec![0; n * width],
            prev,
            cur_max,
            last_b: lo,
        }
    }

    /// 累积一帧（与改动前串行概览的循环体逐项等价）。
    ///
    /// # Arguments
    ///
    /// * `t` - 帧时间戳（微秒）。
    /// * `applied` - 该帧是否成功应用；被跳过的帧状态未变，只做空桶延续与桶首并入。
    /// * `now` - 应用该帧后的各路状态（形状与 `prev` 一致）。
    pub(crate) fn frame(&mut self, t: u64, applied: bool, now: &[Vec<u8>]) {
        let bi = bucket_of(t, self.duration, self.nb);
        debug_assert!(
            bi >= self.last_b && bi < self.lo + self.width,
            "桶下标越出累积范围"
        );
        // 局部下标；对合法输入钳制不改变任何值，只为杜绝越界
        let bl = bi.saturating_sub(self.lo).min(self.width - 1);
        let lbl = self.last_b - self.lo;
        let w = self.width;
        let rows = self
            .level
            .chunks_exact_mut(w)
            .zip(self.counts.chunks_exact_mut(w));
        for (((row, crow), (p, a)), cm) in rows
            .zip(self.prev.iter_mut().zip(now))
            .zip(self.cur_max.iter_mut())
        {
            // 上一状态在 (last_b, bi) 之间的空桶里一直保持
            if bl > lbl + 1 {
                row[(lbl + 1)..bl].fill(*cm);
            }
            // 进入本桶时，帧生效前的状态也属于本桶
            let mut cell = row[bl].max(*cm);
            // 相等（含被跳过的帧）时变化数为 0、最大值不变，无需逐字节比较
            if applied && a.as_slice() != p.as_slice() {
                crow[bl] = crow[bl].saturating_add(count_diff(a, p));
                let m = max_byte(a);
                cell = cell.max(m);
                *cm = m;
                p.clone_from(a);
            }
            row[bl] = cell;
        }
        self.last_b = self.last_b.max(self.lo + bl);
    }

    /// 最后一帧之后的桶保持最终状态（只由覆盖到末桶的累积器调用一次）。
    pub(crate) fn finish_tail(&mut self) {
        let start = self.last_b - self.lo + 1;
        if start < self.width {
            for (row, &m) in self.level.chunks_exact_mut(self.width).zip(&self.cur_max) {
                row[start..].fill(m);
            }
        }
    }

    /// 把本累积器的结果并入全局矩阵：计数饱和相加，电平取最大。
    ///
    /// # Arguments
    ///
    /// * `counts` - 全局变化计数，`counts[u * nb + b]`。
    /// * `level` - 全局最大电平，`level[u * nb + b]`。
    pub(crate) fn merge_into(&self, counts: &mut [u32], level: &mut [u8]) {
        let (lo, w) = (self.lo, self.width);
        let src = self.counts.chunks_exact(w).zip(self.level.chunks_exact(w));
        let dst = counts
            .chunks_exact_mut(self.nb)
            .zip(level.chunks_exact_mut(self.nb));
        for ((sc, sl), (dc, dl)) in src.zip(dst) {
            for (d, &s) in dc[lo..lo + w].iter_mut().zip(sc) {
                *d = d.saturating_add(s);
            }
            for (d, &s) in dl[lo..lo + w].iter_mut().zip(sl) {
                *d = (*d).max(s);
            }
        }
    }

    /// 取出覆盖全部桶（`lo == 0`、`hi == nb - 1`）的累积结果。
    ///
    /// # Returns
    ///
    /// `(counts, level)`，均为 `[u * nb + b]` 布局。
    pub(crate) fn into_full(self) -> (Vec<u32>, Vec<u8>) {
        debug_assert!(
            self.lo == 0 && self.width == self.nb,
            "只有覆盖全部桶的累积器可直接取出"
        );
        (self.counts, self.level)
    }
}

/// 由全局计数 / 电平矩阵组装概览（串行与并行共用）。
///
/// # Arguments
///
/// * `reader` - 已打开的节目（提供头、Universe 表、帧数与文件大小）。
/// * `buckets` - 已钳制的桶数。
/// * `counts` - 变化计数，`[u * buckets + b]`。
/// * `level` - 最大电平，`[u * buckets + b]`。
/// * `skipped` - 被跳过的损坏帧数。
///
/// # Returns
///
/// 变化强度已按全局最大计数映射到 `0..=255` 的概览。
pub(crate) fn assemble_overview<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    buckets: u32,
    counts: &[u32],
    level: &[u8],
    skipped: u64,
) -> Overview {
    let nb = (buckets as usize).max(1);
    let max_count = counts.iter().copied().max().unwrap_or(0);
    let change = counts
        .chunks_exact(nb)
        .map(|row| row.iter().map(|&c| scale(c, max_count)).collect())
        .collect();
    Overview {
        version: OVERVIEW_VERSION,
        duration_us: reader.header().total_duration_us,
        buckets,
        universes: reader.unis().iter().map(|u| u.universe).collect(),
        change,
        level: level.chunks_exact(nb).map(<[u8]>::to_vec).collect(),
        frames: reader.index().len() as u64,
        skipped_frames: skipped,
        file_bytes: reader.file_len(),
    }
}

/// 扫描整段节目生成概览。
///
/// 单线程顺序解码：复用原始 Payload 与各路缓冲，逐帧比较与求最大值走可向量化的内循环，
/// 各路状态未变（含被跳过的帧）时直接跳过逐字节比较。磁盘上的大文件请优先用
/// [`crate::build_overview_parallel`]。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `buckets` - 期望桶数，会被钳制到 `[MIN_BUCKETS, MAX_BUCKETS]`。
///
/// # Returns
///
/// 概览数据。损坏的帧被跳过并计数，不会让扫描失败。
#[must_use]
pub fn build_overview<R: Read + Seek>(reader: &ArtRecReader<R>, buckets: u32) -> Overview {
    let buckets = buckets.clamp(MIN_BUCKETS, MAX_BUCKETS);
    let nb = buckets as usize;
    let duration = reader.header().total_duration_us;

    let mut acc = BucketAccum::new(nb, duration, 0, nb - 1, reader.zero_buffers());
    let mut walker = FrameWalker::new(reader);
    while let Some((t, applied)) = walker.advance_applied() {
        acc.frame(t, applied, walker.buffers());
    }
    acc.finish_tail();
    let (counts, level) = acc.into_full();
    assemble_overview(reader, buckets, &counts, &level, walker.skipped())
}

/// 把计数按平方根刻度映射到 `0..=255`；非零值至少为 1 以免被淹没。
fn scale(c: u32, max: u32) -> u8 {
    if c == 0 || max == 0 {
        return 0;
    }
    let v = 254.0 * f64::from(c).sqrt() / f64::from(max).sqrt();
    // 已钳制到 [1, 255]，转换不会丢失符号或溢出
    (1.0 + v).round().clamp(1.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use artrec_core::CompressAlgo;

    use super::{build_overview, scale, Overview, MIN_BUCKETS};
    use crate::walker::testkit::{build_full, open};

    #[test]
    fn levels_hold_between_frames_and_changes_land_in_the_right_bucket() {
        // 16 个桶 × 62.5ms：t=0 → u0[0]=200；t=550ms → u0[0]=0 且 u1[1]=100
        let bytes = build_full(
            2,
            &[
                (0, vec![(0, 0, 200)]),
                (550_000, vec![(0, 0, 0), (1, 1, 100)]),
            ],
            1_000_000,
            CompressAlgo::Zstd,
        );
        let o = build_overview(&open(bytes), MIN_BUCKETS);
        assert_eq!(o.buckets, 16);
        assert_eq!(o.universes, vec![0, 1]);
        let split = (550_000u64 * 16 / 1_000_000) as usize; // 550ms 所在的桶 = 8

        // u0 的电平：550ms 之前（含所在桶，因为帧生效前的状态也属于该桶）为 200，之后为 0
        for b in 0..=split {
            assert_eq!(o.level[0][b], 200, "bucket {b}");
        }
        for b in (split + 1)..16 {
            assert_eq!(o.level[0][b], 0, "bucket {b}");
        }
        // u1 的电平：550ms 之前为 0，所在桶及之后为 100
        for b in 0..split {
            assert_eq!(o.level[1][b], 0, "bucket {b}");
        }
        for b in split..16 {
            assert_eq!(o.level[1][b], 100, "bucket {b}");
        }
        // 变化只出现在两个帧所在的桶
        assert!(o.change[0][0] > 0 && o.change[0][split] > 0);
        assert!(o.change[1][split] > 0);
        assert_eq!(o.change[1][0], 0);
        assert_eq!(o.change[0][3], 0);
        assert_eq!((o.frames, o.skipped_frames), (2, 0));
    }

    #[test]
    fn busier_buckets_score_higher() {
        // 桶 0 只改 1 个通道，桶 8 改 100 个通道
        let heavy: Vec<(usize, usize, u8)> = (0..100).map(|c| (0, c, 9)).collect();
        let bytes = build_full(
            1,
            &[(0, vec![(0, 0, 1)]), (500_000, heavy)],
            1_000_000,
            CompressAlgo::Zstd,
        );
        let o = build_overview(&open(bytes), 16);
        assert!(o.change[0][8] > o.change[0][0]);
        assert_eq!(o.change[0][8], 255, "最大值映射到 255");
    }

    #[test]
    fn empty_program_gives_blank_overview() {
        let o = build_overview(&open(build_full(1, &[], 0, CompressAlgo::None)), 32);
        assert_eq!(o.frames, 0);
        assert!(o.level[0].iter().all(|&v| v == 0));
        assert!(o.change[0].iter().all(|&v| v == 0));
    }

    #[test]
    fn json_roundtrip_uses_base64_rows_and_cache_matching() {
        let bytes = build_full(1, &[(0, vec![(0, 0, 77)])], 1_000_000, CompressAlgo::None);
        let r = open(bytes);
        let o = build_overview(&r, 16);
        let json = serde_json::to_string(&o).unwrap();
        assert!(
            json.contains("\"level\":[\""),
            "矩阵应序列化为 Base64 字符串: {json}"
        );
        let back: Overview = serde_json::from_str(&json).unwrap();
        assert_eq!(back, o);
        assert!(back.matches(r.file_len(), 1));
        assert!(!back.matches(r.file_len() + 1, 1));
        assert!(!back.matches(r.file_len(), 2));
    }

    #[test]
    fn scale_is_monotonic_and_keeps_nonzero_visible() {
        assert_eq!(scale(0, 100), 0);
        assert_eq!(
            scale(1, 1_000_000),
            1,
            "极稀疏的变化也至少为 1，不会被当作无变化"
        );
        let a = scale(1, 100);
        let b = scale(50, 100);
        let c = scale(100, 100);
        assert!(a >= 1 && a < b && b < c && c == 255);
    }
}
