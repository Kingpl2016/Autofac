//! sACN (ANSI E1.31) 数据包编解码（E1.31 Data Packet，DMP 层）。

use std::net::Ipv4Addr;

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

/// Framing 层 `Source Name` 字段的固定字节数。
pub const SOURCE_NAME_LEN: usize = 64;

/// 单帧 E1.31 数据包允许的最大通道数（不含 START Code）。
const MAX_CHANNELS: usize = 512;

/// 通道数据（START Code 之后）在包内的起始偏移；也是 0 通道时的包长。
const DATA_OFFSET: usize = 126;

/// E1.31 数据包的最大字节数（126 字节各层头 + 512 通道 = 638），即
/// [`build_into`] / [`build_terminated_into`] 输出缓冲的长度。
pub const SACN_MAX_LEN: usize = DATA_OFFSET + MAX_CHANNELS;

/// Framing 层 `Source Name` 字段在包内的偏移。
const SOURCE_NAME_OFFSET: usize = 44;

/// Framing 层 Options 字节在包内的偏移。
const OPTIONS_OFFSET: usize = 112;

/// 解析出的 sACN 数据包关键字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SacnData {
    /// Universe（1~63999）。
    pub universe: u16,
    /// 优先级（0~200）。
    pub priority: u8,
    /// 序列号。
    pub sequence: u8,
    /// 源名称字段的原始 64 字节（UTF-8，以 NUL 结尾 / 补齐）。
    ///
    /// 解析时按值复制、不做解码，避免热路径上的堆分配；需要文本时调用
    /// [`SacnData::source_name`]。
    pub source_name_raw: [u8; SOURCE_NAME_LEN],
    /// 发送者 CID。
    pub cid: [u8; 16],
    /// 通道数据（不含 START Code）。
    pub data: Vec<u8>,
}

impl SacnData {
    /// 把原始源名称字段解码为字符串。
    ///
    /// 规则与旧版 `source_name: String` 字段完全相同：截取到第一个 NUL 之前
    /// （无 NUL 时取全部 64 字节），再按 UTF-8 宽松解码（非法序列替换为 `U+FFFD`）。
    ///
    /// # Returns
    ///
    /// 解码后的源名称（新分配的 `String`）。
    #[must_use]
    pub fn source_name(&self) -> String {
        let raw = &self.source_name_raw;
        let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
        String::from_utf8_lossy(&raw[..end]).into_owned()
    }
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
/// 源名称只按原始 64 字节复制（见 [`SacnData::source_name_raw`]），整个解析只有
/// 通道数据一次堆分配。
///
/// # Arguments
///
/// * `buf` - UDP 载荷。
///
/// # Returns
///
/// 解析出的 [`SacnData`]；非数据包或过短返回 `None`。
#[must_use]
pub fn parse(buf: &[u8]) -> Option<SacnData> {
    if !is_sacn(buf) {
        return None;
    }
    // Root 向量
    if u32::from_be_bytes([buf[18], buf[19], buf[20], buf[21]]) != VECTOR_ROOT_DATA {
        return None;
    }
    let mut cid = [0u8; 16];
    cid.copy_from_slice(&buf[22..38]);

    // Framing 层从偏移 38 开始
    if buf.len() < 115 {
        return None;
    }
    if u32::from_be_bytes([buf[40], buf[41], buf[42], buf[43]]) != VECTOR_FRAMING_DATA {
        return None;
    }
    // 源名称按原始字节复制（不解码、不分配），由 `SacnData::source_name` 按需解码
    let mut source_name_raw = [0u8; SOURCE_NAME_LEN];
    source_name_raw.copy_from_slice(&buf[SOURCE_NAME_OFFSET..SOURCE_NAME_OFFSET + SOURCE_NAME_LEN]);
    let priority = buf[108];
    let sequence = buf[111];
    let universe = u16::from_be_bytes([buf[113], buf[114]]);

    // DMP 层从偏移 115 开始
    if buf.len() < 126 {
        return None;
    }
    if buf[117] != VECTOR_DMP_SET {
        return None;
    }
    let prop_count = u16::from_be_bytes([buf[123], buf[124]]) as usize;
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
        source_name_raw,
        cid,
        data,
    })
}

