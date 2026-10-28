//! sACN 接收方案：由配置与本机网卡解析出"应该监听什么"。
//!
//! 纯逻辑，不碰套接字，便于单测。运行时据此决定是否需要（重）建 sACN 接收任务。

use std::net::Ipv4Addr;

use netif::NetworkInterfaceDto;
use settings::{AppSettings, NetworkMode};

/// 一次 sACN 接收的完整参数。两次相等表示无需重建接收任务。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SacnPlan {
    /// 监听端口。
    pub port: u16,
    /// 订阅的 Universe（升序去重，由配置规范化保证）。
    pub universes: Vec<u16>,
    /// 加入组播所用的本地网卡 IPv4。
    pub ifaces: Vec<Ipv4Addr>,
}

/// 解析需要加入 sACN 组播的本地网卡。
///
/// 规则：
/// - 全局 `sacn_enabled` 关闭：空；
/// - 单网卡模式：`network.interface`（`0.0.0.0` 表示由系统选择）；
/// - 多网卡模式：非回环 IPv4 网卡中，`NicConfig.sacn_enabled` 为真的那些。
///   不在 `multi_nic` 里的网卡视为启用，与设置页的显示一致。
///   同名网卡的多个 IP 都会展开，结果去重并保持枚举顺序。
///
/// # Arguments
///
/// * `cfg` - 当前配置。
/// * `interfaces` - 本机网卡列表（含首项"全部接口 0.0.0.0"虚拟项）。
///
/// # Returns
///
/// 需要加入组播的网卡 IPv4 列表；为空表示不应启动接收。
#[must_use]
pub fn resolve_sacn_ifaces(
    cfg: &AppSettings,
    interfaces: &[NetworkInterfaceDto],
) -> Vec<Ipv4Addr> {
    if !cfg.protocol.sacn_enabled {
        return Vec::new();
    }
    match cfg.network.mode {
        NetworkMode::Single => vec![cfg
            .network
            .interface
            .parse()
            .unwrap_or(Ipv4Addr::UNSPECIFIED)],
        NetworkMode::MultiNic => {
            let mut out: Vec<Ipv4Addr> = Vec::new();
            for nic in interfaces {
                if nic.is_loopback {
                    continue;
                }
                let Ok(ip) = nic.ip.parse::<Ipv4Addr>() else {
                    continue;
                };
                // 跳过"全部接口"虚拟项
                if ip.is_unspecified() {
                    continue;
                }
                let enabled = cfg
                    .network
                    .multi_nic
                    .iter()
                    .find(|n| n.name == nic.name)
                    .is_none_or(|n| n.sacn_enabled);
                if enabled && !out.contains(&ip) {
                    out.push(ip);
                }
            }
            out
        }
    }
}

