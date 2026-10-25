//! ESP32-P4 TCP 1227 指令帧编解码。
//!
//! 帧格式：`[帧头 0x35][通信定义 1B][数据长度 2B][数据载荷 N B][校验和 1B]`，
//! 其中数据载荷 = `[寄存器 2B][交互数据]`，数据长度 = 载荷字节数（含寄存器 2B）。
//!
//! # 待与固件对齐的约定
//!
//! - 多字节字段（数据长度、寄存器）本实现采用**大端**。
//! - 校验和为"帧头至载荷末尾所有字节求和取低 8 位"。
//!
//! 二者文档未明确，若固件不同只需改本模块的 [`checksum`] 与字节序读写。

use byteorder::{BigEndian, ByteOrder};

use crate::error::{EspError, Result};

/// 帧头固定值。
pub const FRAME_HEADER: u8 = 0x35;
/// TCP 控制端口。
pub const ESP_TCP_PORT: u16 = 1227;

/// 操作码（通信定义字节的 bit6~4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum OpCode {
    /// set 确认，应答指令。
    SetAck = 0,
    /// set 操作，需确认，执行指令。
    SetConfirm = 1,
    /// set 操作，无需确认，执行指令。
    SetNoConfirm = 2,
    /// get 操作，执行指令。
    Get = 3,
    /// get 响应应答，应答指令。
    GetAck = 4,
    /// push 操作，需确认，执行指令。
    PushConfirm = 5,
    /// push 操作，无需确认，执行指令。
    PushNoConfirm = 6,
    /// push 确认，应答指令。
    PushAck = 7,
}

impl OpCode {
    /// 由 3 位值还原操作码。
    ///
    /// # Arguments
    ///
    /// * `v` - 0~7 的操作码值。
    ///
    /// # Returns
    ///
    /// 对应 [`OpCode`]；超出范围返回 `None`。
    #[must_use]
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::SetAck,
            1 => Self::SetConfirm,
            2 => Self::SetNoConfirm,
            3 => Self::Get,
            4 => Self::GetAck,
            5 => Self::PushConfirm,
            6 => Self::PushNoConfirm,
            7 => Self::PushAck,
            _ => return None,
        })
    }
}

/// 一条解析出的指令帧。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// 操作码。
    pub opcode: OpCode,
    /// 寄存器地址。
    pub register: u16,
    /// 交互数据（不含寄存器）。
    pub data: Vec<u8>,
}

/// 计算校验和：对 `bytes` 全部字节求和取低 8 位。
///
/// # Arguments
///
/// * `bytes` - 参与校验的字节（帧头至载荷末尾，不含校验和本身）。
///
/// # Returns
///
/// 8 位校验和。
#[must_use]
pub fn checksum(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0u8, |acc, &b| acc.wrapping_add(b))
}

/// 编码一条指令帧（单数据传输模式）。
///
/// # Arguments
///
/// * `opcode` - 操作码。
/// * `register` - 寄存器地址。
/// * `data` - 交互数据（不含寄存器）。
///
/// # Returns
///
/// 完整帧字节。
#[must_use]
pub fn encode(opcode: OpCode, register: u16, data: &[u8]) -> Vec<u8> {
    let payload_len = 2 + data.len();
    let mut buf = Vec::with_capacity(5 + payload_len);
    buf.push(FRAME_HEADER);
    // 通信定义：bit7=0 单数据传输，bit6~4=操作码，bit3~0=0
    buf.push((opcode as u8) << 4);
    let mut len = [0u8; 2];
    BigEndian::write_u16(&mut len, payload_len as u16);
    buf.extend_from_slice(&len);
    let mut reg = [0u8; 2];
    BigEndian::write_u16(&mut reg, register);
    buf.extend_from_slice(&reg);
    buf.extend_from_slice(data);
    let cs = checksum(&buf);
    buf.push(cs);
    buf
}