/// Framing 层 Options 字节中的 Stream_Terminated 位：通知接收端该源已停止发送该 Universe。
pub const OPT_STREAM_TERMINATED: u8 = 0x40;

/// 把 sACN E1.31 数据包写入调用方提供的定长缓冲（零堆分配，Options 为 0）。
///
/// 字段布局（偏移）：Root 层 0..38（Preamble / Postamble / ACN PID / flags+len /
/// 向量 / CID）、Framing 层 38..115（flags+len / 向量 / 源名称 64 字节 / 优先级 /
/// Sync Address / 序列号 / Options / Universe）、DMP 层 115..126（flags+len / 向量 /
/// 地址与数据类型 / 首属性地址 / 地址增量 / 属性数 / START Code），其后为通道数据。
///
/// # Arguments
///
/// * `universe` - Universe 编号。
/// * `data` - 通道数据（不含 START Code）；超过 512 字节时截断为前 512 字节。
/// * `cid` - 发送者 CID。
/// * `source_name` - 源名称；按字节截断到 63 字节，其余以 NUL 补齐到 64 字节。
/// * `priority` - 优先级（0~200）。
/// * `sequence` - 序列号。
/// * `out` - 输出缓冲；只写入前 `n` 字节（`n` 为返回值），其余字节保持原样，
///   因此可在多次调用间复用而无需清零。
///
/// # Returns
///
/// 写入 `out` 的数据包字节数（`126 + 通道数`，最大 [`SACN_MAX_LEN`]）。
#[must_use]
pub fn build_into(
    universe: u16,
    data: &[u8],
    cid: &[u8; 16],
    source_name: &str,
    priority: u8,
    sequence: u8,
    out: &mut [u8; SACN_MAX_LEN],
) -> usize {
    let channels = data.len().min(MAX_CHANNELS);
    // 以下长度均 <= 638，转 u16 不会截断
    let prop_count = (channels + 1) as u16; // 含 START Code
    let dmp_len = 10 + 1 + channels; // DMP 层字节数
    let framing_len = 77 + dmp_len; // Framing 层字节数
    let root_pdu_len = 22 + framing_len; // Root PDU 字节数（flags+len 之后）

    // ---- Root 层 ----
    out[0..2].copy_from_slice(&[0x00, 0x10]); // Preamble Size
    out[2..4].copy_from_slice(&[0x00, 0x00]); // Postamble Size
    out[4..16].copy_from_slice(ACN_PID);
    out[16..18].copy_from_slice(&flags_len(root_pdu_len as u16));
    out[18..22].copy_from_slice(&VECTOR_ROOT_DATA.to_be_bytes());
    out[22..38].copy_from_slice(cid);

    // ---- Framing 层 ----
    out[38..40].copy_from_slice(&flags_len(framing_len as u16));
    out[40..44].copy_from_slice(&VECTOR_FRAMING_DATA.to_be_bytes());
    let name = &mut out[SOURCE_NAME_OFFSET..SOURCE_NAME_OFFSET + SOURCE_NAME_LEN];
    let nb = source_name.as_bytes();
    let n = nb.len().min(SOURCE_NAME_LEN - 1);
    name[..n].copy_from_slice(&nb[..n]);
    name[n..].fill(0);
    out[108] = priority;
    out[109..111].copy_from_slice(&[0x00, 0x00]); // Sync Address
    out[111] = sequence;
    out[OPTIONS_OFFSET] = 0x00; // Options
    out[113..115].copy_from_slice(&universe.to_be_bytes());

    // ---- DMP 层 ----
    out[115..117].copy_from_slice(&flags_len(dmp_len as u16));
    out[117] = VECTOR_DMP_SET;
    out[118] = 0xA1; // Address Type & Data Type
    out[119..121].copy_from_slice(&[0x00, 0x00]); // First Property Address
    out[121..123].copy_from_slice(&[0x00, 0x01]); // Address Increment
    out[123..125].copy_from_slice(&prop_count.to_be_bytes());
    out[125] = 0x00; // START Code
    out[DATA_OFFSET..DATA_OFFSET + channels].copy_from_slice(&data[..channels]);

    DATA_OFFSET + channels
}

