//! 发送配置与校验：目标地址、协议、Universe 范围。
//!
//! 校验集中在这里（单一事实来源）：界面输入时通过命令调用同一份 [`SignalConfig::validate`]，
//! 发送器启动前也再校验一次，所以非法配置永远到不了网络层。

use std::net::{Ipv4Addr, SocketAddrV4};
use std::ops::RangeInclusive;

use forwarding::try_parse_range;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 一次最多同时发送的 Universe 数（与原版一致，避免每个 tick 的突发包过多）。
pub const MAX_UNIVERSES: usize = 100;

/// Art-Net 默认端口。
pub const ARTNET_PORT: u16 = 6454;
/// sACN 默认端口。
pub const SACN_PORT: u16 = 5568;

/// 发送协议（序列化为 `"artNet"` / `"sacn"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignalProtocol {
    /// Art-Net（ArtDmx）。
    ArtNet,
    /// sACN（E1.31）。
    Sacn,
}

impl SignalProtocol {
    /// 该协议的默认端口。
    ///
    /// # Returns
    ///
    /// Art-Net 为 6454，sACN 为 5568。
    #[must_use]
    pub fn default_port(self) -> u16 {
        match self {
            SignalProtocol::ArtNet => ARTNET_PORT,
            SignalProtocol::Sacn => SACN_PORT,
        }
    }

    /// 该协议允许的 Universe 编号范围。
    ///
    /// # Returns
    ///
    /// Art-Net 为 `0..=32767`（15 位 Port-Address），sACN 为 `1..=63999`（0 无效）。
    #[must_use]
    pub fn universe_bounds(self) -> RangeInclusive<u16> {
        match self {
            SignalProtocol::ArtNet => 0..=32767,
            SignalProtocol::Sacn => 1..=63999,
        }
    }
}

/// 配置校验错误。序列化为 `{ "code": "...", ... }`，前端按 `code` 本地化文案。
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ConfigError {
    /// 目标不是合法的 IPv4 地址。
    #[error("目标 IP `{value}` 不是合法的 IPv4 地址")]
    InvalidIp {
        /// 用户输入的原文。
        value: String,
    },
    /// 端口为 0。
    #[error("端口不能为 0")]
    InvalidPort,
    /// Universe 范围为空。
    #[error("Universe 范围不能为空")]
    EmptyRange,
    /// Universe 范围里有无法解析的片段。
    #[error("无法解析的 Universe 范围片段 `{fragment}`")]
    InvalidRange {
        /// 出错的片段。
        fragment: String,
    },
    /// 某个 Universe 超出所选协议的取值范围。
    #[error("Universe {universe} 超出所选协议允许的范围 {min} 到 {max}")]
    OutOfRange {
        /// 越界的 Universe。
        universe: u16,
        /// 协议允许的最小值。
        min: u16,
        /// 协议允许的最大值。
        max: u16,
    },
    /// Universe 数量超过上限。
    #[error("一次最多发送 {max} 个 Universe，当前为 {count} 个")]
    TooMany {
        /// 实际数量。
        count: usize,
        /// 上限。
        max: usize,
    },
}

/// 用户填写的发送配置（未经校验）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalConfig {
    /// 目标 IPv4 地址（单播、广播均可）。
    pub target_ip: String,
    /// 目标端口。
    pub port: u16,
    /// 发送协议。
    pub protocol: SignalProtocol,
    /// Universe 范围记法，如 `0-50` 或 `0-20,30,40-45`。
    pub universes: String,
}

impl Default for SignalConfig {
    /// 默认向本机 `127.0.0.1:6454` 发送 Art-Net Universe 0，便于回灌自测。
    fn default() -> Self {
        Self {
            target_ip: "127.0.0.1".to_string(),
            port: ARTNET_PORT,
            protocol: SignalProtocol::ArtNet,
            universes: "0".to_string(),
        }
    }
}

