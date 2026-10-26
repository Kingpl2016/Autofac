//! Payload 压缩/解压封装（支持无压缩与 Zstd）。
//!
//! # 与嵌入式回放端的兼容约定
//!
//! 每个 Chunk 的 Payload 是一个**独立的标准 Zstd 帧**：不写原始大小字段
//! （`ContentSizeFlag = false`，与历史上 `zstd::encode_all` 的产物一致）、不开校验和、
//! 不用字典。写入端复用压缩上下文（[`ZstdCompressor`]）只是省掉每帧的上下文创建，
//! 不改变帧格式；已知输入长度时 zstd 会把窗口缩到能容纳本帧的最小值
//! （帧头 `Window_Descriptor` 变小），这只会降低解码端的内存需求。

use zstd::bulk::{Compressor, Decompressor};
use zstd::zstd_safe::{compress_bound, CParameter};

use crate::error::{ArtRecError, Result};
use crate::model::CompressAlgo;

/// 可复用的 Zstd 压缩上下文（crate 内部使用）。
///
/// 构造时固定压缩等级并关闭原始大小字段与校验和，保证产物与规范约定的帧格式一致。
pub(crate) struct ZstdCompressor {
    /// 底层 bulk 压缩器（持有 `ZSTD_CCtx`，跨帧复用）。
    inner: Compressor<'static>,
}

impl ZstdCompressor {
    /// 创建压缩上下文。
    ///
    /// # Arguments
    ///
    /// * `level` - Zstd 压缩等级（1~22；`0` 为 zstd 默认等级，与 `zstd::encode_all` 语义一致）。
    ///
    /// # Returns
    ///
    /// 已设置等级、`ContentSizeFlag = false`、`ChecksumFlag = false` 的压缩器。
    ///
    /// # Errors
    ///
    /// 上下文创建或参数设置失败时返回 [`ArtRecError::Io`]。
    pub(crate) fn new(level: u8) -> Result<Self> {
        let mut inner = Compressor::new(i32::from(level))?;
        // 不在帧头写原始大小：与旧版 `encode_all`（流式、长度未知）产物保持一致
        inner.set_parameter(CParameter::ContentSizeFlag(false))?;
        // 校验和默认即关闭，这里显式声明以免依赖库默认值
        inner.set_parameter(CParameter::ChecksumFlag(false))?;
        Ok(Self { inner })
    }

    /// 把 `raw` 压缩为一个独立 Zstd 帧，写入 `out`（覆盖其原有内容）。
    ///
    /// # Arguments
    ///
    /// * `raw` - 原始 Payload。
    /// * `out` - 输出缓冲；先清空，再按 `compress_bound` 预留容量，可跨帧复用以免重复分配。
    ///
    /// # Errors
    ///
    /// Zstd 压缩失败时返回 [`ArtRecError::Io`]。
    pub(crate) fn compress_into(&mut self, raw: &[u8], out: &mut Vec<u8>) -> Result<()> {
        out.clear();
        out.reserve(compress_bound(raw.len()));
        self.inner.compress_to_buffer(raw, out)?;
        Ok(())
    }
}

/// 按指定算法压缩 Payload。
///
/// Zstd 时内部使用一次性压缩上下文（同样不写原始大小字段）；需要连续压缩多帧时，
/// 写入器内部会复用上下文，比反复调用本函数更快。
///
/// # Arguments
///
/// * `algo` - 压缩算法。
/// * `level` - Zstd 压缩等级（1~22）；无压缩时忽略。
/// * `raw` - 原始 Payload。
///
/// # Returns
///
/// 压缩后的字节（一个独立的标准 Zstd 帧）；无压缩时为输入的拷贝。
///
/// # Errors
///
/// Zstd 压缩失败时返回 [`ArtRecError::Io`]。
pub fn compress(algo: CompressAlgo, level: u8, raw: &[u8]) -> Result<Vec<u8>> {
    match algo {
        CompressAlgo::None => Ok(raw.to_vec()),
        CompressAlgo::Zstd => {
            let mut out = Vec::new();
            ZstdCompressor::new(level)?.compress_into(raw, &mut out)?;
            Ok(out)
        }
    }
}