/// 给已组好的数据包写入 Framing 层的同步地址（Synchronization Address）。
///
/// 接收端收到带同步地址的数据包后，会缓存数据直到收到该 Universe 的同步包再一起输出。
///
/// # Arguments
///
/// * `out` - 由 [`build_into`] 写好的数据包缓冲。
/// * `sync_universe` - 同步 Universe（1~63999）；0 表示不同步。
pub fn set_sync_address(out: &mut [u8; SACN_MAX_LEN], sync_universe: u16) {
    out[109..111].copy_from_slice(&sync_universe.to_be_bytes());
}

/// Root 层向量：E1.31 扩展包（同步 / 发现）。
pub const VECTOR_ROOT_EXTENDED: u32 = 0x0000_0008;
/// 扩展 Framing 层向量：同步包。
pub const VECTOR_EXTENDED_SYNC: u32 = 0x0000_0001;
/// E1.31 同步包的字节数（Root 层 38 + 同步 Framing 层 11）。
pub const SACN_SYNC_LEN: usize = 49;

/// 构造 E1.31 同步包（Synchronization Packet，E1.31 §6.3）。
///
/// # Arguments
///
/// * `cid` - 发送者 CID（与数据包一致）。
/// * `sequence` - 同步包自己的序列号。
/// * `sync_universe` - 同步 Universe（1~63999）。
///
/// # Returns
///
/// 49 字节同步包。
#[must_use]
pub fn build_sync(cid: &[u8; 16], sequence: u8, sync_universe: u16) -> [u8; SACN_SYNC_LEN] {
    let mut out = [0u8; SACN_SYNC_LEN];
    out[0..2].copy_from_slice(&[0x00, 0x10]);
    out[2..4].copy_from_slice(&[0x00, 0x00]);
    out[4..16].copy_from_slice(ACN_PID);
    out[16..18].copy_from_slice(&flags_len((SACN_SYNC_LEN - 16) as u16));
    out[18..22].copy_from_slice(&VECTOR_ROOT_EXTENDED.to_be_bytes());
    out[22..38].copy_from_slice(cid);
    out[38..40].copy_from_slice(&flags_len(11));
    out[40..44].copy_from_slice(&VECTOR_EXTENDED_SYNC.to_be_bytes());
    out[44] = sequence;
    out[45..47].copy_from_slice(&sync_universe.to_be_bytes());
    // 46..49：Reserved，保持 0
    out
}

/// 把带 Stream_Terminated 标志的 sACN 数据包写入调用方提供的定长缓冲（零堆分配）。
///
/// 与 [`build_into`] 相同，仅 Options 字节为 [`OPT_STREAM_TERMINATED`]。
///
/// # Arguments
///
/// * `universe` - Universe 编号。
/// * `data` - 通道数据（不含 START Code）；超过 512 字节时截断为前 512 字节。
/// * `cid` - 发送者 CID。
/// * `source_name` - 源名称；按字节截断到 63 字节，其余以 NUL 补齐到 64 字节。
/// * `priority` - 优先级（0~200）。
/// * `sequence` - 序列号。
/// * `out` - 输出缓冲；只写入前 `n` 字节（`n` 为返回值）。
///
/// # Returns
///
/// 写入 `out` 的数据包字节数（`126 + 通道数`，最大 [`SACN_MAX_LEN`]）。
#[must_use]
pub fn build_terminated_into(
    universe: u16,
    data: &[u8],
    cid: &[u8; 16],
    source_name: &str,
    priority: u8,
    sequence: u8,
    out: &mut [u8; SACN_MAX_LEN],
) -> usize {
    let n = build_into(universe, data, cid, source_name, priority, sequence, out);
    out[OPTIONS_OFFSET] = OPT_STREAM_TERMINATED;
    n
}

