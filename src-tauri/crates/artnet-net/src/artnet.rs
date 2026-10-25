//! Art-Net 数据包编解码。
//!
//! 内部委托给成熟的 [`artnet_protocol`] crate 做字节级编解码，本模块只保留与
//! 工程其余部分对接的稳定 DTO（[`ArtNetPacket`] / [`PollReplyInfo`]）与薄封装，
//! 以便调用方（`socket`、`discovery` 等）无感知。

use artnet_protocol::{ArtCommand, Output, Poll, PollReply, PortAddress};
use serde::Serialize;

use crate::frame::port_address;

/// Art-Net 默认 UDP 端口。
pub const ARTNET_PORT: u16 = 6454;

/// 单帧 ArtDmx 允许的最大通道数。
const MAX_DMX: usize = 512;

/// 解析出的 Art-Net 包类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtNetPacket {
    /// ArtDmx 输出帧。
    Dmx {
        /// 15 位 Port-Address。
        port_address: u16,
        /// 序列号。
        sequence: u8,
        /// 通道数据。
        data: Vec<u8>,
    },
    /// ArtPoll。
    Poll,
    /// ArtPollReply（节点发现回复）。
    PollReply(PollReplyInfo),
    /// 其它已识别但未处理的包类型。
    Other,
}

/// 节点端口方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PortDirection {
    /// 输入口：把外部 DMX 送上 Art-Net 网络。
    Input,
    /// 输出口：把 Art-Net 数据输出为 DMX。
    Output,
}

/// ArtPollReply 中一个端口的信息（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePort {
    /// 端口序号（从 0 起，对应节点的第 1~4 口）。
    pub index: u8,
    /// 端口方向。
    pub direction: PortDirection,
    /// 该端口的 15 位 Port-Address。
    pub universe: u16,
    /// 是否有数据流（输入口为正在接收，输出口为正在发送）。
    pub active: bool,
}

/// ArtPollReply 中用于设备发现的关键字段。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PollReplyInfo {
    /// 节点 IPv4（4 字节）。
    pub ip: [u8; 4],
    /// 短名（≤17 字符）。
    pub short_name: String,
    /// 长名（≤63 字符）。
    pub long_name: String,
    /// MAC 地址（6 字节，可能为全 0）。
    pub mac: [u8; 6],
    /// 输入/输出端口数。
    pub num_ports: u16,
    /// 固件版本（高字节、低字节）。
    pub version: [u8; 2],
    /// OEM 厂商与功能码。
    pub oem: u16,
    /// ESTA 厂商码。
    pub esta_code: u16,
    /// 设备样式码（`Style`）。
    pub style: u8,
    /// 节点运行状态文本（`NodeReport`）。
    pub node_report: String,
    /// 多 bind 设备的 bind 序号（`1` 为根设备；`0` 视同 `1`）。
    pub bind_index: u8,
    /// 本条回复上报的端口（每个输入或输出方向各一项）。
    pub ports: Vec<NodePort>,
}

/// 解析 Art-Net 数据包。
///
/// # Arguments
///
/// * `buf` - UDP 载荷。
///
/// # Returns
///
/// 识别出的 [`ArtNetPacket`]；非 Art-Net 或无法解析返回 `None`。
#[must_use]
pub fn parse(buf: &[u8]) -> Option<ArtNetPacket> {
    match ArtCommand::from_buffer(buf).ok()? {
        ArtCommand::Output(o) => Some(ArtNetPacket::Dmx {
            port_address: u16::from(o.port_address),
            sequence: o.sequence,
            data: o.data.as_ref().clone(),
        }),
        ArtCommand::Poll(_) => Some(ArtNetPacket::Poll),
        ArtCommand::PollReply(reply) => Some(ArtNetPacket::PollReply(poll_reply_info(&reply))),
        _ => Some(ArtNetPacket::Other),
    }
}

/// 构造一个 ArtDmx（Output）数据包。
///
/// # Arguments
///
/// * `port_address` - 15 位 Port-Address。
/// * `sequence` - 序列号（0 表示不启用序列）。
/// * `data` - 通道数据（长度将按偶数向上取整，最大 512）。
///
/// # Returns
///
/// 完整 ArtDmx 字节缓冲；`port_address` 超出 15 位范围时返回空缓冲。
#[must_use]
pub fn build_dmx(port_address: u16, sequence: u8, data: &[u8]) -> Vec<u8> {
    let n = data.len().min(MAX_DMX);
    // ArtDmx 要求偶数长度：不足偶数末尾补 0。
    let padded_len = n + (n & 1);
    let mut payload = vec![0u8; padded_len];
    payload[..n].copy_from_slice(&data[..n]);

    let Ok(pa) = PortAddress::try_from(port_address) else {
        return Vec::new();
    };
    let cmd = ArtCommand::Output(Output {
        port_address: pa,
        sequence,
        data: payload.into(),
        ..Output::default()
    });
    cmd.write_to_buffer().unwrap_or_default()
}

