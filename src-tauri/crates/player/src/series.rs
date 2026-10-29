//! 通道曲线：对选定通道在时间区间内做 min/max 降采样，供前端绘制折线 / 包络。

use std::io::{Read, Seek};
use std::ops::Range;

use artrec_core::{ArtRecReader, CHUNK_FULL};
use serde::Serialize;

/// 单次查询允许的最大点数。
pub const MAX_POINTS: u32 = 4096;
/// 单次查询允许的最大通道数。
pub const MAX_SERIES_CHANNELS: usize = 16;

/// 曲线查询错误。
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SeriesError {
    /// 节目里没有该 Universe。
    #[error("节目中不存在 Universe {0}")]
    UnknownUniverse(u16),
    /// 一次请求的通道过多。
    #[error("一次最多查询 {MAX_SERIES_CHANNELS} 个通道")]
    TooManyChannels,
}

/// 一个降采样点：该时间桶内通道值的最小 / 最大值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct SeriesPoint {
    /// 桶起始时间（微秒）。
    pub t_us: u64,
    /// 桶内最小值。
    pub min: u8,
    /// 桶内最大值。
    pub max: u8,
}

/// 一个通道的曲线。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ChannelSeries {
    /// 通道号（0 起）。
    pub channel: u16,
    /// 降采样点，按时间升序。
    pub points: Vec<SeriesPoint>,
}

/// 查询通道曲线。
///
/// 区间 `[t0, t1]` 被均分为不超过 `max_points` 个桶；桶内值取"桶起始时刻的状态"与
/// "桶内所有帧"的最小 / 最大值，因此即使一个尖峰只持续一帧也不会在降采样时丢失。
///
/// 单线程实现只跟踪目标 Universe：全量帧直接从原始 Payload 切出该路字节，不拆分其它路，
/// 全程复用缓冲；跳过损坏帧的规则与 [`crate::FrameWalker`] 相同。区间起点帧本身损坏时，
/// 起点状态为全零（不回看更早的帧，与改动前行为一致）。磁盘上的大区间查询请优先用
/// [`crate::channel_series_parallel`]。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `universe` - Universe 编号（不是文件内下标）。
/// * `channels` - 通道号列表（0 起，超出 `dmx_len` 的通道被忽略）。
/// * `t0` / `t1` - 查询区间（微秒）。
/// * `max_points` - 最大点数，钳制到 `[2, MAX_POINTS]`。
///
/// # Returns
///
/// 每个有效通道（`channels` 中未超出 `dmx_len` 的项，保持传入顺序）对应一条 [`ChannelSeries`]，
/// 其 `points` 按时间升序排列，点数不超过 `max_points`。
///
/// # Errors
///
/// Universe 不存在或通道过多。
pub fn channel_series<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    universe: u16,
    channels: &[u16],
    t0: u64,
    t1: u64,
    max_points: u32,
) -> Result<Vec<ChannelSeries>, SeriesError> {
    let q = SeriesQuery::new(reader, universe, channels, t0, t1, max_points)?;
    Ok(series_serial(reader, &q))
}

/// 已校验、已换算分桶参数的曲线查询（串行与并行共用）。
#[derive(Debug, Clone)]
pub(crate) struct SeriesQuery {
    /// 目标 Universe 在文件内的下标。
    pub(crate) ui: usize,
    /// 有效通道（未超出 `dmx_len`），前 `nch` 项有效，保持传入顺序。
    chans: [usize; MAX_SERIES_CHANNELS],
    /// 有效通道数。
    nch: usize,
    /// 区间起点（微秒）。
    pub(crate) t0: u64,
    /// 区间终点（微秒，已保证不小于 `t0`）。
    pub(crate) t1: u64,
    /// 桶宽（微秒，不小于 1）。
    pub(crate) width: u64,
    /// 桶数（即每条曲线的点数）。
    pub(crate) n: usize,
}

