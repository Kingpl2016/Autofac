//! 录制磁盘空间守卫（纯逻辑）：阈值分级与"电平变化才通知"的状态机。
//!
//! 真实剩余空间的查询由宿主层提供（便于测试时注入假值），本模块只负责：
//!
//! - 把剩余字节数划分为 [`DiskLevel`]；
//! - 判断是否允许开始录制（[`can_start`]）；
//! - 用 [`DiskGuard`] 在电平**发生变化**时才返回通知，避免每次检查都刷事件。
//!
//! 阈值与参考应用保持一致：开始录制至少 500 MB，低于 1 GB 告警，低于 100 MB 自动停止。

use serde::Serialize;

/// 允许开始录制所需的最小剩余空间（字节）。
pub const MIN_START_FREE_BYTES: u64 = 500_000_000;
/// 低于该值进入 [`DiskLevel::Low`]（字节）。
pub const WARN_FREE_BYTES: u64 = 1_000_000_000;
/// 低于该值进入 [`DiskLevel::Critical`]，录制应自动停止（字节）。
pub const CRITICAL_FREE_BYTES: u64 = 100_000_000;

/// 磁盘剩余空间等级。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiskLevel {
    /// 空间充足。
    #[default]
    Ok,
    /// 空间偏低：应告警，但仍可继续录制。
    Low,
    /// 空间即将耗尽：应自动收尾并停止录制。
    Critical,
}

/// 把剩余字节数划分为 [`DiskLevel`]。
///
/// # Arguments
///
/// * `free_bytes` - 录制目录所在卷的可用字节数。
///
/// # Returns
///
/// 小于 [`CRITICAL_FREE_BYTES`] 为 [`DiskLevel::Critical`]；小于 [`WARN_FREE_BYTES`] 为
/// [`DiskLevel::Low`]；其余为 [`DiskLevel::Ok`]。
#[must_use]
pub fn classify(free_bytes: u64) -> DiskLevel {
    if free_bytes < CRITICAL_FREE_BYTES {
        DiskLevel::Critical
    } else if free_bytes < WARN_FREE_BYTES {
        DiskLevel::Low
    } else {
        DiskLevel::Ok
    }
}

/// 剩余空间是否允许开始一次新录制。
///
/// # Arguments
///
/// * `free_bytes` - 录制目录所在卷的可用字节数。
///
/// # Returns
///
/// 不小于 [`MIN_START_FREE_BYTES`] 时为 `true`。
#[must_use]
pub fn can_start(free_bytes: u64) -> bool {
    free_bytes >= MIN_START_FREE_BYTES
}

/// 磁盘空间守卫：记住上一次的等级，只在等级变化时产出通知。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskGuard {
    /// 上一次观察到的等级；初始为 [`DiskLevel::Ok`]。
    level: DiskLevel,
}

impl Default for DiskGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl DiskGuard {
    /// 创建初始等级为 [`DiskLevel::Ok`] 的守卫。
    #[must_use]
    pub fn new() -> Self {
        Self { level: DiskLevel::Ok }
    }

    /// 当前记住的等级。
    ///
    /// # Returns
    ///
    /// 最近一次 [`DiskGuard::observe`] 之后的等级。
    #[must_use]
    pub fn level(&self) -> DiskLevel {
        self.level
    }

    /// 观察一次剩余空间。
    ///
    /// # Arguments
    ///
    /// * `free_bytes` - 录制目录所在卷的可用字节数。
    ///
    /// # Returns
    ///
    /// 等级相对上一次发生变化（含恢复到 [`DiskLevel::Ok`]）时返回 `Some(新等级)`，
    /// 否则返回 `None`。
    pub fn observe(&mut self, free_bytes: u64) -> Option<DiskLevel> {
        let next = classify(free_bytes);
        if next == self.level {
            None
        } else {
            self.level = next;
            Some(next)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        can_start, classify, DiskGuard, DiskLevel, CRITICAL_FREE_BYTES, MIN_START_FREE_BYTES,
        WARN_FREE_BYTES,
    };

    #[test]
    fn classify_boundaries() {
        assert_eq!(classify(u64::MAX), DiskLevel::Ok);
        assert_eq!(classify(WARN_FREE_BYTES), DiskLevel::Ok);
        assert_eq!(classify(WARN_FREE_BYTES - 1), DiskLevel::Low);
        assert_eq!(classify(CRITICAL_FREE_BYTES), DiskLevel::Low);
        assert_eq!(classify(CRITICAL_FREE_BYTES - 1), DiskLevel::Critical);
        assert_eq!(classify(0), DiskLevel::Critical);
    }

    #[test]
    fn start_requires_minimum_free_space() {
        assert!(can_start(MIN_START_FREE_BYTES));
        assert!(!can_start(MIN_START_FREE_BYTES - 1));
    }

    #[test]
    fn guard_notifies_only_on_level_change() {
        let mut g = DiskGuard::new();
        assert_eq!(g.observe(5_000_000_000), None, "初始即充足，不通知");
        assert_eq!(g.observe(900_000_000), Some(DiskLevel::Low));
        assert_eq!(g.observe(800_000_000), None, "仍是 Low，不重复通知");
        assert_eq!(g.observe(50_000_000), Some(DiskLevel::Critical));
        assert_eq!(g.observe(60_000_000), None);
        assert_eq!(g.observe(2_000_000_000), Some(DiskLevel::Ok), "恢复也要通知");
        assert_eq!(g.level(), DiskLevel::Ok);
    }
}
