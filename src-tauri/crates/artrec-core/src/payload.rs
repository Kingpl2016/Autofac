//! 全量帧 / 差分帧 Payload 的装配与拆分。

use byteorder::{BigEndian, ByteOrder};

use crate::error::{ArtRecError, Result};
use crate::model::UniDesc;

/// 按 UniDesc 顺序将各路 DMX 缓冲拼接为全量帧原始 Payload。
///
/// # Arguments
///
/// * `unis` - Universe 描述表（决定拼接顺序与各段长度）。
/// * `buffers` - 与 `unis` 等长、一一对应的各路 DMX 数据。
///
/// # Returns
///
/// 拼接后的原始 Payload。
///
/// # Errors
///
/// `buffers` 数量或某段长度与 `unis` 声明不符时返回 [`ArtRecError::PayloadLenMismatch`]。
pub fn assemble_full(unis: &[UniDesc], buffers: &[Vec<u8>]) -> Result<Vec<u8>> {
    if buffers.len() != unis.len() {
        return Err(ArtRecError::PayloadLenMismatch {
            expected: unis.len(),
            actual: buffers.len(),
        });
    }
    let total: usize = unis.iter().map(|u| u.dmx_len as usize).sum();
    let mut out = Vec::with_capacity(total);
    for (u, buf) in unis.iter().zip(buffers) {
        if buf.len() != u.dmx_len as usize {
            return Err(ArtRecError::PayloadLenMismatch {
                expected: u.dmx_len as usize,
                actual: buf.len(),
            });
        }
        out.extend_from_slice(buf);
    }
    Ok(out)
}

/// 将全量帧原始 Payload 按 UniDesc 顺序拆分为各路 DMX 缓冲。
///
/// # Arguments
///
/// * `unis` - Universe 描述表。
/// * `payload` - 解压后的全量帧原始 Payload。
///
/// # Returns
///
/// 与 `unis` 一一对应的各路 DMX 缓冲。
///
/// # Errors
///
/// Payload 总长与 UniDesc 累加长度不符返回 [`ArtRecError::PayloadLenMismatch`]。
pub fn split_full(unis: &[UniDesc], payload: &[u8]) -> Result<Vec<Vec<u8>>> {
    let total: usize = unis.iter().map(|u| u.dmx_len as usize).sum();
    if payload.len() != total {
        return Err(ArtRecError::PayloadLenMismatch {
            expected: total,
            actual: payload.len(),
        });
    }
    let mut out = Vec::with_capacity(unis.len());
    let mut pos = 0usize;
    for u in unis {
        let len = u.dmx_len as usize;
        out.push(payload[pos..pos + len].to_vec());
        pos += len;
    }
    Ok(out)
}

/// 单个差分变更点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffChange {
    /// 对应 UniDesc 数组下标。
    pub uni_idx: u16,
    /// DMX 通道地址 0~511。
    pub ch_addr: u16,
    /// 新通道值。
    pub ch_val: u8,
}

/// 将差分变更列表编码为差分帧 Payload。
///
/// # Arguments
///
/// * `changes` - 变更点列表。
///
/// # Returns
///
/// 差分帧原始 Payload（`u16 changed_cnt` + N×5 字节变更点）。
#[must_use]
pub fn encode_diff(changes: &[DiffChange]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + changes.len() * 5);
    let mut cnt = [0u8; 2];
    BigEndian::write_u16(&mut cnt, changes.len() as u16);
    out.extend_from_slice(&cnt);
    for c in changes {
        let mut rec = [0u8; 5];
        BigEndian::write_u16(&mut rec[0..2], c.uni_idx);
        BigEndian::write_u16(&mut rec[2..4], c.ch_addr);
        rec[4] = c.ch_val;
        out.extend_from_slice(&rec);
    }
    out
}

/// 解码差分帧 Payload 为变更列表。
///
/// # Arguments
///
/// * `payload` - 差分帧原始 Payload。
///
/// # Returns
///
/// 变更点列表。
///
/// # Errors
///
/// 长度不足以容纳声明的变更条数时返回 [`ArtRecError::Truncated`]。
pub fn decode_diff(payload: &[u8]) -> Result<Vec<DiffChange>> {
    if payload.len() < 2 {
        return Err(ArtRecError::Truncated("差分帧缺少 changed_cnt"));
    }
    let cnt = BigEndian::read_u16(&payload[0..2]) as usize;
    if payload.len() < 2 + cnt * 5 {
        return Err(ArtRecError::Truncated("差分帧变更点截断"));
    }
    let mut out = Vec::with_capacity(cnt);
    for i in 0..cnt {
        let base = 2 + i * 5;
        out.push(DiffChange {
            uni_idx: BigEndian::read_u16(&payload[base..base + 2]),
            ch_addr: BigEndian::read_u16(&payload[base + 2..base + 4]),
            ch_val: payload[base + 4],
        });
    }
    Ok(out)
}

/// 在上一帧各路缓冲基础上原地应用差分变更。
///
/// # Arguments
///
/// * `buffers` - 上一帧的各路 DMX 缓冲（将被就地修改）。
/// * `changes` - 变更列表。
pub fn apply_diff(buffers: &mut [Vec<u8>], changes: &[DiffChange]) {
    for c in changes {
        if let Some(buf) = buffers.get_mut(c.uni_idx as usize) {
            if let Some(slot) = buf.get_mut(c.ch_addr as usize) {
                *slot = c.ch_val;
            }
        }
    }
}
