//! 协议无关的 DMX 帧与 Universe 地址辅助。

use std::net::IpAddr;
use std::time::Instant;

use bytes::Bytes;
use serde::{Deserialize, Serialize};

/// 灯光信号协议类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum Protocol {
    /// Art-Net 4。
    ArtNet,
    /// sACN (E1.31)。
    Sacn,
}

/// 一帧 DMX 数据（协议无关）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DmxFrame {
    /// 来源协议。
    pub protocol: Protocol,
    /// Universe 编号：Art-Net 为 15 位 Port-Address，sACN 为 1~63999。
    pub universe: u16,
    /// 通道数据（不含 START Code）。
    ///
    /// 使用 [`Bytes`] 以便一帧被接收、录制旁路与合并引擎多方共享时，`clone`
    /// 仅为引用计数增减而非整段 DMX 数据（最多 512 字节）的深拷贝。
    pub data: Bytes,
    /// 源地址（若已知）。
    pub source: Option<IpAddr>,
    /// 序列号（用于丢包/乱序检测；无则为 0）。
    pub sequence: u8,
    /// 在 socket 接收点取得的单调时刻；录制据此生成时间轴，免受后续排队抖动
    /// 与系统时间调整的影响。
    pub received_at: Instant,
}

/// 由 Art-Net 的 Net 与 SubUni 字节组合出 15 位 Port-Address。
///
/// # Arguments
///
/// * `net` - Net 字节（高 7 位有效）。
/// * `sub_uni` - SubUni 字节（高 4 位为 SubNet，低 4 位为 Universe）。
///
/// # Returns
///
/// 15 位 Port-Address。
#[must_use]
pub fn port_address(net: u8, sub_uni: u8) -> u16 {
    ((u16::from(net) & 0x7F) << 8) | u16::from(sub_uni)
}

/// 从 15 位 Port-Address 还原 Net 字节。
#[must_use]
pub fn net_of(port_address: u16) -> u8 {
    ((port_address >> 8) & 0x7F) as u8
}

/// 从 15 位 Port-Address 还原 SubUni 字节。
#[must_use]
pub fn sub_uni_of(port_address: u16) -> u8 {
    (port_address & 0xFF) as u8
}
