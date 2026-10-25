//! 网络设备发现：合并 Art-Net 节点回复与被动观测到的源，按类别归类，
//! 维护在线状态与用户自定义名。
//!
//! 反向 DNS 与 ARP MAC 为平台相关的尽力而为增强，由宿主层注入；本 crate
//! 只维护设备注册表的合并与分类逻辑（纯逻辑，便于测试）。

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;

use serde::Serialize;

use artnet_net::artnet::{NodePort, PollReplyInfo};
use artnet_net::Protocol;

/// 每个 bind 在端口序号上占用的槽位数（Art-Net 规范：每个 bind 最多 4 个端口）。
const PORTS_PER_BIND: u8 = 4;

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
    /// Art-Net 端口/Universe 数量（多 bind 设备为各 bind 之和）。
    pub artnet_ports: Option<u16>,
    /// 是否在线（最近有活动）。
    pub online: bool,
    /// 最后活动逻辑时间（毫秒）。
    pub last_seen_ms: u64,
    /// Art-Net 短名（`ShortName`）。
    pub short_name: Option<String>,
    /// 节点运行状态文本（`NodeReport`）。
    pub node_report: Option<String>,
    /// 固件版本，形如 `"1.23"`；节点未上报时为 `None`。
    pub firmware: Option<String>,
    /// 厂商标识：ESTA 码可读为两个 ASCII 字母时显示字母，否则为十六进制。
    pub manufacturer: Option<String>,
    /// OEM 码；节点未上报时为 `None`。
    pub oem: Option<u16>,
    /// 设备样式：`node` / `controller` / `media` / `route` / `backup` / `config` / `visual`。
    pub style: Option<String>,
    /// 端口列表（多 bind 设备已合并，`index` 为跨 bind 的唯一序号）。
    pub ports: Vec<NodePort>,
}

/// 单个 bind 的端口状态（同一 IP 的多 bind 设备会分别回复）。
#[derive(Debug, Clone, Default)]
struct BindState {
    /// 该 bind 上报的端口数。
    num_ports: u16,
    /// 该 bind 上报的端口（`index` 为 bind 内序号 0~3）。
    ports: Vec<NodePort>,
}

/// 设备注册表：合并多来源的发现信息。
#[derive(Debug, Default)]
pub struct DeviceRegistry {
    devices: HashMap<IpAddr, Device>,
    custom_names: HashMap<IpAddr, String>,
    /// 多 bind 设备各 bind 的端口状态：IP → bind 序号 → 端口状态。
    binds: HashMap<IpAddr, BTreeMap<u8, BindState>>,
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
            short_name: None,
            node_report: None,
            firmware: None,
            manufacturer: None,
            oem: None,
            style: None,
            ports: Vec::new(),
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
        let long = non_empty(&info.long_name);

        // 多 bind 设备（如 8 口节点拆成两个 bind）会从同一 IP 分别回复，
        // 端口需按 bind 序号累积合并，不能互相覆盖。
        let binds = self.binds.entry(ip).or_default();
        binds.insert(
            info.bind_index.max(1),
            BindState {
                num_ports: info.num_ports,
                ports: info.ports.clone(),
            },
        );
        let total_ports = binds
            .values()
            .fold(0u16, |acc, b| acc.saturating_add(b.num_ports));
        let merged_ports: Vec<NodePort> = binds
            .iter()
            .flat_map(|(bind, state)| {
                state.ports.iter().map(move |p| NodePort {
                    index: (bind - 1).saturating_mul(PORTS_PER_BIND).saturating_add(p.index),
                    ..*p
                })
            })
            .collect();

