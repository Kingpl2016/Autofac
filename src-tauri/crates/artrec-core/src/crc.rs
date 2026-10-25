//! CRC16-CCITT（多项式 0x1021，初始值 0xFFFF，输入输出不反转，无异或输出）。

use crc::{Crc, CRC_16_IBM_3740};

/// CRC-16/CCITT-FALSE 算法实例（poly=0x1021, init=0xFFFF, refin=false, refout=false, xorout=0x0000）。
const CRC16: Crc<u16> = Crc::<u16>::new(&CRC_16_IBM_3740);

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
    use super::crc16_ccitt;

    #[test]
    fn check_value_matches_ccitt_false() {
        // CRC-16/CCITT-FALSE 对 "123456789" 的标准校验值为 0x29B1。
        assert_eq!(crc16_ccitt(b"123456789"), 0x29B1);
    }

    #[test]
    fn empty_input_is_init_value() {
        // 空输入应返回初始值 0xFFFF。
        assert_eq!(crc16_ccitt(b""), 0xFFFF);
    }
}
