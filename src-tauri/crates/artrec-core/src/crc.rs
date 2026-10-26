//! CRC16-CCITT（多项式 0x1021，初始值 0xFFFF，输入输出不反转，无异或输出）。
//!
//! 使用 `crc` crate 的 16 表并行查表实现（`Table<16>`，slice-by-16），与单表实现是
//! 同一算法、结果逐位相同，只是每轮处理 16 字节，吞吐高数倍。查表数据在编译期生成，
//! 放在 `static` 中（16 × 256 × 2 = 8 KiB），不随调用复制。

use crc::{Crc, Table, CRC_16_IBM_3740};

/// CRC-16/CCITT-FALSE 算法实例（poly=0x1021, init=0xFFFF, refin=false, refout=false, xorout=0x0000）。
static CRC16: Crc<u16, Table<16>> = Crc::<u16, Table<16>>::new(&CRC_16_IBM_3740);

/// 计算一段数据的 CRC16-CCITT 校验值。
///
/// # Arguments
///
/// * `data` - 待校验的字节切片（ArtRec 中仅校验 Chunk 的 Payload 区域）。
///
/// # Returns
///
/// 16 位校验值。
#[must_use]
pub fn crc16_ccitt(data: &[u8]) -> u16 {
    CRC16.checksum(data)
}

#[cfg(test)]
mod tests {
    use crc::{Crc, NoTable, CRC_16_IBM_3740};

    use super::crc16_ccitt;

    /// 单表（逐字节查表）参考实现：改动前生产代码所用的实现。
    const SINGLE_TABLE: Crc<u16> = Crc::<u16>::new(&CRC_16_IBM_3740);
    /// 无表（逐位）参考实现，作为第二个独立参照。
    const BITWISE: Crc<u16, NoTable> = Crc::<u16, NoTable>::new(&CRC_16_IBM_3740);

    /// 确定性 xorshift64 伪随机字节。
    fn random_bytes(len: usize, seed: u64) -> Vec<u8> {
        let mut s = seed;
        (0..len)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                (s >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn check_value_matches_ccitt_false() {
        // CRC-16/CCITT-FALSE（IBM-3740）对 "123456789" 的标准校验值为 0x29B1。
        assert_eq!(crc16_ccitt(b"123456789"), 0x29B1);
        assert_eq!(SINGLE_TABLE.checksum(b"123456789"), 0x29B1);
        assert_eq!(BITWISE.checksum(b"123456789"), 0x29B1);
    }

    #[test]
    fn empty_input_is_init_value() {
        // 空输入应返回初始值 0xFFFF。
        assert_eq!(crc16_ccitt(b""), 0xFFFF);
    }

    #[test]
    fn slice16_matches_single_table_on_random_buffers() {
        // 覆盖 16 字节分组边界附近的所有长度、非对齐起点，以及 Chunk 实际尺寸
        let big = random_bytes(65_536 + 64, 0x9E37_79B9_7F4A_7C15);
        for len in (0..=257).chain([511, 512, 513, 32_768, 65_024, 65_527, 65_536]) {
            for start in [0usize, 1, 3, 15] {
                let data = &big[start..start + len];
                let want = SINGLE_TABLE.checksum(data);
                assert_eq!(crc16_ccitt(data), want, "len={len} start={start}");
                if len <= 4096 {
                    assert_eq!(BITWISE.checksum(data), want, "len={len} start={start}");
                }
            }
        }
        for seed in 1..=32u64 {
            let data = random_bytes(1000 + seed as usize * 37, seed);
            assert_eq!(
                crc16_ccitt(&data),
                SINGLE_TABLE.checksum(&data),
                "seed={seed}"
            );
        }
    }
}
