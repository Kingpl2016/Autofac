//! 网络设备发现：合并 Art-Net 节点回复与被动观测到的源，按类别归类，
//! 维护在线状态与用户自定义名。
//!
//! 反向 DNS 与 ARP MAC 为平台相关的尽力而为增强，由宿主层注入；本 crate
//! 只维护设备注册表的合并与分类逻辑（纯逻辑，便于测试）。

use std::collections::HashMap;
use std::net::IpAddr;

use serde::Serialize;

use artnet_net::artnet::PollReplyInfo;
use artnet_net::Protocol;

/// 设备类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceCategory {
    /// Art-Net 节点。
    ArtNet,
    /// sACN 网关/源。
    Sacn,
    /// 集群节点。
    Cluster,
    /// 计算机/控台。
    Computer,
    /// 其它网络设备。
    Network,
}

/// 单个发现到的设备（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// IPv4 地址字符串。
    pub ip: String,
    /// 主机名（反向 DNS 或 Art-Net 长名）。
    pub hostname: Option<String>,
    /// 用户自定义名（持久化）。
    pub custom_name: Option<String>,
    /// MAC 地址（Art-Net 回复或 ARP 提供）。
    pub mac: Option<String>,
    /// 设备类别。
    pub category: DeviceCategory,
    /// Art-Net 端口/Universe 数量。
    pub artnet_ports: Option<u16>,
    /// 是否在线（最近有活动）。
    pub online: bool,
    /// 最后活动逻辑时间（毫秒）。
    pub last_seen_ms: u64,
}

/// 设备注册表：合并多来源的发现信息。
#[derive(Debug, Default)]
pub struct DeviceRegistry {
    devices: HashMap<IpAddr, Device>,
    custom_names: HashMap<IpAddr, String>,
}

impl DeviceRegistry {
    /// 创建空注册表。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 用已有自定义名映射初始化（启动时从磁盘加载）。
    ///
    /// # Arguments
    ///
    /// * `names` - IP 字符串 → 自定义名。
    pub fn load_custom_names(&mut self, names: HashMap<String, String>) {
        for (ip, name) in names {
            if let Ok(addr) = ip.parse::<IpAddr>() {
                self.custom_names.insert(addr, name);
            }
        }
    }