/// 构造一个 sACN E1.31 数据包。
///
/// 等价于 [`build_into`] 后把有效部分拷贝为 `Vec`（一次堆分配）；热路径请直接
/// 使用 [`build_into`]。
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
/// 热路径请使用零分配的 [`build_terminated_into`]。
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
    let mut out = [0u8; SACN_MAX_LEN];
    let n = build_into(
        universe,
        data,
        cid,
        source_name,
        priority,
        sequence,
        &mut out,
    );
    out[OPTIONS_OFFSET] = options;
    out[..n].to_vec()
}

/// 生成 E1.31 的 "flags + length" 字段（大端；高 4 位固定 0x7，低 12 位为长度）。
fn flags_len(len: u16) -> [u8; 2] {
    (0x7000 | (len & 0x0FFF)).to_be_bytes()
}

/// 旧实现（`Vec` 逐段追加组包、解析时直接解码源名称）的原样拷贝，仅作一致性测试的参照。
#[cfg(test)]
mod reference {
    use super::{is_sacn, ACN_PID, VECTOR_DMP_SET, VECTOR_FRAMING_DATA, VECTOR_ROOT_DATA};

    /// 旧版解析结果（`source_name` 为解码后的 `String`）。
    #[derive(Debug, PartialEq, Eq)]
    pub(super) struct OldSacnData {
        pub(super) universe: u16,
        pub(super) priority: u8,
        pub(super) sequence: u8,
        pub(super) source_name: String,
        pub(super) cid: [u8; 16],
        pub(super) data: Vec<u8>,
    }

    /// 旧版 `parse`。
    pub(super) fn parse(buf: &[u8]) -> Option<OldSacnData> {
        if !is_sacn(buf) {
            return None;
        }
        if u32::from_be_bytes([buf[18], buf[19], buf[20], buf[21]]) != VECTOR_ROOT_DATA {
            return None;
        }
        let mut cid = [0u8; 16];
        cid.copy_from_slice(&buf[22..38]);
        if buf.len() < 115 {
            return None;
        }
        if u32::from_be_bytes([buf[40], buf[41], buf[42], buf[43]]) != VECTOR_FRAMING_DATA {
            return None;
        }
        let source_name = {
            let raw = &buf[44..108];
            let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
            String::from_utf8_lossy(&raw[..end]).into_owned()
        };
        let priority = buf[108];
        let sequence = buf[111];
        let universe = u16::from_be_bytes([buf[113], buf[114]]);
        if buf.len() < 126 {
            return None;
        }
        if buf[117] != VECTOR_DMP_SET {
            return None;
        }
        let prop_count = u16::from_be_bytes([buf[123], buf[124]]) as usize;
        let values_start = 125;
        if prop_count == 0 || buf.len() < values_start + prop_count {
            return None;
        }
        let data = buf[values_start + 1..values_start + prop_count].to_vec();
        Some(OldSacnData {
            universe,
            priority,
            sequence,
            source_name,
            cid,
            data,
        })
    }

