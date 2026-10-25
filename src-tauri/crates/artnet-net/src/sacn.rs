//! sACN (ANSI E1.31) 数据包编解码（E1.31 Data Packet，DMP 层）。

use std::net::Ipv4Addr;

use byteorder::{BigEndian, ByteOrder};

/// sACN 默认 UDP 端口。
pub const SACN_PORT: u16 = 5568;
/// ACN 包标识符 `"ASC-E1.17\0\0\0"`。
pub const ACN_PID: &[u8; 12] = b"ASC-E1.17\0\0\0";
/// Root 层向量：E1.31 数据包。
pub const VECTOR_ROOT_DATA: u32 = 0x0000_0004;
/// Framing 层向量：数据包。
pub const VECTOR_FRAMING_DATA: u32 = 0x0000_0002;
/// DMP 层向量：Set Property。
pub const VECTOR_DMP_SET: u8 = 0x02;

/// 解析出的 sACN 数据包关键字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SacnData {
    /// Universe（1~63999）。
    pub universe: u16,
    /// 优先级（0~200）。
    pub priority: u8,
    /// 序列号。
    pub sequence: u8,
    /// 源名称。
    pub source_name: String,
    /// 发送者 CID。
    pub cid: [u8; 16],
    /// 通道数据（不含 START Code）。
    pub data: Vec<u8>,
}

/// 计算某 Universe 的 sACN 组播地址 `239.255.<hi>.<lo>`。
///
/// # Arguments
///
/// * `universe` - Universe 编号。
///
/// # Returns
///
/// 对应的 IPv4 组播地址。
#[must_use]
pub fn multicast_addr(universe: u16) -> Ipv4Addr {
    Ipv4Addr::new(239, 255, (universe >> 8) as u8, (universe & 0xFF) as u8)
}

/// 判定缓冲是否为合法 sACN 包（Root 层标识匹配）。
#[must_use]
pub fn is_sacn(buf: &[u8]) -> bool {
    buf.len() >= 38 && &buf[4..16] == ACN_PID
}

/// 解析 sACN E1.31 数据包。
///
/// # Arguments
///
/// * `buf` - UDP 载荷。
///
/// # Returns
///
/// 解析出的 [`SacnData`]；非数据包或过短返回 `None`。
#[must_use]
#[allow(clippy::missing_panics_doc)]
pub fn parse(buf: &[u8]) -> Option<SacnData> {
    if !is_sacn(buf) {
        return None;
    }
    // Root 向量
    if BigEndian::read_u32(&buf[18..22]) != VECTOR_ROOT_DATA {
        return None;
    }
    let mut cid = [0u8; 16];
    cid.copy_from_slice(&buf[22..38]);

    // Framing 层从偏移 38 开始
    if buf.len() < 115 {
        return None;
    }
    if BigEndian::read_u32(&buf[40..44]) != VECTOR_FRAMING_DATA {
        return None;
    }
    let source_name = {
        let raw = &buf[44..108];
        let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
        String::from_utf8_lossy(&raw[..end]).into_owned()
    };
    let priority = buf[108];
    let sequence = buf[111];
    let universe = BigEndian::read_u16(&buf[113..115]);

    // DMP 层从偏移 115 开始
    if buf.len() < 126 {
        return None;
    }
    if buf[117] != VECTOR_DMP_SET {
        return None;
    }
    let prop_count = BigEndian::read_u16(&buf[123..125]) as usize;
    // 属性值首字节为 START Code，随后为通道数据
    let values_start = 125;
    if prop_count == 0 || buf.len() < values_start + prop_count {
        return None;
    }
    let data = buf[values_start + 1..values_start + prop_count].to_vec();

    Some(SacnData {
        universe,
        priority,
        sequence,
        source_name,
        cid,
        data,
    })
}

/// Framing 层 Options 字节中的 Stream_Terminated 位：通知接收端该源已停止发送该 Universe。
pub const OPT_STREAM_TERMINATED: u8 = 0x40;

/// 构造一个 sACN E1.31 数据包。
///
/// # Arguments
///
/// * `universe` - Universe 编号。
/// * `data` - 通道数据（不含 START Code，最多 512）。
/// * `cid` - 发送者 CID。
/// * `source_name` - 源名称（截断/补齐到 64 字节）。
/// * `priority` - 优先级（0~200）。
/// * `sequence` - 序列号。
///
/// # Returns
///
/// 完整 sACN 数据包字节缓冲（Options 为 0）。
#[must_use]
pub fn build(
    universe: u16,
    data: &[u8],
    cid: &[u8; 16],
    source_name: &str,
    priority: u8,
    sequence: u8,
) -> Vec<u8> {
    build_with_options(universe, data, cid, source_name, priority, sequence, 0x00)
}

/// 构造带 Stream_Terminated 标志的 sACN 数据包（源停止发送某 Universe 时发出，规范建议连发 3 次）。
///
/// # Arguments
///
/// 与 [`build`] 相同。
///
/// # Returns
///
/// 完整 sACN 数据包字节缓冲（Options 的 Stream_Terminated 位置 1）。
#[must_use]
pub fn build_terminated(
    universe: u16,
    data: &[u8],
    cid: &[u8; 16],
    source_name: &str,
    priority: u8,
    sequence: u8,
) -> Vec<u8> {
    build_with_options(
        universe,
        data,
        cid,
        source_name,
        priority,
        sequence,
        OPT_STREAM_TERMINATED,
    )
}