/// 构造一个 ArtPoll 数据包（用于主动发现节点）。
///
/// # Returns
///
/// 完整 ArtPoll 字节缓冲。
#[must_use]
pub fn build_poll() -> Vec<u8> {
    ArtCommand::Poll(Poll::default())
        .write_to_buffer()
        .unwrap_or_default()
}

/// 解析 ArtPollReply 的关键发现字段。
///
/// # Arguments
///
/// * `buf` - 完整 ArtPollReply 报文。
///
/// # Returns
///
/// 解析出的 [`PollReplyInfo`]；非 ArtPollReply 或无法解析返回 `None`。
#[must_use]
pub fn parse_poll_reply(buf: &[u8]) -> Option<PollReplyInfo> {
    match ArtCommand::from_buffer(buf).ok()? {
        ArtCommand::PollReply(reply) => Some(poll_reply_info(&reply)),
        _ => None,
    }
}

/// 把 [`artnet_protocol::PollReply`] 投影成本工程的发现 DTO。
fn poll_reply_info(reply: &PollReply) -> PollReplyInfo {
    PollReplyInfo {
        ip: reply.address.octets(),
        short_name: cstr(&reply.short_name),
        long_name: cstr(&reply.long_name),
        mac: reply.mac,
        num_ports: u16::from_be_bytes(reply.num_ports),
        version: reply.version,
        oem: u16::from_be_bytes(reply.oem),
        esta_code: reply.esta_code,
        style: reply.style,
        node_report: cstr(&reply.node_report),
        bind_index: reply.bind_index,
        ports: poll_reply_ports(reply),
    }
}

/// 依据 `PortTypes` / `SwIn` / `SwOut` / `GoodInput` / `GoodOutput` 展开端口列表。
///
/// `PortTypes` 的 bit7 表示可输出（Art-Net → DMX），bit6 表示可输入（DMX → Art-Net）；
/// `Good*` 的 bit7 表示当前有数据流。规范说明 `NumPorts` 可被忽略，故直接遍历 4 个槽位。
fn poll_reply_ports(reply: &PollReply) -> Vec<NodePort> {
    let net = reply.port_address[0] & 0x7F;
    let sub = reply.port_address[1] & 0x0F;
    let mut ports = Vec::new();
    for i in 0..4usize {
        let kind = reply.port_types[i];
        let index = i as u8;
        if kind & 0x40 != 0 {
            ports.push(NodePort {
                index,
                direction: PortDirection::Input,
                universe: port_address(net, (sub << 4) | (reply.swin[i] & 0x0F)),
                active: reply.good_input[i] & 0x80 != 0,
            });
        }
        if kind & 0x80 != 0 {
            ports.push(NodePort {
                index,
                direction: PortDirection::Output,
                universe: port_address(net, (sub << 4) | (reply.swout[i] & 0x0F)),
                active: reply.good_output[i] & 0x80 != 0,
            });
        }
    }
    ports
}