/// 通过校验的配置：地址已解析，Universe 已展开、去重并升序。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidConfig {
    /// 目标套接字地址。
    pub target: SocketAddrV4,
    /// 发送协议。
    pub protocol: SignalProtocol,
    /// 要发送的 Universe（升序、无重复，数量 `1..=MAX_UNIVERSES`）。
    pub universes: Vec<u16>,
}

impl Default for ValidConfig {
    /// 与 [`SignalConfig::default`] 校验后的结果相同（`127.0.0.1:6454`、Art-Net、Universe 0）。
    fn default() -> Self {
        Self {
            target: SocketAddrV4::new(Ipv4Addr::LOCALHOST, ARTNET_PORT),
            protocol: SignalProtocol::ArtNet,
            universes: vec![0],
        }
    }
}

impl SignalConfig {
    /// 校验并解析配置。
    ///
    /// 检查顺序：IP、端口、范围语法、是否为空、协议取值范围、数量上限；返回第一个发现的问题。
    ///
    /// # Returns
    ///
    /// 通过校验时返回 [`ValidConfig`]。
    ///
    /// # Errors
    ///
    /// 任一检查不通过时返回对应的 [`ConfigError`] 变体。
    pub fn validate(&self) -> Result<ValidConfig, ConfigError> {
        let ip: Ipv4Addr = self
            .target_ip
            .trim()
            .parse()
            .map_err(|_| ConfigError::InvalidIp {
                value: self.target_ip.clone(),
            })?;
        if self.port == 0 {
            return Err(ConfigError::InvalidPort);
        }

        let universes = try_parse_range(&self.universes).map_err(|e| ConfigError::InvalidRange {
            fragment: e.fragment,
        })?;
        if universes.is_empty() {
            return Err(ConfigError::EmptyRange);
        }

        let bounds = self.protocol.universe_bounds();
        if let Some(&bad) = universes.iter().find(|u| !bounds.contains(u)) {
            return Err(ConfigError::OutOfRange {
                universe: bad,
                min: *bounds.start(),
                max: *bounds.end(),
            });
        }
        if universes.len() > MAX_UNIVERSES {
            return Err(ConfigError::TooMany {
                count: universes.len(),
                max: MAX_UNIVERSES,
            });
        }

        Ok(ValidConfig {
            target: SocketAddrV4::new(ip, self.port),
            protocol: self.protocol,
            universes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(ip: &str, port: u16, protocol: SignalProtocol, universes: &str) -> SignalConfig {
        SignalConfig {
            target_ip: ip.to_string(),
            port,
            protocol,
            universes: universes.to_string(),
        }
    }

    #[test]
    fn default_config_is_valid_loopback_artnet() {
        assert_eq!(SignalConfig::default().validate().unwrap(), ValidConfig::default());
        let v = SignalConfig::default().validate().unwrap();
        assert_eq!(v.target, SocketAddrV4::new(Ipv4Addr::LOCALHOST, 6454));
        assert_eq!(v.protocol, SignalProtocol::ArtNet);
        assert_eq!(v.universes, vec![0]);
    }

    #[test]
    fn range_notation_is_expanded_sorted_and_deduplicated() {
        let v = cfg("10.0.0.5", 6454, SignalProtocol::ArtNet, "30,0-2, 1 ,50-48")
            .validate()
            .unwrap();
        assert_eq!(v.universes, vec![0, 1, 2, 30, 48, 49, 50]);
        // 首尾空白的 IP 也能解析
        assert!(cfg(" 10.0.0.5 ", 6454, SignalProtocol::ArtNet, "0").validate().is_ok());
    }

    #[test]
    fn rejects_bad_ip_and_port() {
        for ip in ["", "localhost", "256.0.0.1", "10.0.0", "::1", "10.0.0.1:6454"] {
            assert_eq!(
                cfg(ip, 6454, SignalProtocol::ArtNet, "0").validate(),
                Err(ConfigError::InvalidIp { value: ip.to_string() }),
                "{ip:?}"
            );
        }
        assert_eq!(
            cfg("127.0.0.1", 0, SignalProtocol::ArtNet, "0").validate(),
            Err(ConfigError::InvalidPort)
        );
    }

    #[test]
    fn rejects_empty_and_unparsable_ranges() {
        for empty in ["", "   ", ",,"] {
            assert_eq!(
                cfg("127.0.0.1", 6454, SignalProtocol::ArtNet, empty).validate(),
                Err(ConfigError::EmptyRange),
                "{empty:?}"
            );
        }
        assert_eq!(
            cfg("127.0.0.1", 6454, SignalProtocol::ArtNet, "0-5,x").validate(),
            Err(ConfigError::InvalidRange { fragment: "x".into() })
        );
        assert_eq!(
            cfg("127.0.0.1", 6454, SignalProtocol::ArtNet, "-3").validate(),
            Err(ConfigError::InvalidRange { fragment: "-3".into() })
        );
    }

    #[test]
    fn universe_bounds_follow_the_protocol() {
        // Art-Net：0 到 32767
        assert!(cfg("127.0.0.1", 6454, SignalProtocol::ArtNet, "0,32767").validate().is_ok());
        assert_eq!(
            cfg("127.0.0.1", 6454, SignalProtocol::ArtNet, "32768").validate(),
            Err(ConfigError::OutOfRange { universe: 32768, min: 0, max: 32767 })
        );
        // sACN：1 到 63999，0 无效
        assert!(cfg("127.0.0.1", 5568, SignalProtocol::Sacn, "1,63999").validate().is_ok());
        assert_eq!(
            cfg("127.0.0.1", 5568, SignalProtocol::Sacn, "0-3").validate(),
            Err(ConfigError::OutOfRange { universe: 0, min: 1, max: 63999 })
        );
        assert_eq!(
            cfg("127.0.0.1", 5568, SignalProtocol::Sacn, "64000").validate(),
            Err(ConfigError::OutOfRange { universe: 64000, min: 1, max: 63999 })
        );
    }

    #[test]
    fn caps_the_number_of_universes() {
        assert_eq!(
            cfg("127.0.0.1", 6454, SignalProtocol::ArtNet, "0-99").validate().unwrap().universes.len(),
            100
        );
        assert_eq!(
            cfg("127.0.0.1", 6454, SignalProtocol::ArtNet, "0-100").validate(),
            Err(ConfigError::TooMany { count: 101, max: 100 })
        );
        // 去重后才计数：重复写同一段不会误触上限
        assert!(cfg("127.0.0.1", 6454, SignalProtocol::ArtNet, "0-99,0-99").validate().is_ok());
    }

    #[test]
    fn protocol_defaults_and_serde_names() {
        assert_eq!(SignalProtocol::ArtNet.default_port(), 6454);
        assert_eq!(SignalProtocol::Sacn.default_port(), 5568);
        assert_eq!(serde_json::to_string(&SignalProtocol::ArtNet).unwrap(), "\"artNet\"");
        assert_eq!(serde_json::to_string(&SignalProtocol::Sacn).unwrap(), "\"sacn\"");
    }

    #[test]
    fn errors_serialize_with_a_code_for_the_frontend() {
        let json = |e: &ConfigError| serde_json::to_value(e).unwrap();
        assert_eq!(json(&ConfigError::InvalidPort), serde_json::json!({ "code": "invalidPort" }));
        assert_eq!(
            json(&ConfigError::OutOfRange { universe: 0, min: 1, max: 63999 }),
            serde_json::json!({ "code": "outOfRange", "universe": 0, "min": 1, "max": 63999 })
        );
        assert_eq!(
            json(&ConfigError::TooMany { count: 101, max: 100 }),
            serde_json::json!({ "code": "tooMany", "count": 101, "max": 100 })
        );
    }

    #[test]
    fn config_round_trips_through_camel_case_json() {
        let c = cfg("10.0.0.9", 5568, SignalProtocol::Sacn, "1-4");
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "targetIp": "10.0.0.9", "port": 5568, "protocol": "sacn", "universes": "1-4"
            })
        );
        assert_eq!(serde_json::from_value::<SignalConfig>(v).unwrap(), c);
    }
}