/// 解码一条完整指令帧。
///
/// # Arguments
///
/// * `buf` - 完整帧字节（恰好一帧）。
///
/// # Returns
///
/// 解析出的 [`Frame`]。
///
/// # Errors
///
/// - 帧头非法返回 [`EspError::BadHeader`]。
/// - 长度不足返回 [`EspError::Truncated`]。
/// - 操作码非法返回 [`EspError::BadOpcode`]。
/// - 校验和不符返回 [`EspError::BadChecksum`]。
pub fn decode(buf: &[u8]) -> Result<Frame> {
    if buf.len() < 6 {
        return Err(EspError::Truncated);
    }
    if buf[0] != FRAME_HEADER {
        return Err(EspError::BadHeader(buf[0]));
    }
    let opcode = OpCode::from_u8((buf[1] >> 4) & 0x07).ok_or(EspError::BadOpcode(buf[1]))?;
    let payload_len = BigEndian::read_u16(&buf[2..4]) as usize;
    let frame_len = 5 + payload_len;
    if buf.len() < frame_len || payload_len < 2 {
        return Err(EspError::Truncated);
    }
    let register = BigEndian::read_u16(&buf[4..6]);
    let data = buf[6..4 + payload_len].to_vec();
    let expected = buf[frame_len - 1];
    let actual = checksum(&buf[..frame_len - 1]);
    if expected != actual {
        return Err(EspError::BadChecksum { expected, actual });
    }
    Ok(Frame {
        opcode,
        register,
        data,
    })
}

/// 尝试从流缓冲中解析一帧，返回 `(帧, 消耗字节数)`。
///
/// # Arguments
///
/// * `buf` - 可能含有一帧或多帧的缓冲。
///
/// # Returns
///
/// 成功解析返回 `Some((帧, 消耗字节数))`；数据不足返回 `None`。
///
/// # Errors
///
/// 帧头/操作码/校验非法时返回对应 [`EspError`]。
pub fn try_decode_stream(buf: &[u8]) -> Result<Option<(Frame, usize)>> {
    if buf.len() < 4 {
        return Ok(None);
    }
    if buf[0] != FRAME_HEADER {
        return Err(EspError::BadHeader(buf[0]));
    }
    let payload_len = BigEndian::read_u16(&buf[2..4]) as usize;
    let frame_len = 5 + payload_len;
    if buf.len() < frame_len {
        return Ok(None);
    }
    Ok(Some((decode(&buf[..frame_len])?, frame_len)))
}

#[cfg(test)]
mod tests {
    use super::{checksum, decode, encode, try_decode_stream, Frame, OpCode};

    #[test]
    fn encode_decode_roundtrip() {
        let buf = encode(OpCode::SetConfirm, 0x0003, &[4]);
        let f = decode(&buf).unwrap();
        assert_eq!(
            f,
            Frame {
                opcode: OpCode::SetConfirm,
                register: 0x0003,
                data: vec![4],
            }
        );
    }

    #[test]
    fn header_and_length_fields() {
        let buf = encode(OpCode::Get, 0x0001, &[10, 2, 3]);
        assert_eq!(buf[0], 0x35);
        assert_eq!((buf[1] >> 4) & 0x07, OpCode::Get as u8);
        // payload_len = 2(reg) + 3(data) = 5
        assert_eq!(u16::from(buf[2]) << 8 | u16::from(buf[3]), 5);
    }

    #[test]
    fn checksum_detects_corruption() {
        let mut buf = encode(OpCode::SetConfirm, 0x0000, &[2]);
        let last = buf.len() - 1;
        buf[6] ^= 0xFF; // 篡改数据
        // 重新用旧校验和 → 不匹配
        let _ = last;
        assert!(decode(&buf).is_err());
    }

    #[test]
    fn opcode_packing_all() {
        for op in [
            OpCode::SetAck,
            OpCode::SetConfirm,
            OpCode::SetNoConfirm,
            OpCode::Get,
            OpCode::GetAck,
            OpCode::PushConfirm,
            OpCode::PushNoConfirm,
            OpCode::PushAck,
        ] {
            let buf = encode(op, 0x0002, &[1, 3]);
            assert_eq!(decode(&buf).unwrap().opcode, op);
        }
    }

    #[test]
    fn stream_decode_consumes_one_frame() {
        let mut stream = encode(OpCode::SetConfirm, 0x0003, &[1]);
        let second = encode(OpCode::Get, 0x0003, &[]);
        stream.extend_from_slice(&second);
        let (f, used) = try_decode_stream(&stream).unwrap().unwrap();
        assert_eq!(f.register, 0x0003);
        assert_eq!(f.data, vec![1]);
        // 剩余部分可继续解析第二帧
        let (f2, _) = try_decode_stream(&stream[used..]).unwrap().unwrap();
        assert_eq!(f2.opcode, OpCode::Get);
    }

    #[test]
    fn checksum_sum_low_byte() {
        assert_eq!(checksum(&[0x35, 0x10, 0x00, 0x03]), 0x48);
    }
}
