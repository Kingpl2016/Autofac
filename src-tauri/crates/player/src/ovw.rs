//! 时间线概览缓存文件（`名称.artrec.ovw`）的二进制编解码（纯函数，无 IO）。
//!
//! 概览以前以 JSON + Base64 内嵌在 sidecar 里，节目库每次列举都要读入并解析这几十 KB；
//! 现在单独存成紧凑的二进制文件，只在打开概览时读取。读写文件由 `recorder` 负责
//! （`recorder::read_overview_cache` / `recorder::write_overview_cache`），本模块只处理字节。
//!
//! # 格式（全部小端）
//!
//! | 偏移 | 类型 | 内容 |
//! |---|---|---|
//! | 0 | `[u8; 4]` | 魔数 `b"AROV"` |
//! | 4 | `u16` | 容器版本，当前为 [`OVW_CONTAINER_VERSION`] |
//! | 6 | `u16` | 保留，写 0，读取时忽略 |
//! | 8 | `u32` | 概览算法版本 [`OVERVIEW_VERSION`] |
//! | 12 | `u32` | 桶数 `B`（须在 `[MIN_BUCKETS, MAX_BUCKETS]` 内） |
//! | 16 | `u64` | `file_bytes` |
//! | 24 | `u64` | `frames` |
//! | 32 | `u64` | `skipped_frames` |
//! | 40 | `u64` | `duration_us` |
//! | 48 | `u16` | Universe 数 `N` |
//! | 50 | `N × u16` | Universe 编号 |
//! | … | `N × B` 字节 | `change` 矩阵（按行） |
//! | … | `N × B` 字节 | `level` 矩阵（按行） |
//! | 末尾 | `u16` | 之前全部字节的 CRC16-CCITT（[`artrec_core::crc16_ccitt`]） |
//!
//! 解码时魔数、容器版本、概览版本、桶数范围、总长度（必须**恰好**等于由 `N`、`B` 推出的长度）
//! 与校验值任何一项不符都返回 `None`，调用方据此重新扫描生成。

use artrec_core::crc16_ccitt;

use crate::overview::{Overview, MAX_BUCKETS, MIN_BUCKETS, OVERVIEW_VERSION};

/// 概览缓存文件魔数。
pub const OVW_MAGIC: [u8; 4] = *b"AROV";
/// 概览缓存容器版本；容器布局变化时递增（概览算法变化递增的是 [`OVERVIEW_VERSION`]）。
pub const OVW_CONTAINER_VERSION: u16 = 1;

/// 固定头长度（魔数到 Universe 数，含）。
const HEADER_LEN: usize = 50;
/// 末尾校验值长度。
const TRAILER_LEN: usize = 2;

/// 把概览编码为 `.artrec.ovw` 文件内容。
///
/// 输入应为 [`crate::build_overview`] / [`crate::build_overview_parallel`] 生成的自洽概览。
/// 防御性处理：Universe 超过 `u16::MAX` 个时只写前 `u16::MAX` 个；`change` / `level`
/// 缺行或行长不等于 `buckets` 时按 0 补齐或截断，保证输出始终是可解码的完整文件。
///
/// # Arguments
///
/// * `overview` - 待编码的概览。
///
/// # Returns
///
/// 完整文件字节（含末尾 CRC16）。
#[must_use]
pub fn encode_overview(overview: &Overview) -> Vec<u8> {
    let n = overview.universes.len().min(usize::from(u16::MAX));
    let nb = overview.buckets as usize;
    let mut out = Vec::with_capacity(HEADER_LEN + 2 * n + 2 * n * nb + TRAILER_LEN);
    out.extend_from_slice(&OVW_MAGIC);
    out.extend_from_slice(&OVW_CONTAINER_VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&overview.version.to_le_bytes());
    out.extend_from_slice(&overview.buckets.to_le_bytes());
    out.extend_from_slice(&overview.file_bytes.to_le_bytes());
    out.extend_from_slice(&overview.frames.to_le_bytes());
    out.extend_from_slice(&overview.skipped_frames.to_le_bytes());
    out.extend_from_slice(&overview.duration_us.to_le_bytes());
    // n 已钳制到 u16::MAX 以内，转换不会截断
    out.extend_from_slice(&(n as u16).to_le_bytes());
    for &u in &overview.universes[..n] {
        out.extend_from_slice(&u.to_le_bytes());
    }
    for matrix in [&overview.change, &overview.level] {
        for i in 0..n {
            let row = matrix.get(i).map_or(&[][..], Vec::as_slice);
            let take = row.len().min(nb);
            out.extend_from_slice(&row[..take]);
            out.resize(out.len() + (nb - take), 0);
        }
    }
    let crc = crc16_ccitt(&out);
    out.extend_from_slice(&crc.to_le_bytes());
    out
}

