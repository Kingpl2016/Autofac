//! Art-Net 数据包编解码（ArtDmx / ArtPoll / ArtPollReply 识别）。

use byteorder::{BigEndian, ByteOrder, LittleEndian};

use crate::frame::{net_of, sub_uni_of};

/// Art-Net 包标识 `"Art-Net\0"`。
pub const ARTNET_ID: &[u8; 8] = b"Art-Net\0";
/// Art-Net 默认 UDP 端口。
pub const ARTNET_PORT: u16 = 6454;
/// 协议版本（14）。
pub const PROT_VER: u16 = 14;

/// OpCode：ArtPoll。
pub const OP_POLL: u16 = 0x2000;
/// OpCode：ArtPollReply。
pub const OP_POLL_REPLY: u16 = 0x2100;
/// OpCode：ArtDmx（Output）。
pub const OP_OUTPUT: u16 = 0x5000;

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
    /// 其它已识别但未处理的 OpCode。
    Other(u16),
}

/// ArtPollReply 中用于设备发现的关键字段。
#[derive(Debug, Clone, PartialEq, Eq)]
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
}

/// 判定缓冲是否以合法 Art-Net 包标识开头。
#[must_use]
pub fn is_artnet(buf: &[u8]) -> bool {
    buf.len() >= 10 && &buf[0..8] == ARTNET_ID
}

/// 解析 Art-Net 数据包。
///
/// # Arguments
///
/// * `buf` - UDP 载荷。
///
/// # Returns
///
/// 识别出的 [`ArtNetPacket`]；非 Art-Net 或过短返回 `None`。
#[must_use]
pub fn parse(buf: &[u8]) -> Option<ArtNetPacket> {
    if !is_artnet(buf) {
        return None;
    }
    // OpCode 为小端
    let opcode = LittleEndian::read_u16(&buf[8..10]);
    match opcode {
        OP_OUTPUT => {
            if buf.len() < 18 {
                return None;
            }
            let sequence = buf[12];
            let sub_uni = buf[14];
            let net = buf[15];
            let length = BigEndian::read_u16(&buf[16..18]) as usize;
            if buf.len() < 18 + length {
                return None;
            }
            let port_address = crate::frame::port_address(net, sub_uni);
            Some(ArtNetPacket::Dmx {
                port_address,
                sequence,
                data: buf[18..18 + length].to_vec(),
            })
        }
        OP_POLL => Some(ArtNetPacket::Poll),
        OP_POLL_REPLY => parse_poll_reply(buf).map(ArtNetPacket::PollReply),
        other => Some(ArtNetPacket::Other(other)),
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
/// 完整 ArtDmx 字节缓冲。
#[must_use]
pub fn build_dmx(port_address: u16, sequence: u8, data: &[u8]) -> Vec<u8> {
    let mut len = data.len().min(512);
    if len % 2 == 1 {
        len += 1; // ArtDmx 要求偶数长度
    }
    let mut buf = Vec::with_capacity(18 + len);
    buf.extend_from_slice(ARTNET_ID);
    // OpCode 小端，其余多字节字段大端（Art-Net 规范内混合字节序）。
    buf.extend_from_slice(&OP_OUTPUT.to_le_bytes());
    buf.extend_from_slice(&PROT_VER.to_be_bytes());
    buf.push(sequence);
    buf.push(0); // physical
    buf.push(sub_uni_of(port_address));
    buf.push(net_of(port_address));
    buf.extend_from_slice(&(len as u16).to_be_bytes());
    buf.extend_from_slice(&data[..data.len().min(len)]);
    buf.resize(18 + len, 0); // 不足偶数长度补 0
    buf
}

/// 构造一个 ArtPoll 数据包（用于主动发现节点）。
///
/// # Returns
///
/// 完整 ArtPoll 字节缓冲。
#[must_use]
pub fn build_poll() -> Vec<u8> {
    let mut buf = Vec::with_capacity(14);
    buf.extend_from_slice(ARTNET_ID);
    buf.extend_from_slice(&OP_POLL.to_le_bytes());
    buf.extend_from_slice(&PROT_VER.to_be_bytes());
    buf.push(0); // TalkToMe
    buf.push(0); // Priority
    buf
}

/// 解析 ArtPollReply 的关键发现字段。
///
/// # Arguments
///
/// * `buf` - ArtPollReply 载荷。
///
/// # Returns
///
/// 解析出的 [`PollReplyInfo`]；过短返回 `None`。
#[must_use]
pub fn parse_poll_reply(buf: &[u8]) -> Option<PollReplyInfo> {
    if buf.len() < 108 {
        return None;
    }
    let mut ip = [0u8; 4];
    ip.copy_from_slice(&buf[10..14]);
    let short_name = cstr(&buf[26..44]);
    let long_name = cstr(&buf[44..108]);
    let num_ports = if buf.len() >= 174 {
        BigEndian::read_u16(&buf[172..174])
    } else {
        0
    };
    let mut mac = [0u8; 6];
    if buf.len() >= 207 {
        mac.copy_from_slice(&buf[201..207]);
    }
    Some(PollReplyInfo {
        ip,
        short_name,
        long_name,
        mac,
        num_ports,
    })
}

/// 读取定长字段中的以 NUL 结尾字符串。
fn cstr(raw: &[u8]) -> String {
    let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{build_dmx, build_poll, parse, parse_poll_reply, ArtNetPacket, ARTNET_ID};
    use crate::frame::{net_of, port_address, sub_uni_of};
    use byteorder::{ByteOrder, LittleEndian};

    #[test]
    fn poll_reply_parsed() {
        let mut buf = vec![0u8; 207];
        buf[0..8].copy_from_slice(ARTNET_ID);
        LittleEndian::write_u16(&mut buf[8..10], super::OP_POLL_REPLY);
        buf[10..14].copy_from_slice(&[192, 168, 1, 50]);
        buf[26..26 + 4].copy_from_slice(b"Node");
        buf[44..44 + 7].copy_from_slice(b"LongNod");
        buf[201..207].copy_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        let info = parse_poll_reply(&buf).unwrap();
        assert_eq!(info.ip, [192, 168, 1, 50]);
        assert_eq!(info.short_name, "Node");
        assert_eq!(info.long_name, "LongNod");
        assert_eq!(info.mac, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }

    #[test]
    fn artdmx_roundtrip() {
        let pa = port_address(2, 0x13); // net=2, subnet=1, uni=3
        let data: Vec<u8> = (0..512).map(|i| (i % 256) as u8).collect();
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
    }

    #[test]
    fn poll_detected() {
        assert_eq!(parse(&build_poll()).unwrap(), ArtNetPacket::Poll);
    }

    #[test]
    fn non_artnet_rejected() {
        assert!(parse(b"not-artnet-xxxxxxxx").is_none());
    }
}
