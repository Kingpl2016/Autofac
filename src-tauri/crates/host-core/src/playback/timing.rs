//! 回放调度的计时统计：每次到期 `poll` 相对截止时刻的迟到分布。
//!
//! 用固定桶的小直方图记录（不分配、`record` 为常数时间），节目关闭 / 回放线程退出时输出
//! p50 / p99 / max 与样本数。桶宽随迟到增大而变粗（见 [`TIERS`]）：
//!
//! | 区间 | 桶宽 |
//! |------|------|
//! | 0 ~ 100µs | 5µs |
//! | 100µs ~ 2ms | 50µs |
//! | 2 ~ 10ms | 250µs |
//! | 10 ~ 100ms | 5ms |
//! | ≥ 100ms | 单个溢出桶 |
//!
//! 分位数取所在桶的上沿（不超过实测最大值），因此是"不低于真实值"的保守估计。

use std::time::Duration;

/// 各段的 `(上界, 桶宽)`（微秒），段与段首尾相接、从 0 开始；上界须是桶宽的整数倍。
const TIERS: [(u64, u64); 4] = [(100, 5), (2_000, 50), (10_000, 250), (100_000, 5_000)];

/// 桶总数（含溢出桶）。
const BUCKETS: usize = bucket_count() + 1;

/// 各段桶数之和（不含溢出桶）。
const fn bucket_count() -> usize {
    let mut start = 0;
    let mut n = 0;
    let mut i = 0;
    while i < TIERS.len() {
        let (end, width) = TIERS[i];
        n += ((end - start) / width) as usize;
        start = end;
        i += 1;
    }
    n
}

/// 迟到分布的摘要。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct TimingSummary {
    /// 样本数。
    pub(crate) samples: u64,
    /// 中位数（微秒，桶上沿）。
    pub(crate) p50_us: u64,
    /// 99 分位（微秒，桶上沿）。
    pub(crate) p99_us: u64,
    /// 最大值（微秒，精确值）。
    pub(crate) max_us: u64,
}

/// 迟到直方图（固定桶，不分配）。
#[derive(Debug, Clone)]
pub(crate) struct LatenessHistogram {
    /// 各桶计数。
    buckets: [u64; BUCKETS],
    /// 样本总数。
    count: u64,
    /// 最大迟到（微秒）。
    max_us: u64,
}

impl Default for LatenessHistogram {
    fn default() -> Self {
        Self::new()
    }
}

/// 迟到值所在的桶下标。
///
/// # Arguments
///
/// * `us` - 迟到（微秒）。
///
/// # Returns
///
/// `0..BUCKETS` 内的桶下标；不小于最后一段上界的值落进溢出桶。
fn bucket_of(us: u64) -> usize {
    let mut start = 0;
    let mut base = 0;
    for (end, width) in TIERS {
        if us < end {
            return base + ((us - start) / width) as usize;
        }
        base += ((end - start) / width) as usize;
        start = end;
    }
    BUCKETS - 1
}

/// 桶的上沿（不含，微秒）。
///
/// # Arguments
///
/// * `idx` - 桶下标。
///
/// # Returns
///
/// 落进该桶的迟到都小于返回值；溢出桶为 `u64::MAX`。
fn bucket_upper(idx: usize) -> u64 {
    let mut start = 0;
    let mut base = 0;
    for (end, width) in TIERS {
        let n = ((end - start) / width) as usize;
        if idx < base + n {
            return start + (idx - base + 1) as u64 * width;
        }
        base += n;
        start = end;
    }
    u64::MAX
}

impl LatenessHistogram {
    /// 创建空直方图。
    ///
    /// # Returns
    ///
    /// 没有任何样本的直方图。
    pub(crate) const fn new() -> Self {
        Self {
            buckets: [0; BUCKETS],
            count: 0,
            max_us: 0,
        }
    }

    /// 记录一次迟到。
    ///
    /// # Arguments
    ///
    /// * `late` - 实际 `poll` 时刻相对截止时刻的迟到；按微秒向下取整。
    pub(crate) fn record(&mut self, late: Duration) {
        let us = u64::try_from(late.as_micros()).unwrap_or(u64::MAX);
        self.buckets[bucket_of(us)] += 1;
        self.count += 1;
        self.max_us = self.max_us.max(us);
    }