/// 从 `.artrec.ovw` 文件内容解码概览。
///
/// # Arguments
///
/// * `bytes` - 完整文件字节。
///
/// # Returns
///
/// 格式完全合法时返回 `Some(`[`Overview`]`)`（`version` 恒为 [`OVERVIEW_VERSION`]）；
/// 魔数、容器版本、概览版本、桶数范围、长度或校验值任一不符时返回 `None`。
/// 是否仍与当前节目文件匹配须由调用方再用 [`Overview::matches`] 与桶数判断。
#[must_use]
pub fn decode_overview(bytes: &[u8]) -> Option<Overview> {
    let (body, crc) = bytes.split_last_chunk::<TRAILER_LEN>()?;
    if crc16_ccitt(body) != u16::from_le_bytes(*crc) {
        return None;
    }
    let mut r = ByteReader(body);
    if r.array::<4>()? != OVW_MAGIC || r.u16()? != OVW_CONTAINER_VERSION {
        return None;
    }
    let _reserved = r.u16()?;
    if r.u32()? != OVERVIEW_VERSION {
        return None;
    }
    let buckets = r.u32()?;
    if !(MIN_BUCKETS..=MAX_BUCKETS).contains(&buckets) {
        return None;
    }
    let file_bytes = r.u64()?;
    let frames = r.u64()?;
    let skipped_frames = r.u64()?;
    let duration_us = r.u64()?;
    let n = usize::from(r.u16()?);
    let nb = buckets as usize;
    // 严格长度校验：剩余字节必须恰好是 Universe 表 + 两个矩阵
    let cells = n.checked_mul(nb)?;
    let expect = n.checked_mul(2)?.checked_add(cells.checked_mul(2)?)?;
    if r.0.len() != expect {
        return None;
    }
    let universes = r
        .take(2 * n)?
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    // nb ≥ MIN_BUCKETS > 0，`chunks_exact` 不会因块长为 0 而 panic
    let change = r
        .take(cells)?
        .chunks_exact(nb)
        .map(<[u8]>::to_vec)
        .collect();
    let level = r
        .take(cells)?
        .chunks_exact(nb)
        .map(<[u8]>::to_vec)
        .collect();
    Some(Overview {
        version: OVERVIEW_VERSION,
        duration_us,
        buckets,
        universes,
        change,
        level,
        frames,
        skipped_frames,
        file_bytes,
    })
}

/// 顺序读取小端字段的切片游标；越界时返回 `None`。
struct ByteReader<'a>(&'a [u8]);

impl<'a> ByteReader<'a> {
    /// 取出接下来的 `n` 个字节。
    ///
    /// # Arguments
    ///
    /// * `n` - 字节数。
    ///
    /// # Returns
    ///
    /// 剩余字节足够时返回这 `n` 个字节，否则返回 `None`。
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.0.split_at_checked(n)?;
        self.0 = rest;
        Some(head)
    }

    /// 取出接下来的 `N` 个字节组成的定长数组。
    ///
    /// # Returns
    ///
    /// 剩余字节足够时返回数组，否则返回 `None`。
    fn array<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.0.split_first_chunk::<N>()?;
        self.0 = rest;
        Some(*head)
    }

    /// 读取小端 `u16`。
    ///
    /// # Returns
    ///
    /// 剩余字节足够时返回值，否则返回 `None`。
    fn u16(&mut self) -> Option<u16> {
        self.array().map(u16::from_le_bytes)
    }

    /// 读取小端 `u32`。
    ///
    /// # Returns
    ///
    /// 剩余字节足够时返回值，否则返回 `None`。
    fn u32(&mut self) -> Option<u32> {
        self.array().map(u32::from_le_bytes)
    }

    /// 读取小端 `u64`。
    ///
    /// # Returns
    ///
    /// 剩余字节足够时返回值，否则返回 `None`。
    fn u64(&mut self) -> Option<u64> {
        self.array().map(u64::from_le_bytes)
    }
}

#[cfg(test)]
mod tests {
    use artrec_core::{crc16_ccitt, CompressAlgo};

    use super::{decode_overview, encode_overview, HEADER_LEN, OVW_CONTAINER_VERSION, TRAILER_LEN};
    use crate::overview::{build_overview, Overview, MAX_BUCKETS, MIN_BUCKETS, OVERVIEW_VERSION};
    use crate::walker::testkit::{build_full, open};

    /// 由真实节目生成的概览（2 路、16 桶）。
    fn built() -> Overview {
        let bytes = build_full(
            2,
            &[
                (0, vec![(0, 0, 200)]),
                (550_000, vec![(0, 0, 0), (1, 1, 100)]),
            ],
            1_000_000,
            CompressAlgo::Zstd,
        );
        build_overview(&open(bytes), MIN_BUCKETS)
    }