impl SeriesQuery {
    /// 校验参数并换算分桶（校验顺序与错误与改动前一致）。
    ///
    /// # Arguments
    ///
    /// * `reader` - 已打开的节目。
    /// * `universe` - Universe 编号（不是文件内下标）。
    /// * `channels` - 通道号列表（0 起，超出 `dmx_len` 的通道被忽略）。
    /// * `t0` / `t1` - 查询区间（微秒）。
    /// * `max_points` - 最大点数，钳制到 `[2, MAX_POINTS]`。
    ///
    /// # Returns
    ///
    /// 换算好桶宽与桶数的查询。
    ///
    /// # Errors
    ///
    /// 通道数超过 [`MAX_SERIES_CHANNELS`] 返回 [`SeriesError::TooManyChannels`]；
    /// Universe 不存在返回 [`SeriesError::UnknownUniverse`]。
    pub(crate) fn new<R: Read + Seek>(
        reader: &ArtRecReader<R>,
        universe: u16,
        channels: &[u16],
        t0: u64,
        t1: u64,
        max_points: u32,
    ) -> Result<Self, SeriesError> {
        if channels.len() > MAX_SERIES_CHANNELS {
            return Err(SeriesError::TooManyChannels);
        }
        let ui = reader
            .unis()
            .iter()
            .position(|u| u.universe == universe)
            .ok_or(SeriesError::UnknownUniverse(universe))?;
        let dmx_len = reader.unis().get(ui).map_or(0, |u| usize::from(u.dmx_len));
        let mut chans = [0usize; MAX_SERIES_CHANNELS];
        let mut nch = 0;
        for c in channels
            .iter()
            .map(|&c| usize::from(c))
            .filter(|&c| c < dmx_len)
        {
            chans[nch] = c;
            nch += 1;
        }

        let t1 = t1.max(t0);
        let span = (t1 - t0).max(1);
        let want = u64::from(max_points.clamp(2, MAX_POINTS));
        let width = span.div_ceil(want).max(1);
        let n = span.div_ceil(width) as usize;
        Ok(Self {
            ui,
            chans,
            nch,
            t0,
            t1,
            width,
            n,
        })
    }

    /// 有效通道列表。
    ///
    /// # Returns
    ///
    /// 未超出 `dmx_len` 的通道号（文件内通道下标），保持传入顺序。
    pub(crate) fn chans(&self) -> &[usize] {
        &self.chans[..self.nch]
    }

    /// 第 `b` 个桶的起始时间（与改动前的表达式完全相同）。
    ///
    /// # Arguments
    ///
    /// * `b` - 桶下标。
    ///
    /// # Returns
    ///
    /// `t0 + b * width`（微秒）。
    pub(crate) fn bucket_start(&self, b: usize) -> u64 {
        self.t0 + b as u64 * self.width
    }

    /// 从目标 Universe 的状态中读出各有效通道的当前值。
    ///
    /// # Arguments
    ///
    /// * `uni` - 目标 Universe 的当前 DMX 缓冲。
    ///
    /// # Returns
    ///
    /// 前 `nch` 项为各有效通道的值，其余为 0。
    pub(crate) fn sample(&self, uni: &[u8]) -> [u8; MAX_SERIES_CHANNELS] {
        let mut out = [0u8; MAX_SERIES_CHANNELS];
        for (o, &c) in out.iter_mut().zip(self.chans()) {
            *o = uni.get(c).copied().unwrap_or(0);
        }
        out
    }

    /// 由各桶包络组装输出曲线。
    ///
    /// # Arguments
    ///
    /// * `envelope` - 按桶顺序、每桶 `nch` 项的 `(min, max)`，共 `n * nch` 项。
    ///
    /// # Returns
    ///
    /// 每个有效通道一条曲线，点按时间升序。
    pub(crate) fn assemble(&self, envelope: &[(u8, u8)]) -> Vec<ChannelSeries> {
        let nch = self.nch;
        self.chans()
            .iter()
            .enumerate()
            .map(|(k, &c)| ChannelSeries {
                channel: c as u16,
                points: envelope
                    .iter()
                    .skip(k)
                    .step_by(nch.max(1))
                    .enumerate()
                    .map(|(b, &(min, max))| SeriesPoint {
                        t_us: self.bucket_start(b),
                        min,
                        max,
                    })
                    .collect(),
            })
            .collect()
    }
}

/// 只跟踪目标 Universe 的帧状态（跳过规则与 [`crate::FrameWalker`] 完全相同）。
///
/// 全量帧只从原始 Payload 里切出目标 Universe 的字节区间（偏移按 UniDesc 顺序累加
/// `dmx_len`），不拆分其它 Universe；差分帧照常经 [`ArtRecReader::apply_chunk_into`] 应用到
/// 一组"只有目标 Universe 有缓冲"的稀疏状态上（其它 Universe 的变更点因越界被忽略）。
/// 是否跳过只取决于帧自身：读取 / 校验失败、全量帧总长与 UniDesc 不符、差分帧不被允许或截断。
#[derive(Debug, Clone)]
pub(crate) struct UniTrack {
    /// 目标 Universe 下标。
    ui: usize,
    /// 目标 Universe 在全量帧 Payload 中的起始偏移。
    off: usize,
    /// 全量帧 Payload 总长（各路 `dmx_len` 之和）。
    total: usize,
    /// 稀疏状态：只有 `state[ui]` 有 `dmx_len` 字节，其余为空缓冲。
    state: Vec<Vec<u8>>,
    /// 跨帧复用的原始 Payload 缓冲。
    raw: Vec<u8>,
}

