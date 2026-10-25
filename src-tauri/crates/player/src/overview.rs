//! 时间线概览（热力图数据）：整段节目按时间分桶，统计每路 Universe 的变化强度与最大电平。
//!
//! 概览在打开节目时由后台线程扫描一次生成，并缓存到 sidecar；前端只拿到固定大小的
//! 字节矩阵（Universe × 桶），用 `<canvas>` 绘制，不需要加载整个节目。

use std::io::{Read, Seek};

use artrec_core::ArtRecReader;
use serde::{Deserialize, Serialize};

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
    pub change: Vec<Vec<u8>>,
    /// 最大电平矩阵：`level[universe 行][桶]`，该桶内该 Universe 出现过的最大通道值。
    #[serde(with = "crate::b64::rows")]
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
fn bucket_of(t: u64, duration: u64, buckets: usize) -> usize {
    if duration == 0 {
        return 0;
    }
    let b = (u128::from(t) * buckets as u128 / u128::from(duration)) as usize;
    b.min(buckets - 1)
}

/// 扫描整段节目生成概览。
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
    let n = reader.unis().len();
    let duration = reader.header().total_duration_us;

    let mut counts = vec![vec![0u32; nb]; n];
    let mut level = vec![vec![0u8; nb]; n];
    let mut prev: Vec<Vec<u8>> = reader.zero_buffers();
    let mut cur_max = vec![0u8; n];
    let mut last_b = 0usize;

    let mut walker = FrameWalker::new(reader);
    while let Some(t) = walker.advance() {
        let bi = bucket_of(t, duration, nb);
        for u in 0..n {
            // 上一状态在 (last_b, bi) 之间的空桶里一直保持
            if bi > last_b + 1 {
                level[u][(last_b + 1)..bi].fill(cur_max[u]);
            }
            // 进入本桶时，帧生效前的状态也属于本桶
            level[u][bi] = level[u][bi].max(cur_max[u]);

            let now_buf = &walker.buffers()[u];
            let changed = now_buf
                .iter()
                .zip(&prev[u])
                .filter(|(a, b)| a != b)
                .count();
            counts[u][bi] = counts[u][bi].saturating_add(changed as u32);
            let m = now_buf.iter().copied().max().unwrap_or(0);
            level[u][bi] = level[u][bi].max(m);
            cur_max[u] = m;
            prev[u].clone_from(now_buf);
        }
        last_b = last_b.max(bi);
    }
    // 最后一帧之后的桶保持最终状态
    for (row, &m) in level.iter_mut().zip(&cur_max) {
        if last_b + 1 < nb {
            row[(last_b + 1)..].fill(m);
        }
    }

    let max_count = counts.iter().flatten().copied().max().unwrap_or(0);
    let change = counts
        .iter()
        .map(|row| row.iter().map(|&c| scale(c, max_count)).collect())
        .collect();

    Overview {
        version: OVERVIEW_VERSION,
        duration_us: duration,
        buckets,
        universes: reader.unis().iter().map(|u| u.universe).collect(),
        change,
        level,
        frames: reader.index().len() as u64,
        skipped_frames: walker.skipped(),
        file_bytes: reader.file_len(),
    }
}

/// 把计数按平方根刻度映射到 `0..=255`；非零值至少为 1 以免被淹没。
fn scale(c: u32, max: u32) -> u8 {
    if c == 0 || max == 0 {
        return 0;
    }
    let v = 254.0 * f64::from(c).sqrt() / f64::from(max).sqrt();
    // 已钳制到 [1, 255]，转换不会丢失符号或溢出
    #[allow(clippy::cast_sign_loss)]
    let out = (1.0 + v).round().clamp(1.0, 255.0) as u8;
    out
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
            &[(0, vec![(0, 0, 200)]), (550_000, vec![(0, 0, 0), (1, 1, 100)])],
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
        assert!(json.contains("\"level\":[\""), "矩阵应序列化为 Base64 字符串: {json}");
        let back: Overview = serde_json::from_str(&json).unwrap();
        assert_eq!(back, o);
        assert!(back.matches(r.file_len(), 1));
        assert!(!back.matches(r.file_len() + 1, 1));
        assert!(!back.matches(r.file_len(), 2));
    }

    #[test]
    fn scale_is_monotonic_and_keeps_nonzero_visible() {
        assert_eq!(scale(0, 100), 0);
        assert_eq!(scale(1, 1_000_000), 1, "极稀疏的变化也至少为 1，不会被当作无变化");
        let a = scale(1, 100);
        let b = scale(50, 100);
        let c = scale(100, 100);
        assert!(a >= 1 && a < b && b < c && c == 255);
    }
}