    /// 分位数（千分位）。
    ///
    /// # Arguments
    ///
    /// * `per_mille` - 千分位，`500` 为中位数、`990` 为 99 分位；超过 `1000` 按 `1000` 处理。
    ///
    /// # Returns
    ///
    /// 第 `ceil(样本数 × per_mille / 1000)` 个样本（至少第 1 个）所在桶的上沿，不超过实测最大值；
    /// 没有样本时为 `0`。
    pub(crate) fn percentile_us(&self, per_mille: u32) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let rank = (self.count * u64::from(per_mille.min(1000)))
            .div_ceil(1000)
            .max(1);
        let mut seen = 0u64;
        for (idx, &n) in self.buckets.iter().enumerate() {
            seen += n;
            if seen >= rank {
                return bucket_upper(idx).min(self.max_us);
            }
        }
        self.max_us
    }

    /// 摘要：样本数、p50、p99、最大值。
    ///
    /// # Returns
    ///
    /// 当前样本的 [`TimingSummary`]；没有样本时各项为 `0`。
    pub(crate) fn summary(&self) -> TimingSummary {
        TimingSummary {
            samples: self.count,
            p50_us: self.percentile_us(500),
            p99_us: self.percentile_us(990),
            max_us: self.max_us,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{bucket_of, bucket_upper, LatenessHistogram, TimingSummary, BUCKETS};

    fn us(n: u64) -> Duration {
        Duration::from_micros(n)
    }

    #[test]
    fn buckets_are_contiguous_and_cover_every_value() {
        assert_eq!(BUCKETS, 20 + 38 + 32 + 18 + 1);
        // 每个桶的上沿正好是下一个桶的起点
        for idx in 0..BUCKETS - 1 {
            let upper = bucket_upper(idx);
            assert_eq!(bucket_of(upper - 1), idx, "桶 {idx} 的最后一个值");
            assert_eq!(bucket_of(upper), idx + 1, "桶 {idx} 的上沿属于下一个桶");
        }
        assert_eq!(bucket_of(0), 0);
        assert_eq!(bucket_of(4), 0);
        assert_eq!(bucket_of(5), 1);
        assert_eq!(bucket_of(100), 20);
        assert_eq!(bucket_of(2_000), 58);
        assert_eq!(bucket_of(10_000), 90);
        assert_eq!(bucket_of(99_999), BUCKETS - 2);
        assert_eq!(bucket_of(100_000), BUCKETS - 1);
        assert_eq!(bucket_of(u64::MAX), BUCKETS - 1);
        assert_eq!(bucket_upper(BUCKETS - 1), u64::MAX);
    }

    #[test]
    fn empty_histogram_reports_zeros() {
        assert_eq!(LatenessHistogram::new().summary(), TimingSummary::default());
    }

    #[test]
    fn percentiles_use_bucket_upper_bounds_capped_by_max() {
        let mut h = LatenessHistogram::new();
        // 98 个 12µs、1 个 1.51ms、1 个 30ms
        for _ in 0..98 {
            h.record(us(12));
        }
        h.record(us(1_510));
        h.record(us(30_000));
        let s = h.summary();
        assert_eq!(s.samples, 100);
        assert_eq!(s.p50_us, 15, "中位数落在 10~15µs 桶，取上沿");
        assert_eq!(s.p99_us, 1_550, "第 99 个样本落在 1.5~1.55ms 桶");
        assert_eq!(s.max_us, 30_000);
        assert_eq!(
            h.percentile_us(1000),
            30_000,
            "100 分位即最大值所在桶，钳到最大值"
        );
        assert_eq!(h.percentile_us(0), 15, "0 分位按第 1 个样本计");
        assert_eq!(h.percentile_us(5000), 30_000, "超过 1000 按 1000 处理");
    }

    #[test]
    fn single_sample_and_overflow_are_exact() {
        let mut h = LatenessHistogram::new();
        h.record(us(7));
        assert_eq!(
            h.summary(),
            TimingSummary {
                samples: 1,
                p50_us: 7,
                p99_us: 7,
                max_us: 7
            }
        );

        // 溢出桶：分位数取实测最大值
        let mut h = LatenessHistogram::new();
        h.record(Duration::from_secs(2));
        h.record(Duration::from_secs(3));
        assert_eq!(h.percentile_us(500), 3_000_000);
        // 远超 u64 微秒的时长被饱和处理，不会 panic
        h.record(Duration::MAX);
        assert_eq!(h.summary().max_us, u64::MAX);
    }
}