/// 读取定长字段中的以 NUL 结尾字符串。
fn cstr(raw: &[u8]) -> String {
    let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{build_dmx, build_poll, parse, parse_poll_reply, ArtNetPacket, PortDirection};
    use crate::frame::{net_of, port_address, sub_uni_of};

    #[test]
    fn artdmx_roundtrip() {
        let pa = port_address(2, 0x13); // net=2, subnet=1, uni=3
        let data: Vec<u8> = (0..512u16).map(|i| (i % 256) as u8).collect();
        let buf = build_dmx(pa, 7, &data);
        match parse(&buf).unwrap() {
            ArtNetPacket::Dmx {
                port_address,
                sequence,
                data: out,
            } => {
                assert_eq!(port_address, pa);
                assert_eq!(sequence, 7);
                assert_eq!(out, data);
            }
            other => panic!("期望 Dmx，实际 {other:?}"),
        }
    }

    #[test]
    fn odd_length_padded_even() {
        let buf = build_dmx(0, 0, &[1, 2, 3]);
        if let ArtNetPacket::Dmx { data, .. } = parse(&buf).unwrap() {
            assert_eq!(data.len(), 4); // 3 → 4
            assert_eq!(&data[..3], &[1, 2, 3]);
        } else {
            panic!("期望 Dmx");
        }
    }

    #[test]
    fn port_address_decomposition() {
        let pa = port_address(127, 0xFF);
        assert_eq!(net_of(pa), 127);
        assert_eq!(sub_uni_of(pa), 0xFF);
        assert_eq!(pa, 0x7FFF);
    }

    #[test]
    fn poll_detected() {
        assert_eq!(parse(&build_poll()).unwrap(), ArtNetPacket::Poll);
    }

    /// 以符合 Art-Net 规范的 ArtPollReply 原始报文（239 字节）驱动解析，
    /// 验证本模块对 [`artnet_protocol`] 结果的字段投影正确。
    #[test]
    fn poll_reply_parsed() {
        let mut buf = vec![0u8; 239];
        buf[0..8].copy_from_slice(b"Art-Net\0");
        // OpCode ArtPollReply = 0x2100（小端）
        buf[8..10].copy_from_slice(&0x2100u16.to_le_bytes());
        buf[10..14].copy_from_slice(&[192, 168, 1, 50]); // IP
        buf[14..16].copy_from_slice(&6454u16.to_le_bytes()); // Port 0x1936（小端）
        buf[26..30].copy_from_slice(b"Node"); // ShortName
        buf[44..51].copy_from_slice(b"LongNod"); // LongName
        buf[172..174].copy_from_slice(&4u16.to_be_bytes()); // NumPorts（大端）
        buf[201..207].copy_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]); // MAC

        let info = parse_poll_reply(&buf).unwrap();
        assert_eq!(info.ip, [192, 168, 1, 50]);
        assert_eq!(info.short_name, "Node");
        assert_eq!(info.long_name, "LongNod");
        assert_eq!(info.mac, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        assert_eq!(info.num_ports, 4);
    }

    /// 构造一份最小的 ArtPollReply 报文（239 字节），供扩展字段测试复用。
    fn raw_poll_reply() -> Vec<u8> {
        let mut buf = vec![0u8; 239];
        buf[0..8].copy_from_slice(b"Art-Net\0");
        buf[8..10].copy_from_slice(&0x2100u16.to_le_bytes());
        buf[10..14].copy_from_slice(&[10, 0, 0, 9]);
        buf[14..16].copy_from_slice(&6454u16.to_le_bytes());
        buf
    }

    #[test]
    fn poll_reply_extended_fields() {
        let mut buf = raw_poll_reply();
        buf[16..18].copy_from_slice(&[1, 23]); // VersInfo 高/低
        buf[20..22].copy_from_slice(&[0x12, 0x34]); // Oem 高/低
        buf[24..26].copy_from_slice(&0x4C58u16.to_le_bytes()); // EstaMan 小端
        buf[108..120].copy_from_slice(b"#0001 [0001]"); // NodeReport
        buf[200] = 1; // Style: Controller
        buf[211] = 2; // BindIndex

        let info = parse_poll_reply(&buf).unwrap();
        assert_eq!(info.version, [1, 23]);
        assert_eq!(info.oem, 0x1234);
        assert_eq!(info.esta_code, 0x4C58);
        assert_eq!(info.node_report, "#0001 [0001]");
        assert_eq!(info.style, 1);
        assert_eq!(info.bind_index, 2);
    }

    #[test]
    fn poll_reply_ports_expand_direction_and_universe() {
        let mut buf = raw_poll_reply();
        buf[18] = 0x02; // NetSwitch = 2
        buf[19] = 0x01; // SubSwitch = 1
        // 口 1：仅输出；口 2：输入+输出；口 3、4 未使用
        buf[174..178].copy_from_slice(&[0x80, 0xC0, 0x00, 0x00]);
        buf[178..182].copy_from_slice(&[0x00, 0x80, 0x00, 0x00]); // GoodInput：口 2 有数据
        buf[182..186].copy_from_slice(&[0x80, 0x00, 0x00, 0x00]); // GoodOutput：口 1 有数据
        buf[186..190].copy_from_slice(&[0x00, 0x05, 0x00, 0x00]); // SwIn
        buf[190..194].copy_from_slice(&[0x03, 0x04, 0x00, 0x00]); // SwOut

        let ports = parse_poll_reply(&buf).unwrap().ports;
        assert_eq!(ports.len(), 3);

        // 口 1 输出：2:1:3 = (2<<8)|(1<<4)|3
        assert_eq!(ports[0].index, 0);
        assert_eq!(ports[0].direction, PortDirection::Output);
        assert_eq!(ports[0].universe, (2 << 8) | (1 << 4) | 3);
        assert!(ports[0].active);

        // 口 2 输入：2:1:5，有数据
        assert_eq!(ports[1].index, 1);
        assert_eq!(ports[1].direction, PortDirection::Input);
        assert_eq!(ports[1].universe, (2 << 8) | (1 << 4) | 5);
        assert!(ports[1].active);

        // 口 2 输出：2:1:4，无数据
        assert_eq!(ports[2].direction, PortDirection::Output);
        assert_eq!(ports[2].universe, (2 << 8) | (1 << 4) | 4);
        assert!(!ports[2].active);
    }

    #[test]
    fn poll_reply_without_ports_yields_empty_list() {
        let info = parse_poll_reply(&raw_poll_reply()).unwrap();
        assert!(info.ports.is_empty());
        assert!(info.node_report.is_empty());
    }
}