    /// 字段取极值的手工概览。
    fn handmade(n: usize, buckets: u32) -> Overview {
        let nb = buckets as usize;
        let row = |seed: usize| (0..nb).map(|b| ((b * 7 + seed * 13) % 256) as u8).collect();
        Overview {
            version: OVERVIEW_VERSION,
            duration_us: u64::MAX - 1,
            buckets,
            universes: (0..n).map(|i| (i * 97 % 2048) as u16).collect(),
            change: (0..n).map(row).collect(),
            level: (0..n).map(|i| row(i + 100)).collect(),
            frames: 123_456_789_012,
            skipped_frames: 42,
            file_bytes: u64::from(u32::MAX) + 5,
        }
    }

    /// 改动正文后重新计算末尾 CRC，用来构造"校验正确但内容不合法"的文件。
    fn reseal(mut bytes: Vec<u8>) -> Vec<u8> {
        bytes.truncate(bytes.len() - TRAILER_LEN);
        let crc = crc16_ccitt(&bytes);
        bytes.extend_from_slice(&crc.to_le_bytes());
        bytes
    }

    #[test]
    fn roundtrip_preserves_every_field() {
        for o in [
            built(),
            handmade(3, 100),
            handmade(0, MIN_BUCKETS),
            handmade(1, MAX_BUCKETS),
        ] {
            let bytes = encode_overview(&o);
            let n = o.universes.len();
            let nb = o.buckets as usize;
            assert_eq!(bytes.len(), HEADER_LEN + 2 * n + 2 * n * nb + TRAILER_LEN);
            assert_eq!(&bytes[..4], b"AROV");
            assert_eq!(decode_overview(&bytes), Some(o));
        }
    }

    #[test]
    fn truncated_or_extended_files_are_rejected() {
        let bytes = encode_overview(&built());
        for len in 0..bytes.len() {
            assert_eq!(decode_overview(&bytes[..len]), None, "截断到 {len} 字节");
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert_eq!(decode_overview(&longer), None, "尾部多出字节");
        // 即使重新计算校验值，长度与 N / B 不符也必须拒绝
        let mut padded = bytes[..bytes.len() - TRAILER_LEN].to_vec();
        padded.extend_from_slice(&[0, 0, 0]);
        assert_eq!(decode_overview(&reseal(padded)), None);
    }

    #[test]
    fn any_single_byte_tamper_is_rejected() {
        let bytes = encode_overview(&built());
        for i in 0..bytes.len() {
            let mut bad = bytes.clone();
            bad[i] ^= 0xA5;
            assert_eq!(decode_overview(&bad), None, "篡改第 {i} 字节");
        }
    }

    #[test]
    fn version_magic_and_bucket_mismatches_are_rejected_even_with_valid_crc() {
        let good = encode_overview(&built());
        let patch = |at: usize, with: &[u8]| {
            let mut b = good.clone();
            b[at..at + with.len()].copy_from_slice(with);
            reseal(b)
        };
        assert!(decode_overview(&patch(0, b"AROW")).is_none(), "魔数");
        let next_container = OVW_CONTAINER_VERSION + 1;
        assert!(
            decode_overview(&patch(4, &next_container.to_le_bytes())).is_none(),
            "容器版本"
        );
        let next_algo = OVERVIEW_VERSION + 1;
        assert!(
            decode_overview(&patch(8, &next_algo.to_le_bytes())).is_none(),
            "概览版本"
        );
        // 保留字段不参与判定
        assert_eq!(
            decode_overview(&patch(6, &7u16.to_le_bytes())),
            Some(built())
        );

        // 桶数越界（长度与校验都自洽）
        let small = handmade(1, MIN_BUCKETS / 2);
        assert!(
            decode_overview(&encode_overview(&small)).is_none(),
            "桶数低于下限"
        );
        let big = handmade(1, MAX_BUCKETS + 1);
        assert!(
            decode_overview(&encode_overview(&big)).is_none(),
            "桶数高于上限"
        );
        // 编码时版本不是当前版本：解码拒绝
        let mut old = built();
        old.version = OVERVIEW_VERSION + 1;
        assert!(decode_overview(&encode_overview(&old)).is_none());
    }

    #[test]
    fn inconsistent_rows_are_normalized_to_a_decodable_file() {
        let mut o = handmade(2, MIN_BUCKETS);
        o.change[0].truncate(3);
        o.level.pop();
        o.change[1].extend_from_slice(&[9; 5]);
        let back = decode_overview(&encode_overview(&o)).expect("输出应始终可解码");
        let nb = MIN_BUCKETS as usize;
        assert!(back.change.iter().chain(&back.level).all(|r| r.len() == nb));
        assert_eq!(&back.change[0][..3], &o.change[0][..3]);
        assert!(back.change[0][3..].iter().all(|&v| v == 0), "缺的部分补 0");
        assert!(back.level[1].iter().all(|&v| v == 0), "缺的行补 0");
        assert_eq!(back.change[1], o.change[1][..nb].to_vec(), "多出的部分截断");
    }
}