    /// 导出当前自定义名映射（用于持久化）。
    #[must_use]
    pub fn custom_names(&self) -> HashMap<String, String> {
        self.custom_names
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn entry(&mut self, ip: IpAddr, now_ms: u64) -> &mut Device {
        let custom = self.custom_names.get(&ip).cloned();
        self.devices.entry(ip).or_insert_with(|| Device {
            ip: ip.to_string(),
            hostname: None,
            custom_name: custom,
            mac: None,
            category: DeviceCategory::Network,
            artnet_ports: None,
            online: true,
            last_seen_ms: now_ms,
        })
    }

    /// 合并一条 Art-Net 节点回复。
    ///
    /// # Arguments
    ///
    /// * `info` - ArtPollReply 关键字段。
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    pub fn upsert_artnet(&mut self, info: &PollReplyInfo, now_ms: u64) {
        let ip = IpAddr::from(info.ip);
        let mac = format_mac(&info.mac);
        let long = if info.long_name.is_empty() {
            None
        } else {
            Some(info.long_name.clone())
        };
        let ports = info.num_ports;
        let dev = self.entry(ip, now_ms);
        dev.category = DeviceCategory::ArtNet;
        dev.online = true;
        dev.last_seen_ms = now_ms;
        dev.artnet_ports = Some(ports);
        if dev.hostname.is_none() {
            dev.hostname = long;
        }
        if mac.is_some() {
            dev.mac = mac;
        }
    }

    /// 合并一个被动观测到的 DMX 源。
    ///
    /// # Arguments
    ///
    /// * `ip` - 源 IP。
    /// * `protocol` - 来源协议。
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    pub fn upsert_source(&mut self, ip: IpAddr, protocol: Protocol, now_ms: u64) {
        let dev = self.entry(ip, now_ms);
        dev.online = true;
        dev.last_seen_ms = now_ms;
        // 已识别为 Art-Net 节点时不降级分类
        if dev.category != DeviceCategory::ArtNet {
            dev.category = match protocol {
                Protocol::ArtNet => DeviceCategory::ArtNet,
                Protocol::Sacn => DeviceCategory::Sacn,
            };
        }
    }

    /// 设置设备主机名（反向 DNS 结果）。
    pub fn set_hostname(&mut self, ip: IpAddr, hostname: String, now_ms: u64) {
        self.entry(ip, now_ms).hostname = Some(hostname);
    }

    /// 设置设备 MAC（ARP 结果）。
    pub fn set_mac(&mut self, ip: IpAddr, mac: String, now_ms: u64) {
        self.entry(ip, now_ms).mac = Some(mac);
    }

    /// 设置用户自定义名（持久化）。
    ///
    /// # Arguments
    ///
    /// * `ip` - 目标设备 IP。
    /// * `name` - 自定义名；空字符串清除。
    pub fn set_custom_name(&mut self, ip: IpAddr, name: String) {
        if name.is_empty() {
            self.custom_names.remove(&ip);
            if let Some(d) = self.devices.get_mut(&ip) {
                d.custom_name = None;
            }
        } else {
            self.custom_names.insert(ip, name.clone());
            if let Some(d) = self.devices.get_mut(&ip) {
                d.custom_name = Some(name);
            }
        }
    }

    /// 将超时未活动的设备标记为离线。
    ///
    /// # Arguments
    ///
    /// * `now_ms` - 当前逻辑时间（毫秒）。
    /// * `timeout_ms` - 离线判定阈值（毫秒）。
    pub fn mark_stale_offline(&mut self, now_ms: u64, timeout_ms: u64) {
        for d in self.devices.values_mut() {
            if now_ms.saturating_sub(d.last_seen_ms) > timeout_ms {
                d.online = false;
            }
        }
    }

    /// 移除全部离线设备（用户自定义名仍保留，设备再次出现时会恢复）。
    ///
    /// # Returns
    ///
    /// 被移除的设备数量。
    pub fn clear_offline(&mut self) -> usize {
        let before = self.devices.len();
        self.devices.retain(|_, d| d.online);
        before - self.devices.len()
    }

    /// 移除指定类别的全部设备（如关闭 sACN 时清掉 sACN 源）。
    ///
    /// 用户自定义名保留，设备再次出现时会恢复。
    ///
    /// # Arguments
    ///
    /// * `category` - 要移除的设备类别。
    ///
    /// # Returns
    ///
    /// 被移除的设备数量。
    pub fn remove_category(&mut self, category: DeviceCategory) -> usize {
        let before = self.devices.len();
        self.devices.retain(|_, d| d.category != category);
        before - self.devices.len()
    }

    /// 统计在 `since_ms` 及之后有过活动的 Art-Net 节点数量。
    ///
    /// # Arguments
    ///
    /// * `since_ms` - 起始逻辑时间（毫秒，含）。
    #[must_use]
    pub fn count_artnet_seen_since(&self, since_ms: u64) -> usize {
        self.devices
            .values()
            .filter(|d| d.category == DeviceCategory::ArtNet && d.last_seen_ms >= since_ms)
            .count()
    }

    /// 当前已知的 Art-Net 节点总数。
    #[must_use]
    pub fn count_artnet(&self) -> usize {
        self.devices
            .values()
            .filter(|d| d.category == DeviceCategory::ArtNet)
            .count()
    }

    /// 返回全部设备（按 IP 升序）。
    #[must_use]
    pub fn list(&self) -> Vec<Device> {
        // 先按 IP（数值序）对引用排序，最后再克隆，避免中间持有整份 Device 拷贝。
        let mut refs: Vec<(&IpAddr, &Device)> = self.devices.iter().collect();
        refs.sort_by_key(|(ip, _)| **ip);
        refs.into_iter().map(|(_, d)| d.clone()).collect()
    }
}

/// 将 6 字节 MAC 格式化为 `AA:BB:CC:DD:EE:FF`；全 0 返回 `None`。
#[must_use]
pub fn format_mac(mac: &[u8; 6]) -> Option<String> {
    if mac.iter().all(|&b| b == 0) {
        return None;
    }
    Some(
        mac.iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use artnet_net::artnet::PollReplyInfo;
    use artnet_net::Protocol;

    use super::{DeviceCategory, DeviceRegistry};

    fn ip(a: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, a))
    }

    #[test]
    fn artnet_upsert_sets_category_and_mac() {
        let mut reg = DeviceRegistry::new();
        let info = PollReplyInfo {
            ip: [192, 168, 1, 10],
            short_name: "N".into(),
            long_name: "Node Long".into(),
            mac: [1, 2, 3, 4, 5, 6],
            num_ports: 4,
        };
        reg.upsert_artnet(&info, 0);
        let d = &reg.list()[0];
        assert_eq!(d.category, DeviceCategory::ArtNet);
        assert_eq!(d.mac.as_deref(), Some("01:02:03:04:05:06"));
        assert_eq!(d.hostname.as_deref(), Some("Node Long"));
        assert_eq!(d.artnet_ports, Some(4));
    }

