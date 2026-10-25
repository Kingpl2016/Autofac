//! 帧编码策略：变更检测、差分/全量帧自适应选择与关键帧间隔。
//!
//! 录制端按"变更触发"写帧（规范 §8.2 推荐）：数据与上一帧完全一致则不写；
//! 变更点较少时写差分帧，否则写全量帧；距上一个全量帧超过关键帧间隔时强制写
//! 全量帧，从而把 seek 的最坏回溯长度限制在一个关键帧间隔之内。

use std::io::{Seek, Write};

use artrec_core::{
    ArtRecWriter, CompressAlgo, DiffChange, FrameIndex, Result, FLAG_DIFF_FRAME, MAX_DIFF_CHANGES,
};

/// 默认关键帧间隔：1 秒。
pub const DEFAULT_KEYFRAME_INTERVAL_US: u64 = 1_000_000;
/// 差分帧原始字节占全量帧原始字节比例的分母：差分负载超过全量的 `1/N` 就改写全量帧。
pub const DEFAULT_DIFF_RATIO_DIV: usize = 4;

/// 帧类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    /// 全量帧。
    Full,
    /// 差分帧。
    Diff,
}

/// 编码器配置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderConfig {
    /// 压缩算法。
    pub algo: CompressAlgo,
    /// Zstd 压缩等级（无压缩忽略）。
    pub level: u8,
    /// 是否允许差分帧（会在文件头置 ALLOW_DIFF_FRAME 标志）。
    pub allow_diff: bool,
    /// 关键帧间隔（微秒）；0 表示每次变更都写全量帧。
    pub keyframe_interval_us: u64,
    /// 差分负载上限比例的分母，见 [`DEFAULT_DIFF_RATIO_DIV`]。
    pub diff_ratio_div: usize,
}

/// 默认配置依据 `examples/bench.rs` 的基准结果（44Hz × 60s，1/10/50 个 Universe）：
///
/// - Zstd 对稀疏 DMX 全量帧压缩极好（静止 50 个 Universe 仅 ≈2.6 KiB，跑马灯 50 个
///   Universe ≈157 KiB），而差分帧每个变更点固定 5 字节且几乎不可再压缩，
///   Zstd 下差分帧**从未显著优于**全量帧（跑马灯 50 个 Universe 差分 ≈976 KiB，反而约大 6 倍）。
/// - "无压缩 + 差分"只在变更点很少时有优势，但体积仍远大于 Zstd 全量帧。
/// - 差分帧是规范中的可选扩展，**不支持的解析器必须拒绝打开**置位了
///   `ALLOW_DIFF_FRAME` 的文件，核心板固件是否支持尚未确认。
///
/// 因此默认使用 `Zstd L3 + 仅全量帧`：体积最优或接近最优，且不依赖固件对差分帧的支持；
/// 每个变更帧天然都是关键帧，seek 无需回溯。差分模式保留为可选项。
impl Default for EncoderConfig {
    fn default() -> Self {
        Self {
            algo: CompressAlgo::Zstd,
            level: 3,
            allow_diff: false,
            keyframe_interval_us: DEFAULT_KEYFRAME_INTERVAL_US,
            diff_ratio_div: DEFAULT_DIFF_RATIO_DIV,
        }
    }
}

impl EncoderConfig {
    /// 与本配置对应的文件头 flags。
    ///
    /// # Returns
    ///
    /// `allow_diff` 为 `true` 时返回 `FLAG_DIFF_FRAME`，否则返回 `0`。
    #[must_use]
    pub fn file_flags(&self) -> u32 {
        if self.allow_diff {
            FLAG_DIFF_FRAME
        } else {
            0
        }
    }
}

/// 一次编码的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Encoded {
    /// 写入的帧类型。
    pub kind: FrameKind,
    /// 追加的帧索引条目。
    pub index: FrameIndex,
}