impl UniTrack {
    /// 创建状态全零的跟踪器。
    ///
    /// # Arguments
    ///
    /// * `reader` - 已打开的节目。
    /// * `ui` - 目标 Universe 下标（须小于 Universe 数）。
    ///
    /// # Returns
    ///
    /// 目标 Universe 状态全零的跟踪器。
    pub(crate) fn new<R: Read + Seek>(reader: &ArtRecReader<R>, ui: usize) -> Self {
        let unis = reader.unis();
        let off = unis.iter().take(ui).map(|u| usize::from(u.dmx_len)).sum();
        let total = unis.iter().map(|u| usize::from(u.dmx_len)).sum();
        let state = unis
            .iter()
            .enumerate()
            .map(|(i, u)| {
                if i == ui {
                    vec![0u8; usize::from(u.dmx_len)]
                } else {
                    Vec::new()
                }
            })
            .collect();
        Self {
            ui,
            off,
            total,
            state,
            raw: Vec::new(),
        }
    }

    /// 读取并应用第 `k` 帧到目标 Universe。
    ///
    /// # Arguments
    ///
    /// * `reader` - 已打开的节目（须与创建时同一份文件）。
    /// * `k` - 帧下标。
    ///
    /// # Returns
    ///
    /// 成功应用返回 `true`；该帧被跳过（状态不变）返回 `false`。
    pub(crate) fn apply<R: Read + Seek>(&mut self, reader: &ArtRecReader<R>, k: usize) -> bool {
        let Ok(hdr) = reader.read_chunk_into(k, &mut self.raw) else {
            return false;
        };
        if hdr.chunk_type != CHUNK_FULL {
            return reader
                .apply_chunk_into(&mut self.state, &hdr, &self.raw)
                .is_ok();
        }
        // 全量帧：总长须与 UniDesc 一致（与 `apply_chunk_into` 的校验相同）
        if self.raw.len() != self.total {
            return false;
        }
        let Some(dst) = self.state.get_mut(self.ui) else {
            return true;
        };
        match self.raw.get(self.off..self.off + dst.len()) {
            Some(seg) => {
                dst.copy_from_slice(seg);
                true
            }
            // 总长已校验，不会走到这里；保守地按损坏帧处理
            None => false,
        }
    }

    /// 目标 Universe 的当前状态。
    ///
    /// # Returns
    ///
    /// 目标 Universe 的 DMX 缓冲（长度为其 `dmx_len`）。
    pub(crate) fn universe(&self) -> &[u8] {
        self.state.get(self.ui).map_or(&[], Vec::as_slice)
    }

    /// 用另一跟踪器的状态覆盖本跟踪器的状态（不改动复用缓冲）。
    ///
    /// # Arguments
    ///
    /// * `other` - 同一查询下的另一跟踪器。
    pub(crate) fn copy_state_from(&mut self, other: &Self) {
        if let (Some(dst), Some(src)) = (self.state.get_mut(self.ui), other.state.get(other.ui)) {
            dst.clone_from(src);
        }
    }
}

/// 在一段连续桶上执行与改动前完全相同的降采样循环。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `track` - 目标 Universe 状态（须等于串行算法在 `buckets.start` 起点处的状态）。
/// * `next` - 下一个待处理的帧下标（串行算法在该桶起点处的位置），随处理推进。
/// * `q` - 查询参数。
/// * `buckets` - 本次处理的桶下标区间。
/// * `envelope` - 输出：每桶追加 `nch` 项 `(min, max)`。
pub(crate) fn run_buckets<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    track: &mut UniTrack,
    next: &mut usize,
    q: &SeriesQuery,
    buckets: Range<usize>,
    envelope: &mut Vec<(u8, u8)>,
) {
    let index = reader.index();
    let mut cur = q.sample(track.universe());
    for b in buckets {
        let lo = q.bucket_start(b);
        let hi = lo + q.width;
        let mut mn = cur;
        let mut mx = cur;
        while let Some(f) = index.get(*next) {
            if f.time_us >= hi || f.time_us > q.t1 {
                break;
            }
            let k = *next;
            *next += 1;
            // 被跳过的帧状态不变：cur 不变，而桶内 min ≤ cur ≤ max 恒成立，无需更新
            if track.apply(reader, k) {
                cur = q.sample(track.universe());
                for ((m, x), &v) in mn.iter_mut().zip(mx.iter_mut()).zip(&cur) {
                    *m = (*m).min(v);
                    *x = (*x).max(v);
                }
            }
        }
        envelope.extend(mn.iter().copied().zip(mx).take(q.nch));
    }
}