        let dev = self.entry(ip, now_ms);
        dev.category = DeviceCategory::ArtNet;
        dev.online = true;
        dev.last_seen_ms = now_ms;
        dev.artnet_ports = Some(total_ports);
        dev.ports = merged_ports;
        if dev.hostname.is_none() {
            dev.hostname = long;
        }
        if mac.is_some() {
            dev.mac = mac;
        }
        // 名称 / 状态类字段只在新回复非空时更新，避免被其它 bind 的空字段抹掉。
        if let Some(v) = non_empty(&info.short_name) {
            dev.short_name = Some(v);
        }
        if let Some(v) = non_empty(&info.node_report) {
            dev.node_report = Some(v);
        }
        if let Some(v) = firmware_string(info.version) {
            dev.firmware = Some(v);
        }
        if let Some(v) = manufacturer_string(info.esta_code) {
            dev.manufacturer = Some(v);
        }
        if info.oem != 0 {
            dev.oem = Some(info.oem);
        }
        if let Some(v) = style_name(info.style) {
            dev.style = Some(v.to_string());
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

    /// 移除全部设备（用户自定义名仍保留，设备再次出现时会恢复）。
    ///
    /// 进入播放器模式、停止一切接收时调用：此后不会再有新的发现信息，
    /// 留着旧设备只会让界面显示过期的在线状态。
    ///
    /// # Returns
    ///
    /// 被移除的设备数量。
    pub fn clear(&mut self) -> usize {
        let n = self.devices.len();
        self.devices.clear();
        self.binds.clear();
        n
    }

    /// 移除全部离线设备（用户自定义名仍保留，设备再次出现时会恢复）。
    ///
    /// # Returns
    ///
    /// 被移除的设备数量。
    pub fn clear_offline(&mut self) -> usize {
        let before = self.devices.len();
        self.devices.retain(|_, d| d.online);
        self.prune_binds();
        before - self.devices.len()
    }

    /// 丢弃已不在注册表中的设备的 bind 缓存，避免设备再次出现时混入旧端口。
    fn prune_binds(&mut self) {
        let devices = &self.devices;
        self.binds.retain(|ip, _| devices.contains_key(ip));
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
        self.prune_binds();
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

/// 非空字符串转 `Some`，空串转 `None`。
fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// 把固件版本字节（高、低）格式化为 `"高.低"`；两字节均为 0 返回 `None`。
///
/// # Arguments
///
/// * `version` - ArtPollReply 的 `VersInfo`（高字节、低字节）。
///
/// # Returns
///
/// 形如 `"1.23"` 的版本字符串；节点未上报时为 `None`。
#[must_use]
pub fn firmware_string(version: [u8; 2]) -> Option<String> {
    if version == [0, 0] {
        return None;
    }
    Some(format!("{}.{}", version[0], version[1]))
}

/// 把 ESTA 厂商码转成可读标识。
///
/// # Arguments
///
/// * `code` - ArtPollReply 的 `EstaMan`。
///
/// # Returns
///
/// 两个字节都是 ASCII 字母数字时返回这两个字符（高字节在前），否则返回
/// `0xXXXX` 形式的十六进制；`0` 返回 `None`。
#[must_use]
pub fn manufacturer_string(code: u16) -> Option<String> {
    if code == 0 {
        return None;
    }
    let [hi, lo] = code.to_be_bytes();
    if hi.is_ascii_alphanumeric() && lo.is_ascii_alphanumeric() {
        Some(format!("{}{}", char::from(hi), char::from(lo)))
    } else {
        Some(format!("0x{code:04X}"))
    }
}

/// 把 Art-Net `Style` 码映射为稳定的小写标识。
///
/// # Arguments
///
/// * `style` - ArtPollReply 的 `Style` 字节。
///
/// # Returns
///
/// 规范定义的 0~6 返回对应标识，其余返回 `None`。
#[must_use]
pub fn style_name(style: u8) -> Option<&'static str> {
    match style {
        0 => Some("node"),
        1 => Some("controller"),
        2 => Some("media"),
        3 => Some("route"),
        4 => Some("backup"),
        5 => Some("config"),
        6 => Some("visual"),
        _ => None,
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

    use artnet_net::artnet::{NodePort, PollReplyInfo, PortDirection};
    use artnet_net::Protocol;

    use super::{
        firmware_string, manufacturer_string, style_name, DeviceCategory, DeviceRegistry,
    };

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
            ..PollReplyInfo::default()
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
            num_ports: 1,
            ..PollReplyInfo::default()
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
    fn clear_removes_every_device_but_keeps_custom_names() {
        let mut reg = DeviceRegistry::new();
        reg.upsert_source(ip(60), Protocol::Sacn, 0);
        reg.upsert_source(ip(61), Protocol::ArtNet, 0);
        reg.set_custom_name(ip(60), "舞台右".into());
        assert_eq!(reg.clear(), 2);
        assert!(reg.list().is_empty());
        assert_eq!(reg.clear(), 0);
        // 自定义名保留：设备重新出现时恢复
        reg.upsert_source(ip(60), Protocol::Sacn, 9);
        assert_eq!(reg.list()[0].custom_name.as_deref(), Some("舞台右"));
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
            num_ports: 1,
            ..PollReplyInfo::default()
        };
        reg.upsert_artnet(&mk(80), 100);
        reg.upsert_artnet(&mk(81), 900);
        reg.upsert_source(ip(82), Protocol::Sacn, 900);

        assert_eq!(reg.count_artnet(), 2);
        assert_eq!(reg.count_artnet_seen_since(500), 1);
        assert_eq!(reg.count_artnet_seen_since(0), 2);
    }

    fn port(index: u8, direction: PortDirection, universe: u16) -> NodePort {
        NodePort {
            index,
            direction,
            universe,
            active: false,
        }
    }

    #[test]
    fn multi_bind_ports_are_merged_not_overwritten() {
        let mut reg = DeviceRegistry::new();
        let bind = |bind_index: u8, uni: u16| PollReplyInfo {
            ip: [192, 168, 1, 100],
            num_ports: 4,
            bind_index,
            ports: vec![
                port(0, PortDirection::Output, uni),
                port(1, PortDirection::Output, uni + 1),
            ],
            ..PollReplyInfo::default()
        };
        reg.upsert_artnet(&bind(1, 0), 10);
        reg.upsert_artnet(&bind(2, 4), 20);
        // 同一 bind 重复回复不应重复计数
        reg.upsert_artnet(&bind(2, 4), 30);

        let d = &reg.list()[0];
        assert_eq!(d.artnet_ports, Some(8));
        let idx: Vec<u8> = d.ports.iter().map(|p| p.index).collect();
        assert_eq!(idx, vec![0, 1, 4, 5]);
        let uni: Vec<u16> = d.ports.iter().map(|p| p.universe).collect();
        assert_eq!(uni, vec![0, 1, 4, 5]);
    }

    #[test]
    fn bind_index_zero_is_treated_as_root() {
        let mut reg = DeviceRegistry::new();
        let info = PollReplyInfo {
            ip: [192, 168, 1, 101],
            num_ports: 2,
            bind_index: 0,
            ports: vec![port(1, PortDirection::Input, 7)],
            ..PollReplyInfo::default()
        };
        reg.upsert_artnet(&info, 0);
        let d = &reg.list()[0];
        assert_eq!(d.ports[0].index, 1);
        assert_eq!(d.artnet_ports, Some(2));
    }

    #[test]
    fn clear_offline_resets_bind_cache() {
        let mut reg = DeviceRegistry::new();
        let info = PollReplyInfo {
            ip: [192, 168, 1, 102],
            num_ports: 4,
            bind_index: 1,
            ports: vec![port(0, PortDirection::Output, 1)],
            ..PollReplyInfo::default()
        };
        reg.upsert_artnet(&info, 0);
        reg.mark_stale_offline(10_000, 5000);
        assert_eq!(reg.clear_offline(), 1);

        // 再次出现时只带自己的新端口，不残留旧 bind
        let again = PollReplyInfo {
            num_ports: 2,
            ports: vec![port(0, PortDirection::Output, 9)],
            ..info
        };
        reg.upsert_artnet(&again, 20_000);
        let d = &reg.list()[0];
        assert_eq!(d.artnet_ports, Some(2));
        assert_eq!(d.ports.len(), 1);
        assert_eq!(d.ports[0].universe, 9);
    }

    #[test]
    fn extra_fields_are_filled_and_not_wiped_by_empty_reply() {
        let mut reg = DeviceRegistry::new();
        let full = PollReplyInfo {
            ip: [192, 168, 1, 103],
            short_name: "Short".into(),
            node_report: "#0001 [0001] OK".into(),
            version: [2, 5],
            oem: 0x1234,
            esta_code: 0x4C58,
            style: 0,
            num_ports: 1,
            bind_index: 1,
            ..PollReplyInfo::default()
        };
        reg.upsert_artnet(&full, 0);
        // 其它 bind 的回复不带名称 / 状态
        let sparse = PollReplyInfo {
            ip: [192, 168, 1, 103],
            num_ports: 1,
            bind_index: 2,
            ..PollReplyInfo::default()
        };
        reg.upsert_artnet(&sparse, 1);

        let d = &reg.list()[0];
        assert_eq!(d.short_name.as_deref(), Some("Short"));
        assert_eq!(d.node_report.as_deref(), Some("#0001 [0001] OK"));
        assert_eq!(d.firmware.as_deref(), Some("2.5"));
        assert_eq!(d.manufacturer.as_deref(), Some("LX"));
        assert_eq!(d.oem, Some(0x1234));
        assert_eq!(d.style.as_deref(), Some("node"));
    }

    #[test]
    fn helper_formatters_cover_edge_cases() {
        assert_eq!(firmware_string([0, 0]), None);
        assert_eq!(firmware_string([1, 23]).as_deref(), Some("1.23"));
        assert_eq!(manufacturer_string(0), None);
        assert_eq!(manufacturer_string(0x0102).as_deref(), Some("0x0102"));
        assert_eq!(style_name(1), Some("controller"));
        assert_eq!(style_name(99), None);
    }

    #[test]
    fn device_serializes_new_fields_as_camel_case() {
        let mut reg = DeviceRegistry::new();
        reg.upsert_artnet(
            &PollReplyInfo {
                ip: [192, 168, 1, 104],
                short_name: "S".into(),
                num_ports: 1,
                ports: vec![port(0, PortDirection::Input, 3)],
                ..PollReplyInfo::default()
            },
            0,
        );
        let json = serde_json::to_value(&reg.list()[0]).unwrap();
        assert_eq!(json["shortName"], "S");
        assert_eq!(json["ports"][0]["direction"], "input");
        assert_eq!(json["ports"][0]["universe"], 3);
        assert!(json.get("nodeReport").is_some());
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
