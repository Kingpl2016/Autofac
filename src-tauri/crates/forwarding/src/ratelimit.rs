//! 每（目的地 × 目标 Universe）输出限速。

use std::collections::HashMap;

/// Art-Net/sACN 输出上限 44Hz 对应的最小间隔（毫秒）。
pub const MIN_INTERVAL_MS_44HZ: u64 = 1000 / 44;

/// 基于最近发送时刻的限速器。
#[derive(Debug, Default)]
pub struct RateLimiter {
    last: HashMap<(String, u16), u64>,
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
        let key = (dest_id.to_string(), universe);
        match self.last.get(&key) {
            Some(&t) if now_ms.saturating_sub(t) < min_interval_ms => false,
            _ => {
                self.last.insert(key, now_ms);
                true
            }
        }
    }
}
