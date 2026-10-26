//! 包速率追踪：把累计包数按固定时间窗口差分成每秒包数。
//!
//! 推送循环的周期（默认 30Hz）远短于 1 秒，逐周期差分会因整数量化而抖动。
//! 这里改用不短于 [`RATE_WINDOW_MS`] 的窗口，窗口内沿用上一次的结果，
//! 窗口结束时才重新计算，使界面上的 pps 数字稳定可读。
//!
//! 追踪器只依赖逻辑时间（毫秒），便于确定性测试。

use std::collections::HashMap;

use crate::engine::UniverseSnapshot;

/// 速率统计窗口（毫秒）。
pub const RATE_WINDOW_MS: u64 = 1000;

/// 累计包数计数器的键：整体、某个 Universe、某个 Universe 上的某个来源。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Key {
    /// 全部 Universe 的总计。
    Total,
    /// 单个 Universe 的总计。
    Universe(u16),
    /// 单个 Universe 上的单个来源（源 IP 字符串）。
    Source(u16, String),
}

/// 包速率追踪器。
#[derive(Debug, Default)]
pub struct RateTracker {
    /// 上一个窗口结束时各计数器的累计值。
    prev: HashMap<Key, u64>,
    /// 最近一次计算出的每秒包数。
    rates: HashMap<Key, u32>,
    /// 上一个窗口结束的逻辑时间；`None` 表示尚未建立基线。
    last_at_ms: Option<u64>,
}

impl RateTracker {
    /// 创建空的追踪器。
    ///
    /// # Returns
    ///
    /// 尚未建立基线的 [`RateTracker`]。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 用当前累计值推进窗口，并把速率写回快照。
    ///
    /// 第一次调用只建立基线（速率为 `0`）。此后每当距上个窗口结束已满
    /// [`RATE_WINDOW_MS`]，就以窗口内的增量重新计算；未满窗口时沿用上次结果。
    /// 累计值回退（来源被剔除后重建）时增量按 `0` 处理，不会出现下溢。
    ///
    /// # Arguments
    ///
    /// * `snapshot` - 当前全部活跃 Universe 的快照；其 `packet_rate` 与各来源的
    ///   `packet_rate` 会被就地覆盖。
    /// * `total_packets` - 引擎的累计接收包数。
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    ///
    /// # Returns
    ///
    /// 全部 Universe 合计的每秒包数。
    pub fn apply(
        &mut self,
        snapshot: &mut [UniverseSnapshot],
        total_packets: u64,
        now_ms: u64,
    ) -> u32 {
        let counters = Self::collect(snapshot, total_packets);
        match self.last_at_ms {
            None => {
                self.prev = counters;
                self.last_at_ms = Some(now_ms);
            }
            Some(last) if now_ms.saturating_sub(last) >= RATE_WINDOW_MS => {
                let elapsed = now_ms - last;
                self.rates = counters
                    .iter()
                    .map(|(key, &cur)| {
                        let before = self.prev.get(key).copied().unwrap_or(0);
                        (key.clone(), per_second(cur.saturating_sub(before), elapsed))
                    })
                    .collect();
                // 只保留仍然存在的计数器，消失的 Universe / 来源随之释放
                self.prev = counters;
                self.last_at_ms = Some(now_ms);
            }
            Some(_) => {}
        }

        for u in snapshot.iter_mut() {
            u.packet_rate = self.rate_of(&Key::Universe(u.universe));
            for s in &mut u.sources {
                s.packet_rate = self.rate_of(&Key::Source(u.universe, s.ip.clone()));
            }
        }
        self.rate_of(&Key::Total)
    }

    /// 清空基线与结果（例如引擎被整体重置后调用）。
    pub fn reset(&mut self) {
        self.prev.clear();
        self.rates.clear();
        self.last_at_ms = None;
    }

    fn rate_of(&self, key: &Key) -> u32 {
        self.rates.get(key).copied().unwrap_or(0)
    }

    fn collect(snapshot: &[UniverseSnapshot], total_packets: u64) -> HashMap<Key, u64> {
        let mut m = HashMap::with_capacity(1 + snapshot.len() * 2);
        m.insert(Key::Total, total_packets);
        for u in snapshot {
            m.insert(Key::Universe(u.universe), u.total_packets);
            for s in &u.sources {
                m.insert(Key::Source(u.universe, s.ip.clone()), s.packets);
            }
        }
        m
    }
}

