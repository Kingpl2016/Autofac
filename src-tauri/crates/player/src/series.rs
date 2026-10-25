//! 通道曲线：对选定通道在时间区间内做 min/max 降采样，供前端绘制折线 / 包络。

use std::io::{Read, Seek};

use artrec_core::ArtRecReader;
use serde::Serialize;

use crate::walker::FrameWalker;

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
    if channels.len() > MAX_SERIES_CHANNELS {
        return Err(SeriesError::TooManyChannels);
    }
    let ui = reader
        .unis()
        .iter()
        .position(|u| u.universe == universe)
        .ok_or(SeriesError::UnknownUniverse(universe))?;
    let dmx_len = usize::from(reader.unis()[ui].dmx_len);
    let chans: Vec<usize> = channels
        .iter()
        .map(|&c| usize::from(c))
        .filter(|&c| c < dmx_len)
        .collect();

    let t1 = t1.max(t0);
    let span = (t1 - t0).max(1);
    let want = u64::from(max_points.clamp(2, MAX_POINTS));
    let width = span.div_ceil(want).max(1);
    let n = span.div_ceil(width) as usize;

    // 区间起点处的状态：先应用 t0 之前（含）的最近一帧
    let start_idx = reader.find_index(t0);
    let mut walker = FrameWalker::from_frame(reader, start_idx.unwrap_or(0));
    let mut cur = vec![0u8; chans.len()];
    if start_idx.is_some() {
        walker.advance();
        for (k, &c) in chans.iter().enumerate() {
            cur[k] = walker.buffers()[ui][c];
        }
    }

    let mut series: Vec<ChannelSeries> = chans
        .iter()
        .map(|&c| ChannelSeries {
            channel: c as u16,
            points: Vec::with_capacity(n),
        })
        .collect();

    for b in 0..n {
        let lo = t0 + b as u64 * width;
        let hi = lo + width;
        let mut mn = cur.clone();
        let mut mx = cur.clone();
        while let Some(tf) = walker.peek_time() {
            if tf >= hi || tf > t1 {
                break;
            }
            walker.advance();
            for (k, &c) in chans.iter().enumerate() {
                let v = walker.buffers()[ui][c];
                cur[k] = v;
                mn[k] = mn[k].min(v);
                mx[k] = mx[k].max(v);
            }
        }
        for (k, s) in series.iter_mut().enumerate() {
            s.points.push(SeriesPoint {
                t_us: lo,
                min: mn[k],
                max: mx[k],
            });
        }
    }
    Ok(series)
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
            &[(0, vec![(0, 0, 0)]), (500_000, vec![(0, 0, 255)]), (500_020, vec![(0, 0, 0)])],
            1_000_000,
            CompressAlgo::None,
        ));
        let s = channel_series(&r, 0, &[0], 0, 1_000_000, 4).unwrap();
        assert!(s[0].points.iter().any(|q| q.max == 255), "{:?}", s[0].points);
    }

    #[test]
    fn window_starting_mid_program_uses_state_at_t0() {
        let s = channel_series(&sample(), 0, &[0], 500_000, 1_000_000, 5).unwrap();
        assert_eq!(s[0].points[0], p(500_000, 200, 200));
        assert_eq!(s[0].points[3], p(800_000, 50, 200));
    }

    #[test]
    fn before_first_frame_reads_as_zero() {
        let r = open(build_full(1, &[(500_000, vec![(0, 0, 9)])], 1_000_000, CompressAlgo::None));
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