/// 帧编码器：维护"上一帧"影子缓冲与关键帧计时。
#[derive(Debug, Default)]
pub struct FrameEncoder {
    cfg: EncoderConfig,
    last: Option<Vec<Vec<u8>>>,
    last_key_us: u64,
    chain: u32,
    max_chain: u32,
    full_frames: u64,
    diff_frames: u64,
}

impl FrameEncoder {
    /// 以配置创建编码器。
    ///
    /// # Arguments
    ///
    /// * `cfg` - 编码器配置。
    ///
    /// # Returns
    ///
    /// 使用 `cfg` 且计数与影子缓冲均为初始状态的新 [`FrameEncoder`]。
    #[must_use]
    pub fn new(cfg: EncoderConfig) -> Self {
        Self {
            cfg,
            ..Self::default()
        }
    }

    /// 配置。
    ///
    /// # Returns
    ///
    /// 创建时传入的 [`EncoderConfig`] 的只读引用。
    #[must_use]
    pub fn config(&self) -> &EncoderConfig {
        &self.cfg
    }

    /// 已写全量帧数。
    ///
    /// # Returns
    ///
    /// 迄今写入的全量帧累计数量。
    #[must_use]
    pub fn full_frames(&self) -> u64 {
        self.full_frames
    }

    /// 已写差分帧数。
    ///
    /// # Returns
    ///
    /// 迄今写入的差分帧累计数量。
    #[must_use]
    pub fn diff_frames(&self) -> u64 {
        self.diff_frames
    }

    /// 观测到的最长"关键帧 + 连续差分帧"链长度（seek 最坏回溯帧数）。
    ///
    /// # Returns
    ///
    /// 迄今观测到的最长链的帧数；尚未写帧时为 `0`。
    #[must_use]
    pub fn max_chain(&self) -> u32 {
        self.max_chain
    }

    /// 与上一帧逐通道比较，收集变更点。
    fn diff_against(last: &[Vec<u8>], cur: &[Vec<u8>]) -> Vec<DiffChange> {
        let mut out = Vec::new();
        for (ui, (a, b)) in last.iter().zip(cur).enumerate() {
            if a == b {
                continue;
            }
            for (ch, (&x, &y)) in a.iter().zip(b).enumerate() {
                if x != y {
                    out.push(DiffChange {
                        uni_idx: ui as u16,
                        ch_addr: ch as u16,
                        ch_val: y,
                    });
                }
            }
        }
        out
    }

    /// 编码并写入一帧。数据与上一帧相同则返回 `Ok(None)` 不写。
    ///
    /// # Arguments
    ///
    /// * `w` - 目标写入器。
    /// * `time_us` - 本帧相对录制起点的时间戳（微秒）。
    /// * `current` - 与 UniDesc 一一对应的各路当前 DMX 缓冲。
    ///
    /// # Returns
    ///
    /// 写入了帧则返回 [`Encoded`]，数据无变化返回 `None`。
    ///
    /// # Errors
    ///
    /// 写入器返回的各类 [`artrec_core::ArtRecError`]。
    pub fn encode<W: Write + Seek>(
        &mut self,
        w: &mut ArtRecWriter<W>,
        time_us: u64,
        current: &[Vec<u8>],
    ) -> Result<Option<Encoded>> {
        let Some(last) = self.last.as_ref() else {
            return self.write_full(w, time_us, current).map(Some);
        };
        let changes = Self::diff_against(last, current);
        if changes.is_empty() {
            return Ok(None);
        }

        let key_due = self.cfg.keyframe_interval_us == 0
            || time_us.saturating_sub(self.last_key_us) >= self.cfg.keyframe_interval_us;
        let total: usize = current.iter().map(Vec::len).sum();
        let diff_bytes = 2 + changes.len() * 5;
        let use_diff = self.cfg.allow_diff
            && !key_due
            && changes.len() <= MAX_DIFF_CHANGES
            && diff_bytes <= total / self.cfg.diff_ratio_div.max(1);

        if use_diff {
            self.write_diff(w, time_us, &changes, current).map(Some)
        } else {
            self.write_full(w, time_us, current).map(Some)
        }
    }

