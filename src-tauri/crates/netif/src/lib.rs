//! 网络接口枚举（供设置页接口下拉与多网卡配置使用）与 Art-Net 广播目标计算。

use std::net::Ipv4Addr;

use serde::Serialize;

/// 一块网络接口的精简信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceDto {
    /// 接口名称。
    pub name: String,
    /// IPv4 地址（点分十进制）。
    pub ip: String,
    /// 是否为回环接口。
    pub is_loopback: bool,
}

/// 由 IP 与子网掩码计算定向广播地址。
///
/// # Arguments
///
/// * `ip` - 接口 IPv4 地址。
/// * `netmask` - 子网掩码。
///
/// # Returns
///
/// 该子网的定向广播地址（主机位全 1）。
#[must_use]
pub fn directed_broadcast(ip: Ipv4Addr, netmask: Ipv4Addr) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(ip) | !u32::from(netmask))
}

/// 枚举主动发现（ArtPoll）应广播到的全部 IPv4 目标。
///
/// 对每块非回环接口取其子网定向广播地址，最后追加受限广播
/// `255.255.255.255`。多网卡时仅发受限广播只会走默认路由接口，
/// 所以必须逐个子网发送才能覆盖灯光网络所在的网卡。
///
/// # Returns
///
/// 去重后的广播目标列表；枚举失败时只含 `255.255.255.255`。
#[must_use]
pub fn broadcast_targets() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let if_addrs::IfAddr::V4(v4) = &iface.addr {
                let target = v4
                    .broadcast
                    .unwrap_or_else(|| directed_broadcast(v4.ip, v4.netmask));
                if !out.contains(&target) {
                    out.push(target);
                }
            }
        }
    }
    if !out.contains(&Ipv4Addr::BROADCAST) {
        out.push(Ipv4Addr::BROADCAST);
    }
    out
}

/// 枚举本机所有 IPv4 网络接口。
///
/// # Returns
///
/// 接口列表（含一个表示"全部接口"的 `0.0.0.0` 虚拟项置于首位）。
/// 跨平台由 `if-addrs` 提供；失败时仅返回 `0.0.0.0` 项。
#[must_use]
pub fn list_interfaces() -> Vec<NetworkInterfaceDto> {
    let mut out = vec![NetworkInterfaceDto {
        name: "全部接口".to_string(),
        ip: "0.0.0.0".to_string(),
        is_loopback: false,
    }];

    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if let std::net::IpAddr::V4(v4) = iface.ip() {
                out.push(NetworkInterfaceDto {
                    name: iface.name.clone(),
                    ip: v4.to_string(),
                    is_loopback: iface.is_loopback(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::{broadcast_targets, directed_broadcast};

    #[test]
    fn directed_broadcast_fills_host_bits() {
        assert_eq!(
            directed_broadcast(Ipv4Addr::new(192, 168, 1, 23), Ipv4Addr::new(255, 255, 255, 0)),
            Ipv4Addr::new(192, 168, 1, 255)
        );
        assert_eq!(
            directed_broadcast(Ipv4Addr::new(2, 0, 0, 5), Ipv4Addr::new(255, 0, 0, 0)),
            Ipv4Addr::new(2, 255, 255, 255)
        );
    }

    #[test]
    fn broadcast_targets_always_include_limited_broadcast() {
        let targets = broadcast_targets();
        assert!(targets.contains(&Ipv4Addr::BROADCAST));
        // 无重复
        let mut sorted = targets.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), targets.len());
    }
}
