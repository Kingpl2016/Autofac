//! 改动前实现的原样副本（仅测试）：新的串行 / 并行实现必须与之逐字节一致。
//!
//! 下列代码从改动前的 `walker.rs` / `overview.rs` / `series.rs` 原样复制（仅改名与路径），
//! 不要"顺手优化"。

use std::io::{Read, Seek};

use artrec_core::ArtRecReader;

use crate::overview::{Overview, MAX_BUCKETS, MIN_BUCKETS, OVERVIEW_VERSION};
use crate::series::{ChannelSeries, SeriesError, SeriesPoint, MAX_POINTS, MAX_SERIES_CHANNELS};

/// 改动前的顺序帧遍历器（`read_chunk` + `apply_chunk`，每帧新分配 Payload）。
pub struct RefWalker<'a, R: Read + Seek> {
    reader: &'a ArtRecReader<R>,
    next: usize,
    buffers: Vec<Vec<u8>>,
    skipped: u64,
}

impl<'a, R: Read + Seek> RefWalker<'a, R> {
    pub fn from_frame(reader: &'a ArtRecReader<R>, start: usize) -> Self {
        let mut w = Self {
            reader,
            next: 0,
            buffers: reader.zero_buffers(),
            skipped: 0,
        };
        if start >= reader.index().len() {
            w.next = reader.index().len();
            return w;
        }
        // 先在 `start` 之前重建状态：从最近全量帧推进到 start-1
        let kf = reader.keyframe_at_or_before(start).unwrap_or(0);
        w.next = kf;
        while w.next < start {
            w.step();
        }
        w
    }

    pub fn new(reader: &'a ArtRecReader<R>) -> Self {
        Self::from_frame(reader, 0)
    }

    fn step(&mut self) {
        let k = self.next;
        self.next += 1;
        match self.reader.read_chunk(k) {
            Ok((hdr, raw)) => {
                if self
                    .reader
                    .apply_chunk(&mut self.buffers, &hdr, &raw)
                    .is_err()
                {
                    self.skipped += 1;
                }
            }
            Err(_) => self.skipped += 1,
        }
    }

    pub fn advance(&mut self) -> Option<u64> {
        if self.next >= self.reader.index().len() {
            return None;
        }
        let t = self.reader.index()[self.next].time_us;
        self.step();
        Some(t)
    }

    pub fn peek_time(&self) -> Option<u64> {
        self.reader.index().get(self.next).map(|f| f.time_us)
    }

    pub fn buffers(&self) -> &[Vec<u8>] {
        &self.buffers
    }

    pub fn skipped(&self) -> u64 {
        self.skipped
    }
}

/// 改动前的 `bucket_of`。
fn bucket_of(t: u64, duration: u64, buckets: usize) -> usize {
    if duration == 0 {
        return 0;
    }
    let b = (u128::from(t) * buckets as u128 / u128::from(duration)) as usize;
    b.min(buckets - 1)
}

/// 改动前的 `scale`。
fn scale(c: u32, max: u32) -> u8 {
    if c == 0 || max == 0 {
        return 0;
    }
    let v = 254.0 * f64::from(c).sqrt() / f64::from(max).sqrt();
    #[allow(clippy::cast_sign_loss)]
    let out = (1.0 + v).round().clamp(1.0, 255.0) as u8;
    out
}

/// 改动前的 `build_overview`。
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

    let mut walker = RefWalker::new(reader);
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
            let changed = now_buf.iter().zip(&prev[u]).filter(|(a, b)| a != b).count();
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

/// 改动前的 `channel_series`。
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
    let mut walker = RefWalker::from_frame(reader, start_idx.unwrap_or(0));
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