/// 由配置与网卡列表生成 sACN 接收方案。
///
/// # Returns
///
/// `None` 表示不应监听 sACN：全局关闭，或多网卡模式下没有任何启用的网卡。
#[must_use]
pub fn plan_sacn(cfg: &AppSettings, interfaces: &[NetworkInterfaceDto]) -> Option<SacnPlan> {
    let ifaces = resolve_sacn_ifaces(cfg, interfaces);
    if ifaces.is_empty() {
        return None;
    }
    Some(SacnPlan {
        port: cfg.protocol.sacn_port,
        universes: cfg.protocol.sacn_universes.clone(),
        ifaces,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use settings::NicConfig;

    fn nic(name: &str, ip: &str, loopback: bool) -> NetworkInterfaceDto {
        NetworkInterfaceDto {
            name: name.into(),
            ip: ip.into(),
            is_loopback: loopback,
        }
    }

    fn interfaces() -> Vec<NetworkInterfaceDto> {
        vec![
            nic("全部接口", "0.0.0.0", false),
            nic("Ethernet", "192.168.1.10", false),
            nic("Ethernet", "10.0.0.5", false), // 同名网卡的第二个 IP
            nic("Wi-Fi", "192.168.2.20", false),
            nic("Loopback", "127.0.0.1", true),
        ]
    }

    fn cfg(enabled: bool, mode: NetworkMode) -> AppSettings {
        let mut c = AppSettings::default();
        c.protocol.sacn_enabled = enabled;
        c.network.mode = mode;
        c
    }

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn global_off_means_nothing_regardless_of_nic_switches() {
        let mut c = cfg(false, NetworkMode::MultiNic);
        c.network.multi_nic = vec![NicConfig {
            name: "Ethernet".into(),
            artnet_enabled: true,
            sacn_enabled: true,
        }];
        assert!(resolve_sacn_ifaces(&c, &interfaces()).is_empty());
        assert!(plan_sacn(&c, &interfaces()).is_none());
    }

    #[test]
    fn single_mode_uses_selected_interface() {
        let mut c = cfg(true, NetworkMode::Single);
        c.network.interface = "192.168.2.20".into();
        assert_eq!(resolve_sacn_ifaces(&c, &interfaces()), vec![ip("192.168.2.20")]);

        // 默认"全部接口"交给系统选择
        c.network.interface = "0.0.0.0".into();
        assert_eq!(resolve_sacn_ifaces(&c, &interfaces()), vec![Ipv4Addr::UNSPECIFIED]);

        // 无法解析的值回落为系统选择，而不是启动失败
        c.network.interface = "not-an-ip".into();
        assert_eq!(resolve_sacn_ifaces(&c, &interfaces()), vec![Ipv4Addr::UNSPECIFIED]);
    }

    #[test]
    fn multi_nic_defaults_unlisted_nics_to_enabled() {
        let c = cfg(true, NetworkMode::MultiNic);
        // 未配置的网卡全部启用；跳过回环与"全部接口"；同名网卡的多个 IP 都在
        assert_eq!(
            resolve_sacn_ifaces(&c, &interfaces()),
            vec![ip("192.168.1.10"), ip("10.0.0.5"), ip("192.168.2.20")]
        );
    }

    #[test]
    fn multi_nic_respects_per_nic_switch_and_expands_same_name() {
        let mut c = cfg(true, NetworkMode::MultiNic);
        c.network.multi_nic = vec![
            NicConfig { name: "Ethernet".into(), artnet_enabled: true, sacn_enabled: false },
            NicConfig { name: "Wi-Fi".into(), artnet_enabled: false, sacn_enabled: true },
        ];
        // Ethernet 关闭 → 它的两个 IP 都不在；Wi-Fi 的 artnet 开关不影响 sACN
        assert_eq!(resolve_sacn_ifaces(&c, &interfaces()), vec![ip("192.168.2.20")]);
    }

    #[test]
    fn multi_nic_all_off_yields_no_plan() {
        let mut c = cfg(true, NetworkMode::MultiNic);
        c.network.multi_nic = ["Ethernet", "Wi-Fi"]
            .iter()
            .map(|n| NicConfig { name: (*n).into(), artnet_enabled: true, sacn_enabled: false })
            .collect();
        assert!(resolve_sacn_ifaces(&c, &interfaces()).is_empty());
        assert!(plan_sacn(&c, &interfaces()).is_none());
    }

    #[test]
    fn plan_carries_port_and_universes_and_detects_changes() {
        let mut c = cfg(true, NetworkMode::Single);
        c.protocol.sacn_port = 5570;
        c.protocol.sacn_universes = vec![1, 2];
        let a = plan_sacn(&c, &interfaces()).unwrap();
        assert_eq!((a.port, a.universes.clone()), (5570, vec![1, 2]));

        // 相同配置得到相等方案（运行时据此跳过重建）
        assert_eq!(plan_sacn(&c, &interfaces()).unwrap(), a);

        c.protocol.sacn_port = 5571;
        assert_ne!(plan_sacn(&c, &interfaces()).unwrap(), a);
    }
}
