//! 录制过滤条件：按来源 IP、Universe 范围与协议筛选进入录制的 DMX 帧。

use std::net::IpAddr;

use artnet_net::{DmxFrame, Protocol};
use serde::{Deserialize, Serialize};

/// 闭区间 Universe 范围 `[start, end]`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniverseRange {
    /// 起始 Universe（含）。
    pub start: u16,
    /// 结束 Universe（含）。
    pub end: u16,
}

impl UniverseRange {
    /// 范围是否包含某 Universe（自动容忍 `start > end` 的颠倒输入）。
    ///
    /// # Arguments
    ///
    /// * `universe` - 待判定的 Universe 编号。
    ///
    /// # Returns
    ///
    /// `universe` 落在闭区间内（若 `start > end` 则按交换后的区间判定）返回 `true`，否则返回 `false`。
    #[must_use]
    pub fn contains(&self, universe: u16) -> bool {
        let (lo, hi) = if self.start <= self.end {
            (self.start, self.end)
        } else {
            (self.end, self.start)
        };
        (lo..=hi).contains(&universe)
    }
}

/// 录制过滤条件。三类条件取交集；任一类条件为空表示该维度不限制。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordFilter {
    /// 来源 IP 集合；空表示不按来源过滤。
    pub sources: Vec<IpAddr>,
    /// `true` 时 `sources` 为黑名单（排除这些来源），否则为白名单。
    pub exclude_sources: bool,
    /// Universe 范围集合；空表示不限制。
    pub universes: Vec<UniverseRange>,
    /// 协议集合；空表示不限制。
    pub protocols: Vec<Protocol>,
}

impl RecordFilter {
    /// 帧是否通过过滤。
    ///
    /// 未知来源（`DmxFrame.source == None`）视为 `0.0.0.0`，与信号引擎口径一致。
    ///
    /// # Arguments
    ///
    /// * `frame` - 待判定的帧。
    ///
    /// # Returns
    ///
    /// 通过过滤（应被录制）返回 `true`。
    #[must_use]
    pub fn matches(&self, frame: &DmxFrame) -> bool {
        self.matches_parts(frame.protocol, frame.universe, frame.source)
    }

    /// 不构造完整帧、直接按要素判定（用于对"当前活跃 Universe / 来源"做预筛选）。
    ///
    /// # Arguments
    ///
    /// * `protocol` - 协议。
    /// * `universe` - Universe 编号。
    /// * `source` - 来源 IP；`None` 视为 `0.0.0.0`。
    ///
    /// # Returns
    ///
    /// 协议、Universe 与来源三类条件均满足（空条件视为不限制）时返回 `true`，否则返回 `false`。
    #[must_use]
    pub fn matches_parts(
        &self,
        protocol: Protocol,
        universe: u16,
        source: Option<IpAddr>,
    ) -> bool {
        if !self.protocols.is_empty() && !self.protocols.contains(&protocol) {
            return false;
        }
        if !self.matches_universe(universe) {
            return false;
        }
        if !self.sources.is_empty() {
            let src = source.unwrap_or_else(signal_engine::unknown_source);
            let listed = self.sources.contains(&src);
            if listed == self.exclude_sources {
                return false;
            }
        }
        true
    }

    /// Universe 是否落入范围条件（空条件恒为真）。
    ///
    /// # Arguments
    ///
    /// * `universe` - 待判定的 Universe 编号。
    ///
    /// # Returns
    ///
    /// `universes` 为空，或 `universe` 落入其中任一范围时返回 `true`，否则返回 `false`。
    #[must_use]
    pub fn matches_universe(&self, universe: u16) -> bool {
        self.universes.is_empty() || self.universes.iter().any(|r| r.contains(universe))
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use artnet_net::{DmxFrame, Protocol};

    use super::{RecordFilter, UniverseRange};

    fn frame(protocol: Protocol, universe: u16, ip: Option<[u8; 4]>) -> DmxFrame {
        DmxFrame {
            protocol,
            universe,
            data: vec![0; 4],
            source: ip.map(|o| IpAddr::V4(Ipv4Addr::from(o))),
            sequence: 0,
            received_at: std::time::Instant::now(),
        }
    }

    fn ip(o: [u8; 4]) -> IpAddr {
        IpAddr::V4(Ipv4Addr::from(o))
    }

    #[test]
    fn default_filter_accepts_everything() {
        let f = RecordFilter::default();
        assert!(f.matches(&frame(Protocol::ArtNet, 3, Some([10, 0, 0, 1]))));
        assert!(f.matches(&frame(Protocol::Sacn, 999, None)));
    }

    #[test]
    fn source_whitelist() {
        let f = RecordFilter {
            sources: vec![ip([10, 0, 0, 1])],
            ..RecordFilter::default()
        };
        assert!(f.matches(&frame(Protocol::ArtNet, 1, Some([10, 0, 0, 1]))));
        assert!(!f.matches(&frame(Protocol::ArtNet, 1, Some([10, 0, 0, 2]))));
        // 未知来源不在白名单内
        assert!(!f.matches(&frame(Protocol::ArtNet, 1, None)));
    }

    #[test]
    fn source_blacklist() {
        let f = RecordFilter {
            sources: vec![ip([10, 0, 0, 1])],
            exclude_sources: true,
            ..RecordFilter::default()
        };
        assert!(!f.matches(&frame(Protocol::ArtNet, 1, Some([10, 0, 0, 1]))));
        assert!(f.matches(&frame(Protocol::ArtNet, 1, Some([10, 0, 0, 2]))));
        assert!(f.matches(&frame(Protocol::ArtNet, 1, None)));
    }

    #[test]
    fn universe_ranges_and_protocols_intersect() {
        let f = RecordFilter {
            universes: vec![
                UniverseRange { start: 0, end: 3 },
                UniverseRange { start: 10, end: 10 },
            ],
            protocols: vec![Protocol::ArtNet],
            ..RecordFilter::default()
        };
        assert!(f.matches(&frame(Protocol::ArtNet, 2, None)));
        assert!(f.matches(&frame(Protocol::ArtNet, 10, None)));
        assert!(!f.matches(&frame(Protocol::ArtNet, 4, None)));
        assert!(!f.matches(&frame(Protocol::Sacn, 2, None)));
    }

    #[test]
    fn reversed_range_is_tolerated() {
        let r = UniverseRange { start: 8, end: 2 };
        assert!(r.contains(5));
        assert!(!r.contains(9));
    }

    #[test]
    fn serde_roundtrip_camel_case() {
        let f = RecordFilter {
            sources: vec![ip([192, 168, 1, 5])],
            exclude_sources: true,
            universes: vec![UniverseRange { start: 1, end: 4 }],
            protocols: vec![Protocol::Sacn],
        };
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains("excludeSources"));
        assert!(json.contains("\"sacn\""));
        assert_eq!(serde_json::from_str::<RecordFilter>(&json).unwrap(), f);
        // 缺省字段回落默认
        assert_eq!(serde_json::from_str::<RecordFilter>("{}").unwrap(), RecordFilter::default());
    }
}
