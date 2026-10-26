//! Art-Net 数据包编解码。
//!
//! 热路径上的 ArtDmx 收发（[`parse`] 的 ArtDmx 分支、[`build_dmx_into`] /
//! [`build_dmx`]）为手写字节级实现，接受 / 拒绝规则与输出字节逐一对齐
//! [`artnet_protocol`] 0.4.4；其余 OpCode（ArtPoll、ArtPollReply 等）仍委托给
//! [`artnet_protocol`]。本模块只保留与工程其余部分对接的稳定 DTO
//! （[`ArtNetPacket`] / [`PollReplyInfo`]）与薄封装，以便调用方（`socket`、
//! `discovery` 等）无感知。

use artnet_protocol::{ArtCommand, Poll, PollReply, ARTNET_HEADER, ARTNET_PROTOCOL_VERSION};
use serde::Serialize;

use crate::frame::port_address;

/// Art-Net 默认 UDP 端口。
pub const ARTNET_PORT: u16 = 6454;

/// 单帧 ArtDmx 允许的最大通道数。
const MAX_DMX: usize = 512;

/// ArtDmx（`OpOutput`）的 OpCode（报文中按小端存放）。
const OP_DMX: u16 = 0x5000;

/// ArtDmx 固定头长度（18 字节）。
///
/// 依次为 `ID`(8)、`OpCode`(2)、`ProtVer`(2)、`Sequence`(1)、`Physical`(1)、
/// `Port-Address`(2，小端)、`Length`(2，大端)，其后紧跟通道数据。
const ARTDMX_HEADER_LEN: usize = 18;

/// 单个 ArtDmx 报文的最大字节数（18 字节固定头 + 512 通道），即
/// [`build_dmx_into`] 输出缓冲的长度。
pub const ARTDMX_MAX_LEN: usize = ARTDMX_HEADER_LEN + MAX_DMX;

