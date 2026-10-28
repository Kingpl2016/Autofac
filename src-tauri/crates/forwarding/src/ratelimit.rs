//! 每（目的地 × 目标 Universe）输出限速。

use std::collections::HashMap;

/// Art-Net/sACN 输出上限 44Hz 对应的最小间隔（毫秒）。
pub const MIN_INTERVAL_MS_44HZ: u64 = 1000 / 44;

/// 基于最近发送时刻的限速器。
///
/// 以"目的地 → (目标 Universe → 最近发送时刻)"两层映射存储。稳态下所有目的地
/// 均已建表，热路径 [`RateLimiter::allow`] 通过 `&str` 借用查询，不再每帧为
/// `dest_id` 分配 `String`；仅首次见到某目的地时分配一次键。
#[derive(Debug, Default)]
pub struct RateLimiter {
    last: HashMap<String, HashMap<u16, u64>>,
}

impl RateLimiter {
    /// 创建空限速器。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 判断某（目的地，目标 Universe）此刻是否允许发送，允许则记录时间。
    ///
    /// # Arguments
    ///
    /// * `dest_id` - 目的地 ID。
    /// * `universe` - 目标 Universe。
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    /// * `min_interval_ms` - 最小发送间隔（毫秒）。
    ///
    /// # Returns
    ///
    /// 允许发送返回 `true`（并更新时间戳），否则 `false`。
    pub fn allow(
        &mut self,
        dest_id: &str,
        universe: u16,
        now_ms: u64,
        min_interval_ms: u64,
    ) -> bool {
        // 已知目的地：借用查询，命中限流直接返回，零分配。
        if let Some(inner) = self.last.get_mut(dest_id) {
            if let Some(&t) = inner.get(&universe)
                && now_ms.saturating_sub(t) < min_interval_ms {
                    return false;
                }
            inner.insert(universe, now_ms);
            return true;
        }
        // 首次见到该目的地：分配一次键。
        self.last
            .entry(dest_id.to_string())
            .or_default()
            .insert(universe, now_ms);
        true
    }

    /// 清空全部限速状态（转发表变更后调用，避免已删除目的地的条目残留）。
    pub fn clear(&mut self) {
        self.last.clear();
    }
}