    /// 旧版 `build_with_options`。
    pub(super) fn build_with_options(
        universe: u16,
        data: &[u8],
        cid: &[u8; 16],
        source_name: &str,
        priority: u8,
        sequence: u8,
        options: u8,
    ) -> Vec<u8> {
        let channels = data.len().min(512);
        let prop_count = (channels + 1) as u16;
        let dmp_len = 10 + 1 + channels;
        let framing_len = 77 + dmp_len;
        let root_pdu_len = 22 + framing_len;

        let mut buf = Vec::with_capacity(126 + channels);

        buf.extend_from_slice(&[0x00, 0x10]);
        buf.extend_from_slice(&[0x00, 0x00]);
        buf.extend_from_slice(ACN_PID);
        push_flags_len(&mut buf, root_pdu_len as u16);
        buf.extend_from_slice(&VECTOR_ROOT_DATA.to_be_bytes());
        buf.extend_from_slice(cid);

        push_flags_len(&mut buf, framing_len as u16);
        buf.extend_from_slice(&VECTOR_FRAMING_DATA.to_be_bytes());
        let mut name = [0u8; 64];
        let nb = source_name.as_bytes();
        let n = nb.len().min(63);
        name[..n].copy_from_slice(&nb[..n]);
        buf.extend_from_slice(&name);
        buf.push(priority);
        buf.extend_from_slice(&[0x00, 0x00]);
        buf.push(sequence);
        buf.push(options);
        buf.extend_from_slice(&universe.to_be_bytes());

        push_flags_len(&mut buf, dmp_len as u16);
        buf.push(VECTOR_DMP_SET);
        buf.push(0xA1);
        buf.extend_from_slice(&[0x00, 0x00]);
        buf.extend_from_slice(&[0x00, 0x01]);
        buf.extend_from_slice(&prop_count.to_be_bytes());
        buf.push(0x00);
        buf.extend_from_slice(&data[..channels]);

        buf
    }

    /// 旧版 `push_flags_len`。
    fn push_flags_len(buf: &mut Vec<u8>, len: u16) {
        let fl = 0x7000 | (len & 0x0FFF);
        buf.extend_from_slice(&fl.to_be_bytes());
    }
}

/// 新实现与 [`reference`] 旧实现的逐字节 / 逐字段一致性测试。
#[cfg(test)]
mod equivalence {
    use super::{
        build, build_into, build_terminated, build_terminated_into, build_with_options, parse,
        reference, OPT_STREAM_TERMINATED, SACN_MAX_LEN, SOURCE_NAME_OFFSET,
    };

    /// 一致性测试覆盖的最大通道数：超过 512 以验证截断。
    const MAX_TEST_LEN: usize = 520;

    /// 覆盖边界的源名称：空、普通 ASCII、恰 63 / 64 / 超长字节、
    /// 多字节 UTF-8 在第 63 字节处被截断、内嵌 NUL。
    fn source_names() -> Vec<String> {
        vec![
            String::new(),
            "Art-Net Studio".to_owned(),
            "a".repeat(63),
            "b".repeat(64),
            "c".repeat(100),
            // 31 个 "é"（各 2 字节）= 62 字节，再接 "中"（3 字节）跨越 63 字节截断点
            format!("{}中", "é".repeat(31)),
            "灯光".repeat(20),
            "head\0tail".to_owned(),
        ]
    }

    /// 生成长度为 `len` 的确定性通道数据（全非 0）。
    fn data_of(len: usize) -> Vec<u8> {
        (0..len).map(|i| ((i * 13 + len) % 255 + 1) as u8).collect()
    }

    /// 断言新旧 `parse` 对同一输入给出等价结果（源名称经 `source_name()` 解码后比较）。
    fn assert_parse_same(buf: &[u8]) {
        let new = parse(buf);
        let old = reference::parse(buf);
        match (new, old) {
            (None, None) => {}
            (Some(n), Some(o)) => {
                assert_eq!(n.universe, o.universe);
                assert_eq!(n.priority, o.priority);
                assert_eq!(n.sequence, o.sequence);
                assert_eq!(n.source_name(), o.source_name);
                assert_eq!(n.cid, o.cid);
                assert_eq!(n.data, o.data);
            }
            (n, o) => panic!("新旧解析结果不一致：new={n:?} old={o:?}"),
        }
    }