/// 区间起点处的串行状态（与改动前 `FrameWalker::from_frame` + 首帧 `advance` 等价）。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `track` - 状态全零的跟踪器，返回时为区间起点处的状态。
/// * `start_idx` - `reader.find_index(t0)`。
///
/// # Returns
///
/// 第一个尚未处理的帧下标。
pub(crate) fn rebuild_start<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    track: &mut UniTrack,
    start_idx: Option<usize>,
) -> usize {
    let len = reader.index().len();
    let start = start_idx.unwrap_or(0);
    let mut next = len;
    if start < len {
        // 先在 `start` 之前重建状态：从最近全量帧推进到 start-1
        next = reader.keyframe_at_or_before(start).unwrap_or(0);
        while next < start {
            track.apply(reader, next);
            next += 1;
        }
    }
    // 区间起点处的状态：再应用 t0 之前（含）的最近一帧
    if start_idx.is_some() && next < len {
        track.apply(reader, next);
        next += 1;
    }
    next
}

/// 串行曲线查询（已校验参数）。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `q` - 已校验的查询。
///
/// # Returns
///
/// 每个有效通道一条曲线。
pub(crate) fn series_serial<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    q: &SeriesQuery,
) -> Vec<ChannelSeries> {
    let mut track = UniTrack::new(reader, q.ui);
    let mut next = rebuild_start(reader, &mut track, reader.find_index(q.t0));
    let mut envelope = Vec::with_capacity(q.n * q.nch);
    run_buckets(reader, &mut track, &mut next, q, 0..q.n, &mut envelope);
    q.assemble(&envelope)
}

#[cfg(test)]
mod tests {
    use artrec_core::CompressAlgo;

    use super::{channel_series, SeriesError, SeriesPoint};
    use crate::walker::testkit::{build_full, open};

    fn p(t_us: u64, min: u8, max: u8) -> SeriesPoint {
        SeriesPoint { t_us, min, max }
    }

    fn sample() -> artrec_core::ArtRecReader {
        open(build_full(
            1,
            &[
                (0, vec![(0, 0, 10)]),
                (300_000, vec![(0, 0, 200)]),
                (800_000, vec![(0, 0, 50)]),
            ],
            1_000_000,
            CompressAlgo::Zstd,
        ))
    }

    #[test]
    fn downsamples_with_min_max_envelope() {
        let s = channel_series(&sample(), 0, &[0], 0, 1_000_000, 10).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].channel, 0);
        assert_eq!(
            s[0].points,
            vec![
                p(0, 10, 10),
                p(100_000, 10, 10),
                p(200_000, 10, 10),
                p(300_000, 10, 200), // 桶起始 10，桶内跳到 200
                p(400_000, 200, 200),
                p(500_000, 200, 200),
                p(600_000, 200, 200),
                p(700_000, 200, 200),
                p(800_000, 50, 200), // 桶起始 200，桶内降到 50
                p(900_000, 50, 50),
            ]
        );
    }

    #[test]
    fn a_single_frame_spike_survives_coarse_sampling() {
        let r = open(build_full(
            1,
            &[
                (0, vec![(0, 0, 0)]),
                (500_000, vec![(0, 0, 255)]),
                (500_020, vec![(0, 0, 0)]),
            ],
            1_000_000,
            CompressAlgo::None,
        ));
        let s = channel_series(&r, 0, &[0], 0, 1_000_000, 4).unwrap();
        assert!(
            s[0].points.iter().any(|q| q.max == 255),
            "{:?}",
            s[0].points
        );
    }

    #[test]
    fn window_starting_mid_program_uses_state_at_t0() {
        let s = channel_series(&sample(), 0, &[0], 500_000, 1_000_000, 5).unwrap();
        assert_eq!(s[0].points[0], p(500_000, 200, 200));
        assert_eq!(s[0].points[3], p(800_000, 50, 200));
    }

    #[test]
    fn before_first_frame_reads_as_zero() {
        let r = open(build_full(
            1,
            &[(500_000, vec![(0, 0, 9)])],
            1_000_000,
            CompressAlgo::None,
        ));
        let s = channel_series(&r, 0, &[0], 0, 1_000_000, 4).unwrap();
        assert_eq!(s[0].points[0], p(0, 0, 0));
        assert_eq!(s[0].points[2].max, 9);
    }

    #[test]
    fn rejects_unknown_universe_and_too_many_channels_and_drops_bad_channels() {
        let r = sample();
        assert_eq!(
            channel_series(&r, 7, &[0], 0, 10, 4).unwrap_err(),
            SeriesError::UnknownUniverse(7)
        );
        let many: Vec<u16> = (0..17).collect();
        assert_eq!(
            channel_series(&r, 0, &many, 0, 10, 4).unwrap_err(),
            SeriesError::TooManyChannels
        );
        // 超出 dmx_len 的通道被忽略
        let s = channel_series(&r, 0, &[0, 9999], 0, 1_000_000, 4).unwrap();
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn point_count_is_bounded() {
        let s = channel_series(&sample(), 0, &[0], 0, 1_000_000, 64).unwrap();
        assert!(s[0].points.len() <= 64);
        assert!(s[0].points.len() >= 32);
    }
}
