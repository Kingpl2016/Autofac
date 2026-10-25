//! Payload 压缩/解压封装（支持无压缩与 Zstd）。

use crate::error::{ArtRecError, Result};
use crate::model::CompressAlgo;

/// 按指定算法压缩 Payload。
///
/// # Arguments
///
/// * `algo` - 压缩算法。
/// * `level` - Zstd 压缩等级（1~22）；无压缩时忽略。
/// * `raw` - 原始 Payload。
///
/// # Returns
///
/// 压缩后的字节；无压缩时为输入的拷贝。
///
/// # Errors
///
/// Zstd 压缩失败时返回 [`ArtRecError::Io`]。
pub fn compress(algo: CompressAlgo, level: u8, raw: &[u8]) -> Result<Vec<u8>> {
    match algo {
        CompressAlgo::None => Ok(raw.to_vec()),
        CompressAlgo::Zstd => {
            zstd::encode_all(raw, i32::from(level)).map_err(ArtRecError::Io)
        }
    }
}

/// 按指定算法解压 Payload。
///
/// # Arguments
///
/// * `algo` - 压缩算法。
/// * `data` - 压缩后的 Payload。
/// * `raw_sz` - 解压后期望的原始字节数（用于预分配）。
///
/// # Returns
///
/// 解压后的原始 Payload。
///
/// # Errors
///
/// Zstd 解码失败返回 [`ArtRecError::Decompress`]。
pub fn decompress(algo: CompressAlgo, data: &[u8], raw_sz: usize) -> Result<Vec<u8>> {
    match algo {
        CompressAlgo::None => Ok(data.to_vec()),
        CompressAlgo::Zstd => {
            let mut out = Vec::with_capacity(raw_sz);
            zstd::stream::copy_decode(data, &mut out)
                .map_err(|e| ArtRecError::Decompress(e.to_string()))?;
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{compress, decompress};
    use crate::model::CompressAlgo;

    #[test]
    fn zstd_roundtrip() {
        let raw = vec![7u8; 1024];
        let packed = compress(CompressAlgo::Zstd, 3, &raw).unwrap();
        assert!(packed.len() < raw.len());
        let back = decompress(CompressAlgo::Zstd, &packed, raw.len()).unwrap();
        assert_eq!(back, raw);
    }

    #[test]
    fn none_roundtrip() {
        let raw = b"hello".to_vec();
        let packed = compress(CompressAlgo::None, 0, &raw).unwrap();
        assert_eq!(packed, raw);
        let back = decompress(CompressAlgo::None, &packed, raw.len()).unwrap();
        assert_eq!(back, raw);
    }
}