    #[test]
    fn build_matches_reference_byte_for_byte() {
        let cid: [u8; 16] = *b"0123456789abcdef";
        for name in source_names() {
            for len in 0..=MAX_TEST_LEN {
                let data = data_of(len);
                // Universe / 优先级 / 序列号取不同组合，覆盖高低字节
                let (universe, priority, seq) = match len % 3 {
                    0 => (1, 100, 0),
                    1 => (0x1234, 200, 255),
                    _ => (u16::MAX, 0, 77),
                };
                let plain =
                    reference::build_with_options(universe, &data, &cid, &name, priority, seq, 0);
                let term = reference::build_with_options(
                    universe,
                    &data,
                    &cid,
                    &name,
                    priority,
                    seq,
                    OPT_STREAM_TERMINATED,
                );
                assert_eq!(
                    build(universe, &data, &cid, &name, priority, seq),
                    plain,
                    "len={len} name={name:?}"
                );
                assert_eq!(
                    build_terminated(universe, &data, &cid, &name, priority, seq),
                    term
                );
                for options in [0x00, 0x80, 0xFF] {
                    assert_eq!(
                        build_with_options(universe, &data, &cid, &name, priority, seq, options),
                        reference::build_with_options(
                            universe, &data, &cid, &name, priority, seq, options
                        ),
                    );
                }

                // 预填垃圾字节，验证 *_into 不依赖调用方清零
                let mut out = [0xA5u8; SACN_MAX_LEN];
                let n = build_into(universe, &data, &cid, &name, priority, seq, &mut out);
                assert_eq!(&out[..n], &plain[..], "into: len={len} name={name:?}");
                let mut out = [0x5Au8; SACN_MAX_LEN];
                let n =
                    build_terminated_into(universe, &data, &cid, &name, priority, seq, &mut out);
                assert_eq!(
                    &out[..n],
                    &term[..],
                    "terminated_into: len={len} name={name:?}"
                );
            }
        }
    }

    #[test]
    fn parse_matches_reference_for_built_packets() {
        let cid = [9u8; 16];
        for name in source_names() {
            for len in 0..=MAX_TEST_LEN {
                assert_parse_same(&build(3, &data_of(len), &cid, &name, 100, 5));
            }
        }
    }

    #[test]
    fn parse_matches_reference_for_raw_source_name_bytes() {
        let base = build(1, &[1, 2, 3], &[0u8; 16], "x", 100, 1);
        let field = SOURCE_NAME_OFFSET..SOURCE_NAME_OFFSET + 64;

        // 64 字节全非 NUL（无结尾 NUL）：应整段解码
        let mut no_nul = base.clone();
        no_nul[field.clone()].fill(b'A');
        assert_parse_same(&no_nul);
        assert_eq!(
            parse(&no_nul).map(|d| d.source_name()),
            Some("A".repeat(64))
        );

        // 非法 UTF-8 字节：宽松解码为 U+FFFD
        let mut invalid = base.clone();
        invalid[field.start..field.start + 4].copy_from_slice(&[b'o', 0xFF, 0xC3, b'k']);
        assert_parse_same(&invalid);

        // NUL 之后的残留字节应被忽略
        let mut trailing = base.clone();
        trailing[field.start..field.start + 6].copy_from_slice(b"ab\0cd\0");
        assert_parse_same(&trailing);
        assert_eq!(
            parse(&trailing).map(|d| d.source_name()),
            Some("ab".to_owned())
        );
    }

    #[test]
    fn parse_matches_reference_for_truncated_and_corrupt_input() {
        let full = build(7, &[1, 2, 3, 4], &[3u8; 16], "src", 100, 2);
        for cut in 0..=full.len() {
            assert_parse_same(&full[..cut]);
        }
        // 逐字节翻转各层头部（含 PID、向量、属性数），新旧须一致
        for i in 0..full.len() {
            let mut bad = full.clone();
            bad[i] ^= 0x41;
            assert_parse_same(&bad);
        }
    }
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
        assert_eq!(p.source_name(), "Art-Net Studio");
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