/// 构造 sACN E1.31 数据包，并显式指定 Framing 层 Options 字节。
///
/// # Arguments
///
/// * `universe` - Universe 编号。
/// * `data` - 通道数据（不含 START Code，最多 512）。
/// * `cid` - 发送者 CID。
/// * `source_name` - 源名称（截断/补齐到 64 字节）。
/// * `priority` - 优先级（0~200）。
/// * `sequence` - 序列号。
/// * `options` - Framing 层 Options 字节（如 [`OPT_STREAM_TERMINATED`]）。
///
/// # Returns
///
/// 完整 sACN 数据包字节缓冲。
#[must_use]
pub fn build_with_options(
    universe: u16,
    data: &[u8],
    cid: &[u8; 16],
    source_name: &str,
    priority: u8,
    sequence: u8,
    options: u8,
) -> Vec<u8> {
    let channels = data.len().min(512);
    let prop_count = (channels + 1) as u16; // 含 START Code
    let dmp_len = 10 + 1 + channels; // DMP 层字节数
    let framing_len = 77 + dmp_len; // Framing 层字节数
    let root_pdu_len = 22 + framing_len; // Root PDU 字节数（flags+len 之后）

    let mut buf = Vec::with_capacity(126 + channels);

    // ---- Root 层 ----
    buf.extend_from_slice(&[0x00, 0x10]); // Preamble Size
    buf.extend_from_slice(&[0x00, 0x00]); // Postamble Size
    buf.extend_from_slice(ACN_PID);
    push_flags_len(&mut buf, root_pdu_len as u16);
    let mut v = [0u8; 4];
    BigEndian::write_u32(&mut v, VECTOR_ROOT_DATA);
    buf.extend_from_slice(&v);
    buf.extend_from_slice(cid);

    // ---- Framing 层 ----
    push_flags_len(&mut buf, framing_len as u16);
    BigEndian::write_u32(&mut v, VECTOR_FRAMING_DATA);
    buf.extend_from_slice(&v);
    let mut name = [0u8; 64];
    let nb = source_name.as_bytes();
    let n = nb.len().min(63);
    name[..n].copy_from_slice(&nb[..n]);
    buf.extend_from_slice(&name);
    buf.push(priority);
    buf.extend_from_slice(&[0x00, 0x00]); // Sync Address
    buf.push(sequence);
    buf.push(options); // Options
    let mut uni = [0u8; 2];
    BigEndian::write_u16(&mut uni, universe);
    buf.extend_from_slice(&uni);

    // ---- DMP 层 ----
    push_flags_len(&mut buf, dmp_len as u16);
    buf.push(VECTOR_DMP_SET);
    buf.push(0xA1); // Address Type & Data Type
    buf.extend_from_slice(&[0x00, 0x00]); // First Property Address
    buf.extend_from_slice(&[0x00, 0x01]); // Address Increment
    let mut pc = [0u8; 2];
    BigEndian::write_u16(&mut pc, prop_count);
    buf.extend_from_slice(&pc);
    buf.push(0x00); // START Code
    buf.extend_from_slice(&data[..channels]);

    buf
}

/// 写入 E1.31 的 "flags + length" 字段（高 4 位固定 0x7，低 12 位为长度）。
fn push_flags_len(buf: &mut Vec<u8>, len: u16) {
    let fl = 0x7000 | (len & 0x0FFF);
    let mut b = [0u8; 2];
    BigEndian::write_u16(&mut b, fl);
    buf.extend_from_slice(&b);
}

#[cfg(test)]
mod tests {
    use super::{
        build, build_terminated, build_with_options, multicast_addr, parse, OPT_STREAM_TERMINATED,
    };

    /// Framing 层 Options 字节在包内的偏移。
    const OPTIONS_OFFSET: usize = 112;

    #[test]
    fn options_byte_defaults_to_zero_and_terminated_sets_bit_six() {
        let plain = build(1, &[1, 2, 3], &[0u8; 16], "x", 100, 1);
        assert_eq!(plain[OPTIONS_OFFSET], 0x00);

        let term = build_terminated(1, &[1, 2, 3], &[0u8; 16], "x", 100, 1);
        assert_eq!(term[OPTIONS_OFFSET], 0x40);
        assert_eq!(term[OPTIONS_OFFSET], OPT_STREAM_TERMINATED);

        // 除 Options 一个字节外，两种包完全相同，且终止包仍可被正常解析
        assert_eq!(plain.len(), term.len());
        let diff: Vec<usize> = (0..plain.len()).filter(|&i| plain[i] != term[i]).collect();
        assert_eq!(diff, vec![OPTIONS_OFFSET]);
        assert_eq!(parse(&term), parse(&plain));

        let custom = build_with_options(1, &[], &[0u8; 16], "x", 100, 1, 0x80);
        assert_eq!(custom[OPTIONS_OFFSET], 0x80);
    }

    #[test]
    fn sacn_roundtrip() {
        let data: Vec<u8> = (0..512u16).map(|i| (i % 256) as u8).collect();
        let cid = [1u8; 16];
        let buf = build(100, &data, &cid, "Art-Net Studio", 100, 42);
        let p = parse(&buf).unwrap();
        assert_eq!(p.universe, 100);
        assert_eq!(p.priority, 100);
        assert_eq!(p.sequence, 42);
        assert_eq!(p.source_name, "Art-Net Studio");
        assert_eq!(p.cid, cid);
        assert_eq!(p.data, data);
    }

    #[test]
    fn short_frame_roundtrip() {
        let data = vec![10u8, 20, 30];
        let buf = build(1, &data, &[0u8; 16], "x", 100, 1);
        assert_eq!(parse(&buf).unwrap().data, data);
    }

    #[test]
    fn multicast_mapping() {
        assert_eq!(multicast_addr(1).to_string(), "239.255.0.1");
        assert_eq!(multicast_addr(0x0102).to_string(), "239.255.1.2");
    }

    #[test]
    fn non_sacn_rejected() {
        assert!(parse(&[0u8; 50]).is_none());
    }
}