/// 把窗口内的增量换算成每秒速率（四舍五入；用整数运算，避免浮点转换）。
fn per_second(delta: u64, elapsed_ms: u64) -> u32 {
    let elapsed = u128::from(elapsed_ms.max(1));
    let rate = (u128::from(delta) * 1000 + elapsed / 2) / elapsed;
    u32::try_from(rate).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::{per_second, RateTracker, RATE_WINDOW_MS};
    use crate::engine::{UniverseSnapshot, UniverseSource};

    fn snap(universe: u16, total: u64, sources: &[(&str, u64)]) -> UniverseSnapshot {
        UniverseSnapshot {
            universe,
            protocol: None,
            source_ips: sources.iter().map(|(ip, _)| (*ip).to_string()).collect(),
            source_count: sources.len(),
            active_channels: 0,
            conflict_channels: 0,
            total_packets: total,
            packet_rate: 0,
            sources: sources
                .iter()
                .map(|(ip, n)| UniverseSource {
                    ip: (*ip).to_string(),
                    packets: *n,
                    packet_rate: 0,
                })
                .collect(),
        }
    }

    #[test]
    fn per_second_rounds_and_saturates() {
        assert_eq!(per_second(44, 1000), 44);
        assert_eq!(per_second(1, 3), 333);
        assert_eq!(per_second(2, 3), 667);
        assert_eq!(per_second(5, 0), 5000, "零时长按 1ms 处理，不除零");
        assert_eq!(per_second(u64::MAX, 1), u32::MAX);
    }

    #[test]
    fn first_call_only_sets_baseline() {
        let mut t = RateTracker::new();
        let mut s = vec![snap(1, 100, &[("10.0.0.1", 100)])];
        assert_eq!(t.apply(&mut s, 100, 0), 0);
        assert_eq!(s[0].packet_rate, 0);
        assert_eq!(s[0].sources[0].packet_rate, 0);
    }

    #[test]
    fn rate_is_stable_inside_window_and_updates_after() {
        let mut t = RateTracker::new();
        let mut s = vec![snap(1, 0, &[("10.0.0.1", 0)])];
        t.apply(&mut s, 0, 0);

        // 窗口未满：沿用旧值 0
        let mut s = vec![snap(1, 20, &[("10.0.0.1", 20)])];
        assert_eq!(t.apply(&mut s, 20, RATE_WINDOW_MS - 1), 0);
        assert_eq!(s[0].packet_rate, 0);

        // 窗口已满：44 个包 / 1s
        let mut s = vec![snap(1, 44, &[("10.0.0.1", 44)])];
        assert_eq!(t.apply(&mut s, 44, RATE_WINDOW_MS), 44);
        assert_eq!(s[0].packet_rate, 44);
        assert_eq!(s[0].sources[0].packet_rate, 44);

        // 下一个窗口内继续沿用 44
        let mut s = vec![snap(1, 60, &[("10.0.0.1", 60)])];
        assert_eq!(t.apply(&mut s, 60, RATE_WINDOW_MS + 500), 44);
    }

    #[test]
    fn uses_actual_elapsed_time() {
        let mut t = RateTracker::new();
        let mut s = vec![snap(1, 0, &[])];
        t.apply(&mut s, 0, 0);
        // 2 秒内 100 个包 -> 50 pps
        let mut s = vec![snap(1, 100, &[])];
        assert_eq!(t.apply(&mut s, 100, 2000), 50);
    }

    #[test]
    fn per_source_rates_are_independent() {
        let mut t = RateTracker::new();
        let mut s = vec![snap(1, 0, &[("10.0.0.1", 0), ("10.0.0.2", 0)])];
        t.apply(&mut s, 0, 0);
        let mut s = vec![snap(1, 74, &[("10.0.0.1", 44), ("10.0.0.2", 30)])];
        let total = t.apply(&mut s, 74, 1000);
        assert_eq!(total, 74);
        assert_eq!(s[0].packet_rate, 74);
        assert_eq!(s[0].sources[0].packet_rate, 44);
        assert_eq!(s[0].sources[1].packet_rate, 30);
    }

    #[test]
    fn counter_going_backwards_yields_zero_without_underflow() {
        let mut t = RateTracker::new();
        let mut s = vec![snap(1, 500, &[("10.0.0.1", 500)])];
        t.apply(&mut s, 500, 0);
        // 来源被剔除后重建，累计值从小数重新开始
        let mut s = vec![snap(1, 10, &[("10.0.0.1", 10)])];
        assert_eq!(t.apply(&mut s, 10, 1000), 0);
        assert_eq!(s[0].sources[0].packet_rate, 0);
        // 之后恢复正常
        let mut s = vec![snap(1, 54, &[("10.0.0.1", 54)])];
        assert_eq!(t.apply(&mut s, 54, 2000), 44);
    }

    #[test]
    fn vanished_universe_is_forgotten_and_new_one_starts_from_zero() {
        let mut t = RateTracker::new();
        let mut s = vec![snap(1, 0, &[]), snap(2, 0, &[])];
        t.apply(&mut s, 0, 0);
        let mut s = vec![snap(1, 44, &[]), snap(2, 44, &[])];
        t.apply(&mut s, 88, 1000);
        // universe 2 消失，universe 3 出现
        let mut s = vec![snap(1, 88, &[]), snap(3, 30, &[])];
        t.apply(&mut s, 118, 2000);
        assert_eq!(s[0].packet_rate, 44);
        assert_eq!(s[1].packet_rate, 30);
        // 之后 universe 2 再次出现，没有残留的旧速率
        let mut s = vec![snap(2, 5, &[])];
        t.apply(&mut s, 123, 2500);
        assert_eq!(s[0].packet_rate, 0);
    }

    #[test]
    fn reset_clears_baseline() {
        let mut t = RateTracker::new();
        let mut s = vec![snap(1, 0, &[])];
        t.apply(&mut s, 0, 0);
        let mut s = vec![snap(1, 44, &[])];
        assert_eq!(t.apply(&mut s, 44, 1000), 44);
        t.reset();
        let mut s = vec![snap(1, 88, &[])];
        assert_eq!(t.apply(&mut s, 88, 1100), 0);
        assert_eq!(s[0].packet_rate, 0);
    }
}
