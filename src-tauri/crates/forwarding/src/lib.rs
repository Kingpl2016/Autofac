//! 信号转发：目的地路由解析、per-universe 覆盖、偏移/延迟、范围记法与 44Hz 限速。
//!
//! 本 crate 为纯逻辑（无 IO）：解析"源 Universe → 各目的地的目标 Universe/延迟"，
//! 实际 UDP 发送与延迟调度由宿主层完成。

mod model;
mod range;
mod ratelimit;

pub use model::{
    ForwardDestination, ForwardMode, ForwardProtocol, OverrideAction, ResolvedRoute,
    UniverseOverride,
};
pub use range::{format_range, parse_range};
pub use ratelimit::{RateLimiter, MIN_INTERVAL_MS_44HZ};

use serde::{Deserialize, Serialize};

/// 转发目的地集合（持久化单元）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardingTable {
    /// 目的地列表。
    pub destinations: Vec<ForwardDestination>,
}

impl ForwardingTable {
    /// 针对某源 Universe，解析所有启用目的地的转发路由。
    ///
    /// # Arguments
    ///
    /// * `source_universe` - 源 Universe 编号。
    ///
    /// # Returns
    ///
    /// `(目的地, 解析路由)` 列表，仅含需转发者。
    #[must_use]
    pub fn routes_for(
        &self,
        source_universe: u16,
    ) -> Vec<(&ForwardDestination, ResolvedRoute)> {
        self.destinations
            .iter()
            .filter_map(|d| d.resolve(source_universe).map(|r| (d, r)))
            .collect()
    }

    /// 从 JSON 文本解析目的地集合。
    ///
    /// # Arguments
    ///
    /// * `json` - JSON 文本（目的地数组）。
    ///
    /// # Returns
    ///
    /// 解析出的转发表。
    ///
    /// # Errors
    ///
    /// JSON 解析失败时返回 [`serde_json::Error`]。
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        Ok(Self {
            destinations: serde_json::from_str(json)?,
        })
    }

    /// 序列化为美化 JSON 文本。
    ///
    /// # Returns
    ///
    /// 目的地数组的 JSON 文本。
    ///
    /// # Errors
    ///
    /// 序列化失败时返回 [`serde_json::Error`]。
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(&self.destinations)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dest(mode: ForwardMode) -> ForwardDestination {
        ForwardDestination {
            id: "d1".into(),
            name: "Main".into(),
            target_ip: "10.0.0.5".into(),
            protocol: ForwardProtocol::ArtNet,
            port: 6454,
            mode,
            universe_offset: 0,
            default_delay_ms: 0,
            description: String::new(),
            enabled: true,
            overrides: Vec::new(),
        }
    }

    #[test]
    fn parse_range_mixed() {
        assert_eq!(parse_range("0-3,10,12-13"), vec![0, 1, 2, 3, 10, 12, 13]);
        assert_eq!(parse_range(" 5 , 5 , 4 "), vec![4, 5]);
        assert_eq!(parse_range("8-6"), vec![6, 7, 8]); // 反序自动纠正
    }

    #[test]
    fn format_range_compacts() {
        assert_eq!(format_range(&[0, 1, 2, 3, 10, 12, 13]), "0-3,10,12-13");
    }

    #[test]
    fn all_mode_forwards_with_offset() {
        let mut d = dest(ForwardMode::All);
        d.universe_offset = 100;
        let r = d.resolve(5).unwrap();
        assert_eq!(r.target_universe, 105);
    }

    #[test]
    fn all_mode_exclude_override_blocks() {
        let mut d = dest(ForwardMode::All);
        d.overrides.push(UniverseOverride {
            source_universe: 7,
            action: OverrideAction::Exclude,
            target_universe: None,
            delay_ms: None,
        });
        assert!(d.resolve(7).is_none());
        assert!(d.resolve(8).is_some());
    }

    #[test]
    fn selected_mode_only_forwards_included() {
        let mut d = dest(ForwardMode::Selected);
        d.overrides.push(UniverseOverride {
            source_universe: 3,
            action: OverrideAction::Forward,
            target_universe: Some(30),
            delay_ms: Some(500),
        });
        assert!(d.resolve(1).is_none());
        let r = d.resolve(3).unwrap();
        assert_eq!(r.target_universe, 30);
        assert_eq!(r.delay_ms, 500);
    }

    #[test]
    fn disabled_destination_never_forwards() {
        let mut d = dest(ForwardMode::All);
        d.enabled = false;
        assert!(d.resolve(0).is_none());
    }

    #[test]
    fn rate_limiter_caps() {
        let mut rl = RateLimiter::new();
        assert!(rl.allow("d1", 1, 0, 20));
        assert!(!rl.allow("d1", 1, 10, 20)); // 10ms < 20ms
        assert!(rl.allow("d1", 1, 25, 20)); // 25ms >= 20ms
        assert!(rl.allow("d1", 2, 10, 20)); // 不同 universe 独立
    }

    #[test]
    fn table_json_roundtrip() {
        let mut t = ForwardingTable::default();
        t.destinations.push(dest(ForwardMode::All));
        let json = t.to_json().unwrap();
        assert_eq!(ForwardingTable::from_json(&json).unwrap(), t);
    }
}
