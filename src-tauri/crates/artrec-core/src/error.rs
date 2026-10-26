//! ArtRec 编解码错误类型。

use thiserror::Error;

/// ArtRec 文件读写与校验过程中可能出现的错误。
#[derive(Debug, Error)]
pub enum ArtRecError {
    /// 底层 IO 错误。
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    /// 魔数不匹配，不是合法的 ArtRec 文件。
    #[error("魔数非法：期望 'ARTR'，实际 {0:02X?}")]
    BadMagic([u8; 4]),

    /// 字节序标记非法（既非 0xAA55 也非 0x55AA）。
    #[error("字节序标记非法: {0:#06X}")]
    BadEndianTag(u16),

    /// 文件主版本高于解析器支持的上限。
    #[error("不支持的主版本: {found}，解析器最高支持 {supported}")]
    UnsupportedVersion {
        /// 文件声明的主版本。
        found: u16,
        /// 解析器支持的最高主版本。
        supported: u16,
    },

    /// 压缩算法枚举未知。
    #[error("未知压缩算法: {0}")]
    UnknownCompressAlgo(u8),

    /// Chunk 的 CRC16 校验失败。
    #[error("Chunk CRC 校验失败：期望 {expected:#06X}，实际 {actual:#06X}")]
    CrcMismatch {
        /// Chunk 头声明的 CRC。
        expected: u16,
        /// 实际计算得到的 CRC。
        actual: u16,
    },

    /// 帧索引未按 time_us 升序排列，判定文件损坏。
    #[error("帧索引未按时间升序：索引 {0} 处发生逆序")]
    UnsortedIndex(usize),

    /// 文件出现差分帧但未置位 ALLOW_DIFF_FRAME，或解析器不支持差分帧。
    #[error("遇到差分帧但未启用 ALLOW_DIFF_FRAME 标志")]
    DiffFrameNotAllowed,

    /// 数据结构长度不足，无法解析。
    #[error("数据截断：{0}")]
    Truncated(&'static str),

    /// Payload 长度与 Universe 描述表声明的总长度不一致。
    #[error("Payload 长度不符：期望 {expected}，实际 {actual}")]
    PayloadLenMismatch {
        /// 按 UniDesc 累加得到的期望长度。
        expected: usize,
        /// 实际解压得到的长度。
        actual: usize,
    },

    /// Zstd 解压失败。
    #[error("Zstd 解压失败: {0}")]
    Decompress(String),

    /// Universe 编号超出规范可表示范围（`net` 仅 0~127，即 Universe ≤ 2047）。
    #[error("Universe {0} 超出 ArtRec 可表示范围（0~{max}）", max = crate::model::MAX_UNIVERSE)]
    UniverseOutOfRange(u16),

    /// 同一文件内出现重复的 Universe。
    #[error("Universe 描述表中存在重复的 Universe: {0}")]
    DuplicateUniverse(u16),

    /// 一帧全量 Payload 总长超过 u16 可表示上限，需要减少 Universe 数量或缩短 dmx_len。
    #[error("全量帧 Payload 共 {total} 字节，超过上限 {max} 字节（约 127 路 512 通道 Universe）")]
    PayloadTooLarge {
        /// 按 UniDesc 累加的全量帧总字节。
        total: usize,
        /// 允许的最大字节数。
        max: usize,
    },

    /// 单个 Chunk 的尺寸字段会溢出 u16（拒绝静默截断）。
    #[error("Chunk 尺寸 {size} 字节超过 u16 上限 {max}")]
    ChunkTooLarge {
        /// 实际尺寸。
        size: usize,
        /// 允许的最大尺寸。
        max: usize,
    },

    /// 文件超过 u32 偏移可寻址的 4 GiB 上限。
    #[error("文件超过 4 GiB 偏移上限，请分段录制")]
    FileTooLarge,

    /// 写入的帧时间戳早于上一帧，会破坏索引升序约束。
    #[error("帧时间戳逆序：上一帧 {prev} us，本帧 {now} us")]
    NonMonotonicTime {
        /// 上一帧时间戳。
        prev: u64,
        /// 本帧时间戳。
        now: u64,
    },

    /// 帧下标超出帧索引表范围。
    #[error("帧下标 {index} 越界：共 {count} 帧")]
    FrameOutOfRange {
        /// 请求的帧下标。
        index: usize,
        /// 帧索引表的条目数。
        count: usize,
    },

    /// 为共享索引的读取器提供的新数据源与原文件长度不一致（很可能不是同一份文件）。
    #[error("数据源长度不符：原文件 {expected} 字节，新数据源 {actual} 字节")]
    SourceLenMismatch {
        /// 原读取器打开时探测到的文件总字节数。
        expected: u64,
        /// 新数据源的总字节数。
        actual: u64,
    },
}

/// ArtRec 操作的便捷 `Result` 别名。
pub type Result<T> = std::result::Result<T, ArtRecError>;