    /// 在录制结束时补写"收尾帧"，使最后一帧索引的时间戳等于总时长（规范 §8.3）。
    ///
    /// 内容与上一帧相同：允许差分时写 0 变更的差分帧，否则复写一份全量帧。
    /// 若最后一帧时间戳已不小于 `time_us`，或尚未写过任何帧，则什么也不做。
    ///
    /// # Arguments
    ///
    /// * `w` - 目标写入器。
    /// * `time_us` - 收尾帧相对录制起点的时间戳（微秒），通常为录制总时长。
    ///
    /// # Returns
    ///
    /// 补写了收尾帧则返回 `Some(`[`Encoded`]`)`；尚未写过任何帧，或最后一帧时间戳已不小于 `time_us` 时返回 `None`。
    ///
    /// # Errors
    ///
    /// 写入器返回的各类 [`artrec_core::ArtRecError`]。
    pub fn encode_tail<W: Write + Seek>(
        &mut self,
        w: &mut ArtRecWriter<W>,
        time_us: u64,
    ) -> Result<Option<Encoded>> {
        let Some(last) = self.last.clone() else {
            return Ok(None);
        };
        if w.last_time_us().is_some_and(|t| t >= time_us) {
            return Ok(None);
        }
        if self.cfg.allow_diff {
            self.write_diff(w, time_us, &[], &last).map(Some)
        } else {
            self.write_full(w, time_us, &last).map(Some)
        }
    }

    fn write_full<W: Write + Seek>(
        &mut self,
        w: &mut ArtRecWriter<W>,
        time_us: u64,
        current: &[Vec<u8>],
    ) -> Result<Encoded> {
        let index = w.add_full_frame(time_us, current)?;
        self.last = Some(current.to_vec());
        self.last_key_us = time_us;
        self.chain = 1;
        self.max_chain = self.max_chain.max(1);
        self.full_frames += 1;
        Ok(Encoded {
            kind: FrameKind::Full,
            index,
        })
    }