    #[test]
    fn source_upsert_categorizes_sacn() {
        let mut reg = DeviceRegistry::new();
        reg.upsert_source(ip(20), Protocol::Sacn, 0);
        assert_eq!(reg.list()[0].category, DeviceCategory::Sacn);
    }

    #[test]
    fn artnet_not_downgraded_by_source() {
        let mut reg = DeviceRegistry::new();
        let info = PollReplyInfo {
            ip: [192, 168, 1, 30],
            short_name: String::new(),
            long_name: String::new(),
            mac: [0; 6],
            num_ports: 1,
        };
        reg.upsert_artnet(&info, 0);
        reg.upsert_source(ip(30), Protocol::ArtNet, 1);
        assert_eq!(reg.list()[0].category, DeviceCategory::ArtNet);
    }

    #[test]
    fn remove_category_drops_sacn_but_keeps_names() {
        let mut reg = DeviceRegistry::new();
        reg.upsert_source(ip(90), Protocol::Sacn, 0);
        reg.upsert_source(ip(91), Protocol::ArtNet, 0);
        reg.set_custom_name(ip(90), "舞台右".into());

        assert_eq!(reg.remove_category(DeviceCategory::Sacn), 1);
        let left = reg.list();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].category, DeviceCategory::ArtNet);

        // 自定义名保留，设备再次出现时恢复
        reg.upsert_source(ip(90), Protocol::Sacn, 5);
        let back = reg.list().into_iter().find(|d| d.ip == "192.168.1.90").unwrap();
        assert_eq!(back.custom_name.as_deref(), Some("舞台右"));
    }

    #[test]
    fn custom_name_persists_and_clears() {
        let mut reg = DeviceRegistry::new();
        reg.upsert_source(ip(40), Protocol::Sacn, 0);
        reg.set_custom_name(ip(40), "舞台左".into());
        assert_eq!(reg.list()[0].custom_name.as_deref(), Some("舞台左"));
        assert_eq!(reg.custom_names().get("192.168.1.40").unwrap(), "舞台左");
        reg.set_custom_name(ip(40), String::new());
        assert_eq!(reg.list()[0].custom_name, None);
    }

    #[test]
    fn stale_marked_offline() {
        let mut reg = DeviceRegistry::new();
        reg.upsert_source(ip(50), Protocol::Sacn, 0);
        reg.mark_stale_offline(10_000, 5000);
        assert!(!reg.list()[0].online);
    }

    #[test]
    fn clear_offline_removes_only_offline_and_keeps_names() {
        let mut reg = DeviceRegistry::new();
        reg.upsert_source(ip(70), Protocol::Sacn, 0);
        reg.upsert_source(ip(71), Protocol::Sacn, 9_000);
        reg.set_custom_name(ip(70), "旧设备".into());
        reg.mark_stale_offline(10_000, 5000);

        assert_eq!(reg.clear_offline(), 1);
        let left = reg.list();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].ip, "192.168.1.71");
        // 自定义名保留，设备再次出现时恢复
        reg.upsert_source(ip(70), Protocol::Sacn, 11_000);
        let back = reg.list().into_iter().find(|d| d.ip == "192.168.1.70").unwrap();
        assert_eq!(back.custom_name.as_deref(), Some("旧设备"));
    }

    #[test]
    fn artnet_counters_respect_since() {
        let mut reg = DeviceRegistry::new();
        let mk = |last: u8| PollReplyInfo {
            ip: [192, 168, 1, last],
            short_name: String::new(),
            long_name: String::new(),
            mac: [0; 6],
            num_ports: 1,
        };
        reg.upsert_artnet(&mk(80), 100);
        reg.upsert_artnet(&mk(81), 900);
        reg.upsert_source(ip(82), Protocol::Sacn, 900);

        assert_eq!(reg.count_artnet(), 2);
        assert_eq!(reg.count_artnet_seen_since(500), 1);
        assert_eq!(reg.count_artnet_seen_since(0), 2);
    }

    #[test]
    fn loaded_custom_name_applied_on_first_sight() {
        let mut reg = DeviceRegistry::new();
        let mut names = std::collections::HashMap::new();
        names.insert("192.168.1.60".to_string(), "预设名".to_string());
        reg.load_custom_names(names);
        reg.upsert_source(ip(60), Protocol::Sacn, 0);
        assert_eq!(reg.list()[0].custom_name.as_deref(), Some("预设名"));
    }
}