/// 15 位 Port-Address 的上限（`0x7FFF`）。
const MAX_PORT_ADDRESS: u16 = 0x7FFF;

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
/// ArtDmx（OpCode `0x5000`）走手写快速路径，只做一次通道数据拷贝；其余 OpCode
/// 交给 [`artnet_protocol::ArtCommand::from_buffer`]。快速路径的接受 / 拒绝规则与
/// `artnet_protocol` 0.4.4 完全一致：
///
/// - 报文须以 `"Art-Net\0"` 开头，且总长不小于 18 字节（能读到 `Length` 字段）；
/// - `Port-Address`（偏移 14，小端）须 `<= 0x7FFF`，否则拒绝；
/// - `ProtVer` 与 `Length` 字段不做校验；`Length` 与实际剩余字节数不一致、
///   数据为奇数长度、为 0 字节或超过 512 字节时均照常接受；
/// - 通道数据取偏移 18 起的全部剩余字节。
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
    if opcode_of(buf) == Some(OP_DMX) {
        return parse_dmx(buf);
    }
    match ArtCommand::from_buffer(buf).ok()? {
        // 快速路径已拦截全部 0x5000 报文，此分支理论上不可达；保留旧映射，
        // 以防判定条件意外不一致时仍退化为与 `artnet_protocol` 相同的结果。
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

/// 读取 Art-Net 报文的 OpCode。
///
/// 仅在报文至少 10 字节且以 `"Art-Net\0"` 开头时返回；更严格的最小长度
/// （`artnet_protocol` 要求 14 字节）由各 OpCode 的解析自行把关。
fn opcode_of(buf: &[u8]) -> Option<u16> {
    let head: &[u8; 10] = buf.first_chunk()?;
    if head[..8] != ARTNET_HEADER[..] {
        return None;
    }
    Some(u16::from_le_bytes([head[8], head[9]]))
}

/// ArtDmx 快速解析（调用方已确认包头与 OpCode）。
///
/// 语义照抄 `artnet_protocol` 0.4.4 的 `Output::from`：依次读取 `ProtVer`(2)、
/// `Sequence`(1)、`Physical`(1)、`Port-Address`(2，小端，`> 0x7FFF` 报错)、
/// `Length`(2，大端，仅读取不校验)，剩余字节全部作为通道数据。任一字段读不全
/// （总长 < 18）即拒绝。
fn parse_dmx(buf: &[u8]) -> Option<ArtNetPacket> {
    let head: &[u8; ARTDMX_HEADER_LEN] = buf.first_chunk()?;
    let port_address = u16::from_le_bytes([head[14], head[15]]);
    if port_address > MAX_PORT_ADDRESS {
        return None;
    }
    Some(ArtNetPacket::Dmx {
        port_address,
        sequence: head[12],
        data: buf[ARTDMX_HEADER_LEN..].to_vec(),
    })
}

/// 把 ArtDmx（Output）数据包写入调用方提供的定长缓冲（零堆分配）。
///
/// 输出与旧版委托 `artnet_protocol` 0.4.4 的写法逐字节一致：`ProtVer` 为
/// [`artnet_protocol::ARTNET_PROTOCOL_VERSION`]、`Physical` 为 0、`Port-Address`
/// 小端、`Length` 大端且为补齐后的偶数长度。
///
/// # Arguments
///
/// * `port_address` - 15 位 Port-Address（`0..=0x7FFF`）。
/// * `sequence` - 序列号（0 表示不启用序列）。
/// * `data` - 通道数据；超过 512 字节时截断为前 512 字节，奇数长度末尾补一个 0。
/// * `out` - 输出缓冲；只写入前 `n` 字节（`n` 为返回值），其余字节保持原样，
///   因此可在多次调用间复用而无需清零。
///
/// # Returns
///
/// 写入 `out` 的报文字节数（`18 + 补齐后的数据长度`，最大 [`ARTDMX_MAX_LEN`]）。
/// `port_address` 超出 15 位范围，或 `data` 为空（ArtDmx 至少需 1 个通道，
/// 与 `artnet_protocol` 拒绝 0 长度数据的语义一致）时返回 0，`out` 不被修改。
#[must_use]
pub fn build_dmx_into(
    port_address: u16,
    sequence: u8,
    data: &[u8],
    out: &mut [u8; ARTDMX_MAX_LEN],
) -> usize {
    if port_address > MAX_PORT_ADDRESS || data.is_empty() {
        return 0;
    }
    let n = data.len().min(MAX_DMX);
    // ArtDmx 要求偶数长度：不足偶数末尾补 0。
    let padded_len = n + (n & 1);

    out[..8].copy_from_slice(ARTNET_HEADER);
    out[8..10].copy_from_slice(&OP_DMX.to_le_bytes());
    out[10..12].copy_from_slice(&ARTNET_PROTOCOL_VERSION);
    out[12] = sequence;
    out[13] = 0; // Physical
    out[14..16].copy_from_slice(&port_address.to_le_bytes());
    // padded_len <= 512，转 u16 不会截断
    out[16..18].copy_from_slice(&(padded_len as u16).to_be_bytes());
    let body = &mut out[ARTDMX_HEADER_LEN..ARTDMX_HEADER_LEN + padded_len];
    body[..n].copy_from_slice(&data[..n]);
    body[n..].fill(0);
    ARTDMX_HEADER_LEN + padded_len
}

/// 构造一个 ArtDmx（Output）数据包。
///
/// 等价于 [`build_dmx_into`] 后把有效部分拷贝为 `Vec`（一次堆分配）；热路径请直接
/// 使用 [`build_dmx_into`]。
///
/// # Arguments
///
/// * `port_address` - 15 位 Port-Address。
/// * `sequence` - 序列号（0 表示不启用序列）。
/// * `data` - 通道数据（长度将按偶数向上取整，最大 512）。
///
/// # Returns
///
/// 完整 ArtDmx 字节缓冲；`port_address` 超出 15 位范围或 `data` 为空时返回空缓冲。
#[must_use]
pub fn build_dmx(port_address: u16, sequence: u8, data: &[u8]) -> Vec<u8> {
    let mut out = [0u8; ARTDMX_MAX_LEN];
    let n = build_dmx_into(port_address, sequence, data, &mut out);
    out[..n].to_vec()
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

/// 旧实现（全部委托 `artnet_protocol` 0.4.4）的原样拷贝，仅作一致性测试的参照。
#[cfg(test)]
mod reference {
    use artnet_protocol::{ArtCommand, Output, PortAddress};

    use super::{poll_reply_info, ArtNetPacket, MAX_DMX};

    /// 旧版 `parse`：任何 OpCode 均交给 `ArtCommand::from_buffer`。
    pub(super) fn parse(buf: &[u8]) -> Option<ArtNetPacket> {
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

    /// 旧版 `build_dmx`：经 `ArtCommand::Output(..).write_to_buffer()` 组包。
    pub(super) fn build_dmx(port_address: u16, sequence: u8, data: &[u8]) -> Vec<u8> {
        let n = data.len().min(MAX_DMX);
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
}

/// 新实现与 [`reference`] 旧实现的逐字节 / 逐结果一致性测试。
#[cfg(test)]
mod equivalence {
    use super::{build_dmx, build_dmx_into, build_poll, parse, reference, ARTDMX_MAX_LEN};

    /// 覆盖边界的 Port-Address：最小值、普通值、15 位上限，以及越界值。
    const PORT_ADDRESSES: [u16; 6] = [0, 1, 0x1234, 0x7FFF, 0x8000, 0xFFFF];

    /// 覆盖“不启用序列”、普通值与上限的序列号。
    const SEQUENCES: [u8; 3] = [0, 1, 255];

    /// 一致性测试覆盖的最大数据长度：超过 512 以验证截断。
    const MAX_TEST_LEN: usize = 520;

    /// 生成长度为 `len` 的确定性通道数据（全非 0，便于发现补齐字节错误）。
    fn data_of(len: usize) -> Vec<u8> {
        (0..len).map(|i| ((i * 31 + len) % 255 + 1) as u8).collect()
    }

    /// 按给定字段手工拼一个 ArtDmx 报文（字段值可任意，用于构造非法 / 边界报文）。
    fn raw_dmx(
        version: [u8; 2],
        sequence: u8,
        port_address: u16,
        length: u16,
        data: &[u8],
    ) -> Vec<u8> {
        let mut buf = b"Art-Net\0".to_vec();
        buf.extend_from_slice(&0x5000u16.to_le_bytes());
        buf.extend_from_slice(&version);
        buf.push(sequence);
        buf.push(7); // Physical
        buf.extend_from_slice(&port_address.to_le_bytes());
        buf.extend_from_slice(&length.to_be_bytes());
        buf.extend_from_slice(data);
        buf
    }

    /// 断言新旧 `parse` 对同一输入给出完全相同的结果。
    fn assert_parse_same(buf: &[u8]) {
        assert_eq!(parse(buf), reference::parse(buf), "输入 {buf:02X?}");
    }

    #[test]
    fn build_dmx_matches_reference_byte_for_byte() {
        for len in 0..=MAX_TEST_LEN {
            let data = data_of(len);
            for pa in PORT_ADDRESSES {
                for seq in SEQUENCES {
                    let expected = reference::build_dmx(pa, seq, &data);
                    assert_eq!(
                        build_dmx(pa, seq, &data),
                        expected,
                        "len={len} pa={pa:#06X} seq={seq}"
                    );

                    // 预填垃圾字节，验证 build_dmx_into 不依赖调用方清零
                    let mut out = [0xA5u8; ARTDMX_MAX_LEN];
                    let n = build_dmx_into(pa, seq, &data, &mut out);
                    assert_eq!(
                        &out[..n],
                        &expected[..],
                        "into: len={len} pa={pa:#06X} seq={seq}"
                    );
                }
            }
        }
    }

    #[test]
    fn build_dmx_into_rejects_like_reference() {
        let mut out = [0x5Au8; ARTDMX_MAX_LEN];
        assert_eq!(build_dmx_into(0x8000, 0, &[1, 2], &mut out), 0);
        assert_eq!(build_dmx_into(1, 0, &[], &mut out), 0);
        assert!(out.iter().all(|&b| b == 0x5A), "拒绝时不得改动输出缓冲");
        assert!(reference::build_dmx(0x8000, 0, &[1, 2]).is_empty());
        assert!(reference::build_dmx(1, 0, &[]).is_empty());
    }

    #[test]
    fn parse_matches_reference_for_built_packets() {
        for len in 0..=MAX_TEST_LEN {
            let data = data_of(len);
            for pa in [0, 0x7FFF] {
                assert_parse_same(&reference::build_dmx(pa, 9, &data));
            }
        }
    }

    #[test]
    fn parse_matches_reference_for_irregular_artdmx() {
        for len in 0..=MAX_TEST_LEN + 80 {
            let data = data_of(len);
            // Length 字段与实际长度一致、差 1、为 0、为最大值；数据长度含奇数与超 512
            let exact = u16::try_from(len).unwrap_or(u16::MAX);
            for length in [exact, exact.wrapping_add(1), 0, u16::MAX] {
                assert_parse_same(&raw_dmx([0, 14], 3, 0x0102, length, &data));
            }
        }
        // 协议版本不做校验
        for version in [[0, 0], [0, 13], [0, 14], [0xFF, 0xFF]] {
            assert_parse_same(&raw_dmx(version, 1, 5, 2, &[1, 2]));
        }
        // Port-Address 边界：0x7FFF 接受，0x8000 及以上拒绝
        for pa in PORT_ADDRESSES {
            assert_parse_same(&raw_dmx([0, 14], 1, pa, 2, &[1, 2]));
        }
    }

    #[test]
    fn parse_matches_reference_for_truncated_and_corrupt_input() {
        let full = raw_dmx([0, 14], 4, 0x0203, 4, &[9, 8, 7, 6]);
        // 每一个前缀长度（含 < 10、10..14、14..18 等各类截断）
        for cut in 0..=full.len() {
            assert_parse_same(&full[..cut]);
        }
        // 逐字节破坏包头 / OpCode
        for i in 0..10 {
            let mut bad = full.clone();
            bad[i] ^= 0x20;
            assert_parse_same(&bad);
        }
        // OpCode 字节序颠倒（0x0050）与其它 OpCode 不得被识别为 ArtDmx
        for op in [0x0050u16, 0x5100, 0x5200, 0x2000, 0x2100, 0x1234] {
            let mut other = full.clone();
            other[8..10].copy_from_slice(&op.to_le_bytes());
            assert_parse_same(&other);
        }
        assert_parse_same(&build_poll());
        assert_parse_same(&[]);
    }
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