/// 用可复用的解压上下文把一个 Chunk 的 Zstd Payload 解压进 `out`（crate 内部使用）。
///
/// # Arguments
///
/// * `dctx` - 解压上下文（跨帧复用）。
/// * `data` - 压缩后的 Payload。
/// * `raw_sz` - ChunkHdr 声明的原始字节数；解压结果必须恰好为该长度。
/// * `out` - 输出缓冲；先清空，再保证容量不小于 `raw_sz`。
///
/// # Errors
///
/// Zstd 解码失败、输出超出容量或长度不等于 `raw_sz` 时返回 [`ArtRecError::Decompress`]。
pub(crate) fn decompress_into(
    dctx: &mut Decompressor<'static>,
    data: &[u8],
    raw_sz: usize,
    out: &mut Vec<u8>,
) -> Result<()> {
    out.clear();
    out.reserve(raw_sz);
    let n = dctx
        .decompress_to_buffer(data, out)
        .map_err(|e| ArtRecError::Decompress(e.to_string()))?;
    if n != raw_sz {
        return Err(ArtRecError::Decompress(format!(
            "解压得到 {n} 字节，与 ChunkHdr 声明的 payload_raw_sz={raw_sz} 不符"
        )));
    }
    Ok(())
}

/// 按指定算法解压 Payload。
///
/// 保留历史语义：`raw_sz` 只用于预分配，不强制校验输出长度；读取器内部使用
/// 可复用上下文并严格校验长度（见 [`crate::ArtRecReader::read_chunk_into`]）。
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
    use zstd::bulk::Decompressor;

    use super::{compress, decompress, decompress_into, ZstdCompressor};
    use crate::error::ArtRecError;
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

    #[test]
    fn reused_compressor_matches_one_shot_and_decodes() {
        // 复用上下文连续压缩不同长度的输入：每帧都与一次性压缩逐字节相同，且可被流式解码
        let mut c = ZstdCompressor::new(3).unwrap();
        let mut out = Vec::new();
        for len in [0usize, 1, 2, 7, 512, 4096, 32_768, 65_024, 100] {
            let raw: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
            c.compress_into(&raw, &mut out).unwrap();
            assert_eq!(
                out,
                compress(CompressAlgo::Zstd, 3, &raw).unwrap(),
                "len={len}"
            );
            assert_eq!(
                zstd::stream::decode_all(&out[..]).unwrap(),
                raw,
                "len={len}"
            );
        }
    }

    #[test]
    fn decompress_into_enforces_raw_size() {
        let raw = vec![9u8; 2048];
        let packed = compress(CompressAlgo::Zstd, 3, &raw).unwrap();
        let mut d = Decompressor::new().unwrap();
        let mut out = Vec::new();
        decompress_into(&mut d, &packed, raw.len(), &mut out).unwrap();
        assert_eq!(out, raw);
        // 复用后再次解压：先清空，不残留上一帧数据
        decompress_into(&mut d, &packed, raw.len(), &mut out).unwrap();
        assert_eq!(out, raw);
        // 声明长度偏小：输出放不下 → 解压失败
        assert!(matches!(
            decompress_into(&mut d, &packed, raw.len() - 1, &mut Vec::new()),
            Err(ArtRecError::Decompress(_))
        ));
        // 声明长度偏大（容量足够但长度不符）→ 同样按解压失败处理
        assert!(matches!(
            decompress_into(&mut d, &packed, raw.len() + 1, &mut out),
            Err(ArtRecError::Decompress(_))
        ));
        // 非法数据
        assert!(matches!(
            decompress_into(&mut d, b"not a zstd frame", 16, &mut out),
            Err(ArtRecError::Decompress(_))
        ));
    }
}
