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
    let mut out = Vec::new();
    assemble_full_into(unis, buffers, &mut out)?;
    Ok(out)
}

/// 与 [`assemble_full`] 相同，但写入调用方复用的缓冲（crate 内部使用）。
///
/// # Arguments
///
/// * `unis` - Universe 描述表（决定拼接顺序与各段长度）。
/// * `buffers` - 与 `unis` 等长、一一对应的各路 DMX 数据。
/// * `out` - 输出缓冲；先清空再写入，容量跨帧复用。
///
/// # Errors
///
/// `buffers` 数量或某段长度与 `unis` 声明不符时返回 [`ArtRecError::PayloadLenMismatch`]。
pub(crate) fn assemble_full_into(
    unis: &[UniDesc],
    buffers: &[Vec<u8>],
    out: &mut Vec<u8>,
) -> Result<()> {
    if buffers.len() != unis.len() {
        return Err(ArtRecError::PayloadLenMismatch {
            expected: unis.len(),
            actual: buffers.len(),
        });
    }
    let total: usize = unis.iter().map(|u| usize::from(u.dmx_len)).sum();
    out.clear();
    out.reserve(total);
    for (u, buf) in unis.iter().zip(buffers) {
        if buf.len() != usize::from(u.dmx_len) {
            return Err(ArtRecError::PayloadLenMismatch {
                expected: usize::from(u.dmx_len),
                actual: buf.len(),
            });
        }
        out.extend_from_slice(buf);
    }
    Ok(())
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

/// 把全量帧原始 Payload 按 UniDesc 顺序原地拆分进已有的各路缓冲（crate 内部使用）。
///
/// 结果与 [`split_full`] 相同；区别是尽量复用 `buffers`：长度相符的路直接
/// `copy_from_slice`，只有路数或某路长度不同才调整对应缓冲，避免每帧重新分配。
///
/// # Arguments
///
/// * `unis` - Universe 描述表。
/// * `payload` - 解压后的全量帧原始 Payload。
/// * `buffers` - 各路 DMX 缓冲；成功时被整体覆盖为本帧数据，失败时保持不变。
///
/// # Errors
///
/// Payload 总长与 UniDesc 累加长度不符返回 [`ArtRecError::PayloadLenMismatch`]。
pub(crate) fn split_full_into(
    unis: &[UniDesc],
    payload: &[u8],
    buffers: &mut Vec<Vec<u8>>,
) -> Result<()> {
    let total: usize = unis.iter().map(|u| usize::from(u.dmx_len)).sum();
    if payload.len() != total {
        return Err(ArtRecError::PayloadLenMismatch {
            expected: total,
            actual: payload.len(),
        });
    }
    // 路数不同才调整外层 Vec（多余的截掉，缺的补空缓冲，下面按长度填充）
    if buffers.len() != unis.len() {
        buffers.resize_with(unis.len(), Vec::new);
    }
    let mut rest = payload;
    for (u, buf) in unis.iter().zip(buffers.iter_mut()) {
        let (seg, tail) = rest.split_at(usize::from(u.dmx_len));
        if buf.len() == seg.len() {
            buf.copy_from_slice(seg);
        } else {
            buf.clear();
            buf.extend_from_slice(seg);
        }
        rest = tail;
    }
    Ok(())
}

/// 校验并把差分帧 Payload 直接应用到各路缓冲（crate 内部使用，不分配变更列表）。
///
/// 与 `apply_diff(buffers, &decode_diff(payload)?)` 完全等价：先整体校验长度，
/// 校验失败时不修改任何缓冲；越界的 `uni_idx` / `ch_addr` 被忽略。
///
/// # Arguments
///
/// * `buffers` - 上一帧的各路 DMX 缓冲（将被就地修改）。
/// * `payload` - 差分帧原始 Payload。
///
/// # Errors
///
/// 长度不足以容纳声明的变更条数时返回 [`ArtRecError::Truncated`]。
pub(crate) fn apply_diff_payload(buffers: &mut [Vec<u8>], payload: &[u8]) -> Result<()> {
    if payload.len() < 2 {
        return Err(ArtRecError::Truncated("差分帧缺少 changed_cnt"));
    }
    let cnt = usize::from(BigEndian::read_u16(&payload[0..2]));
    let Some(records) = payload.get(2..2 + cnt * 5) else {
        return Err(ArtRecError::Truncated("差分帧变更点截断"));
    };
    // records 恰为 cnt × 5 字节，余数必为空
    let (recs, _) = records.as_chunks::<5>();
    for rec in recs {
        let uni_idx = usize::from(BigEndian::read_u16(&rec[0..2]));
        let ch_addr = usize::from(BigEndian::read_u16(&rec[2..4]));
        if let Some(slot) = buffers.get_mut(uni_idx).and_then(|b| b.get_mut(ch_addr)) {
            *slot = rec[4];
        }
    }
    Ok(())
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
    let mut out = Vec::new();
    encode_diff_into(changes, &mut out);
    out
}

/// 与 [`encode_diff`] 相同，但写入调用方复用的缓冲（crate 内部使用）。
///
/// # Arguments
///
/// * `changes` - 变更点列表。
/// * `out` - 输出缓冲；先清空再写入，容量跨帧复用。
pub(crate) fn encode_diff_into(changes: &[DiffChange], out: &mut Vec<u8>) {
    out.clear();
    out.reserve(2 + changes.len() * 5);
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

#[cfg(test)]
mod tests {
    use super::{
        apply_diff, apply_diff_payload, assemble_full, decode_diff, encode_diff, split_full,
        split_full_into, DiffChange,
    };
    use crate::error::ArtRecError;
    use crate::model::UniDesc;

    fn unis() -> Vec<UniDesc> {
        vec![
            UniDesc::new(0, 0, 512),
            UniDesc::new(0, 1, 24),
            UniDesc::new(0, 2, 512),
        ]
    }

    fn frame(fill: u8) -> Vec<Vec<u8>> {
        unis()
            .iter()
            .enumerate()
            .map(|(i, u)| {
                (0..usize::from(u.dmx_len))
                    .map(|c| fill.wrapping_add((c * 7 + i) as u8))
                    .collect()
            })
            .collect()
    }

    #[test]
    fn split_full_into_matches_split_full_for_any_initial_shape() {
        let u = unis();
        let payload = assemble_full(&u, &frame(3)).unwrap();
        let want = split_full(&u, &payload).unwrap();
        let shapes: Vec<Vec<Vec<u8>>> = vec![
            frame(0),                                             // 形状一致：原地拷贝
            Vec::new(),                                           // 路数为 0
            vec![vec![1u8; 512]],                                 // 路数偏少
            vec![vec![0u8; 3]; 5],                                // 路数偏多且长度不符
            vec![vec![0u8; 512], vec![0u8; 512], vec![0u8; 512]], // 某路长度不符
        ];
        for mut b in shapes {
            split_full_into(&u, &payload, &mut b).unwrap();
            assert_eq!(b, want);
        }
    }

    #[test]
    fn split_full_into_rejects_bad_length_without_touching_buffers() {
        let u = unis();
        let mut b = frame(9);
        let before = b.clone();
        let err = split_full_into(&u, &[0u8; 10], &mut b).unwrap_err();
        assert!(matches!(
            err,
            ArtRecError::PayloadLenMismatch {
                expected: 1048,
                actual: 10
            }
        ));
        assert_eq!(b, before);
    }

    #[test]
    fn apply_diff_payload_matches_decode_then_apply() {
        let changes = vec![
            DiffChange {
                uni_idx: 0,
                ch_addr: 5,
                ch_val: 99,
            },
            DiffChange {
                uni_idx: 1,
                ch_addr: 23,
                ch_val: 1,
            },
            DiffChange {
                uni_idx: 1,
                ch_addr: 24,
                ch_val: 2,
            }, // 通道越界：忽略
            DiffChange {
                uni_idx: 7,
                ch_addr: 0,
                ch_val: 3,
            }, // Universe 越界：忽略
            DiffChange {
                uni_idx: 2,
                ch_addr: 511,
                ch_val: 255,
            },
        ];
        let payload = encode_diff(&changes);
        let mut want = frame(1);
        apply_diff(&mut want, &decode_diff(&payload).unwrap());
        let mut got = frame(1);
        apply_diff_payload(&mut got, &payload).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn apply_diff_payload_rejects_truncation_without_touching_buffers() {
        let payload = encode_diff(
            &[DiffChange {
                uni_idx: 0,
                ch_addr: 0,
                ch_val: 1,
            }; 3],
        );
        let mut b = frame(0);
        let before = b.clone();
        for cut in [0usize, 1, 2, 6, payload.len() - 1] {
            assert!(matches!(
                apply_diff_payload(&mut b, &payload[..cut]),
                Err(ArtRecError::Truncated(_))
            ));
            assert!(decode_diff(&payload[..cut]).is_err());
        }
        assert_eq!(b, before);
    }
}