    fn write_diff<W: Write + Seek>(
        &mut self,
        w: &mut ArtRecWriter<W>,
        time_us: u64,
        changes: &[DiffChange],
        current: &[Vec<u8>],
    ) -> Result<Encoded> {
        let index = w.add_diff_frame(time_us, changes)?;
        self.last = Some(current.to_vec());
        self.chain += 1;
        self.max_chain = self.max_chain.max(self.chain);
        self.diff_frames += 1;
        Ok(Encoded {
            kind: FrameKind::Diff,
            index,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use artrec_core::{ArtRecReader, UniDesc};

    use super::{EncoderConfig, FrameEncoder, FrameKind};
    use artrec_core::{ArtRecWriter, CompressAlgo};

    fn setup(cfg: EncoderConfig) -> (ArtRecWriter<Cursor<Vec<u8>>>, FrameEncoder) {
        let unis = vec![
            UniDesc::from_universe(0, 512).unwrap(),
            UniDesc::from_universe(1, 512).unwrap(),
        ];
        let w = ArtRecWriter::new(
            Cursor::new(Vec::new()),
            unis,
            cfg.algo,
            cfg.level,
            cfg.file_flags(),
            0,
        )
        .unwrap();
        (w, FrameEncoder::new(cfg))
    }

    fn frame(a: u8, b: u8) -> Vec<Vec<u8>> {
        let mut f = vec![vec![0u8; 512]; 2];
        f[0][0] = a;
        f[1][5] = b;
        f
    }

    #[test]
    fn unchanged_data_writes_nothing() {
        let (mut w, mut e) = setup(EncoderConfig::default());
        assert!(e.encode(&mut w, 0, &frame(1, 2)).unwrap().is_some());
        assert!(e.encode(&mut w, 1000, &frame(1, 2)).unwrap().is_none());
        assert_eq!(w.frame_count(), 1);
    }

    fn diff_cfg() -> EncoderConfig {
        EncoderConfig {
            allow_diff: true,
            ..EncoderConfig::default()
        }
    }

    #[test]
    fn default_is_zstd_full_frames_only() {
        let (mut w, mut e) = setup(EncoderConfig::default());
        assert_eq!(e.config().file_flags(), 0);
        e.encode(&mut w, 0, &frame(1, 0)).unwrap();
        let r = e.encode(&mut w, 1000, &frame(2, 0)).unwrap().unwrap();
        assert_eq!(r.kind, FrameKind::Full);
        assert_eq!(e.diff_frames(), 0);
    }

    #[test]
    fn small_change_is_diff_large_change_is_full() {
        let (mut w, mut e) = setup(diff_cfg());
        assert_eq!(e.encode(&mut w, 0, &frame(1, 2)).unwrap().unwrap().kind, FrameKind::Full);
        assert_eq!(
            e.encode(&mut w, 1000, &frame(9, 2)).unwrap().unwrap().kind,
            FrameKind::Diff
        );
        // 大面积变化（> 1/4）改写全量
        let big = vec![vec![7u8; 512]; 2];
        assert_eq!(e.encode(&mut w, 2000, &big).unwrap().unwrap().kind, FrameKind::Full);
    }

    #[test]
    fn keyframe_forced_after_interval() {
        let cfg = EncoderConfig {
            keyframe_interval_us: 100_000,
            ..diff_cfg()
        };
        let (mut w, mut e) = setup(cfg);
        e.encode(&mut w, 0, &frame(1, 0)).unwrap();
        for i in 1..=30u64 {
            // 每帧只改 1 个通道 → 平时都是差分
            let r = e.encode(&mut w, i * 10_000, &frame(1 + i as u8, 0)).unwrap().unwrap();
            if i * 10_000 >= 100_000 && i * 10_000 < 110_000 {
                assert_eq!(r.kind, FrameKind::Full, "i={i}");
            }
        }
        // 链长不超过 关键帧间隔 / 帧间隔 + 1
        assert!(e.max_chain() <= 11, "max_chain={}", e.max_chain());
    }

    #[test]
    fn roundtrip_matches_every_frame_for_all_configs() {
        for (algo, allow_diff) in [
            (CompressAlgo::None, false),
            (CompressAlgo::None, true),
            (CompressAlgo::Zstd, false),
            (CompressAlgo::Zstd, true),
        ] {
            let cfg = EncoderConfig {
                algo,
                allow_diff,
                keyframe_interval_us: 50_000,
                ..EncoderConfig::default()
            };
            let (mut w, mut e) = setup(cfg);
            let mut expected = Vec::new();
            for i in 0..40u64 {
                let f = frame((i % 7) as u8 * 3, (i / 3) as u8);
                if e.encode(&mut w, i * 10_000, &f).unwrap().is_some() {
                    expected.push((i * 10_000, f));
                }
            }
            let reader = ArtRecReader::open(w.finish(390_000).unwrap().into_inner()).unwrap();
            for (t, f) in expected {
                assert_eq!(reader.frame_at(t).unwrap().unwrap(), f, "{algo:?}/{allow_diff} t={t}");
            }
        }
    }

    #[test]
    fn tail_frame_makes_last_index_equal_duration() {
        let (mut w, mut e) = setup(diff_cfg());
        e.encode(&mut w, 0, &frame(1, 1)).unwrap();
        e.encode_tail(&mut w, 5_000_000).unwrap().unwrap();
        assert_eq!(w.last_time_us(), Some(5_000_000));
        // 已有不早于该时刻的帧时不再补写
        assert!(e.encode_tail(&mut w, 5_000_000).unwrap().is_none());
        let reader = ArtRecReader::open(w.finish(5_000_000).unwrap().into_inner()).unwrap();
        assert_eq!(reader.frame_at(5_000_000).unwrap().unwrap(), frame(1, 1));
    }

    #[test]
    fn tail_without_frames_is_noop() {
        let (mut w, mut e) = setup(EncoderConfig::default());
        assert!(e.encode_tail(&mut w, 100).unwrap().is_none());
    }
}
