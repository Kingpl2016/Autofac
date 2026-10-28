//! ArtRec 文件各区二进制结构定义与（反）序列化。
//!
//! 所有多字节整数默认以大端（网络字节序）写入；读取时依 `endian_tag` 字段
//! 自动判定字节序。结构体尺寸与偏移严格对齐《ArtRec 灯光节目录制文件规范 v1.0》。



use crate::error::{ArtRecError, Result};

/// 文件魔数 `'A','R','T','R'`。
pub const MAGIC: [u8; 4] = *b"ARTR";
/// 大端字节序标记。
pub const ENDIAN_TAG_BE: u16 = 0xAA55;
/// 小端字节序标记（文件以小端存储时读到）。
pub const ENDIAN_TAG_LE: u16 = 0x55AA;

/// 全局文件头固定字节数。
///
/// 规范正文与 §13 示例均以 64 字节为准（`universe_desc_offset = 64`）。
/// 注意：规范 §3/§12 的 C 结构体含 `reserved[34]`，`pack(1)` 实际为 88 字节，
/// 与正文矛盾；本实现采用 64 字节头，读取端完全按偏移字段定位，兼容两者。
pub const HEADER_SIZE: u32 = 64;
/// 单条 Universe 描述字节数。
pub const UNIDESC_SIZE: u32 = 16;
/// 单条帧索引字节数。
pub const FRAMEINDEX_SIZE: u32 = 16;
/// Chunk 头字节数。
pub const CHUNKHDR_SIZE: usize = 8;

/// `UniDesc.net` 的最大取值（规范 §4：0~127）。
pub const MAX_NET: u16 = 127;
/// 按规范 `universe = net*16 + subuni`（subuni 0~15）可表示的最大 Universe 编号。
pub const MAX_UNIVERSE: u16 = MAX_NET * 16 + 15;
/// 单个 Chunk（ChunkHdr + Payload）允许的最大字节数（`chunk_cmp_len` 为 u16）。
pub const MAX_CHUNK_BYTES: usize = u16::MAX as usize;
/// 单帧全量 Payload（解压后）允许的最大字节数，需为 ChunkHdr 留出余量，
/// 保证即便"无压缩"模式 `8 + payload` 也不溢出 u16。
pub const MAX_FULL_PAYLOAD: usize = MAX_CHUNK_BYTES - CHUNKHDR_SIZE;

/// 当前写入的主版本。
pub const VER_MAJOR: u16 = 1;
/// 当前写入的次版本。
pub const VER_MINOR: u16 = 0;
/// 解析器支持的最高主版本。
pub const SUPPORTED_MAJOR: u16 = 1;

/// flags：推荐循环播放。
pub const FLAG_LOOP: u32 = 1 << 0;
/// flags：附带 SMPTE 时间码扩展块。
pub const FLAG_SMPTE: u32 = 1 << 1;
/// flags：允许出现差分帧（chunk_type=1）。
pub const FLAG_DIFF_FRAME: u32 = 1 << 2;

/// Chunk 类型：全量帧。
pub const CHUNK_FULL: u16 = 0;
/// Chunk 类型：差分增量帧。
pub const CHUNK_DIFF: u16 = 1;

/// 压缩算法枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CompressAlgo {
    /// 无压缩，Payload 为原始二进制。
    None = 0,
    /// Zstd 压缩。
    Zstd = 1,
}

impl CompressAlgo {
    /// 由枚举值还原压缩算法。
    ///
    /// # Arguments
    ///
    /// * `v` - 文件头 `compress_algo` 字段值。
    ///
    /// # Errors
    ///
    /// 未知取值返回 [`ArtRecError::UnknownCompressAlgo`]。
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Self::None),
            1 => Ok(Self::Zstd),
            other => Err(ArtRecError::UnknownCompressAlgo(other)),
        }
    }
}

/// 字节序选择（由 `endian_tag` 决定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Endian {
    Big,
    Little,
}

impl Endian {
    fn read_u16(self, b: &[u8]) -> u16 {
        let v = [b[0], b[1]];
        match self {
            Endian::Big => u16::from_be_bytes(v),
            Endian::Little => u16::from_le_bytes(v),
        }
    }
    fn read_u32(self, b: &[u8]) -> u32 {
        let v = [b[0], b[1], b[2], b[3]];
        match self {
            Endian::Big => u32::from_be_bytes(v),
            Endian::Little => u32::from_le_bytes(v),
        }
    }
    fn read_u64(self, b: &[u8]) -> u64 {
        let v = [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]];
        match self {
            Endian::Big => u64::from_be_bytes(v),
            Endian::Little => u64::from_le_bytes(v),
        }
    }
}

/// A 区：全局文件头。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileHeader {
    /// 全局标志位。
    pub flags: u32,
    /// 录制开始 Unix 时间戳（微秒），仅用于日志。
    pub rec_start_us: u64,
    /// 节目总时长（相对起始，微秒）。
    pub total_duration_us: u64,
    /// Universe 描述条目数量。
    pub universe_count: u32,
    /// 索引帧总条数。
    pub frame_count: u32,
    /// B 区 Universe 描述表起始偏移。
    pub universe_desc_offset: u32,
    /// C 区帧索引表起始偏移。
    pub frame_index_offset: u32,
    /// D 区 Chunk 块池起始偏移。
    pub chunk_pool_offset: u32,
    /// 压缩算法。
    pub compress_algo: CompressAlgo,
    /// Zstd 压缩等级（无压缩模式忽略）。
    pub compress_level: u8,
    /// 主版本。
    pub ver_major: u16,
    /// 次版本。
    pub ver_minor: u16,
}

impl FileHeader {
    /// 以大端序列化为固定 64 字节头。
    ///
    /// # Returns
    ///
    /// 固定 [`HEADER_SIZE`] 字节、`magic`/`endian_tag`/版本等字段已填好的缓冲。
    #[must_use]
    pub fn to_bytes(&self) -> [u8; HEADER_SIZE as usize] {
        let mut b = [0u8; HEADER_SIZE as usize];
        b[0..4].copy_from_slice(&MAGIC);
        b[4..6].copy_from_slice(&ENDIAN_TAG_BE.to_be_bytes());
        b[6..8].copy_from_slice(&self.ver_major.to_be_bytes());
        b[8..10].copy_from_slice(&self.ver_minor.to_be_bytes());
        b[10..14].copy_from_slice(&self.flags.to_be_bytes());
        b[14..22].copy_from_slice(&self.rec_start_us.to_be_bytes());
        b[22..30].copy_from_slice(&self.total_duration_us.to_be_bytes());
        b[30..34].copy_from_slice(&self.universe_count.to_be_bytes());
        b[34..38].copy_from_slice(&self.frame_count.to_be_bytes());
        b[38..42].copy_from_slice(&self.universe_desc_offset.to_be_bytes());
        b[42..46].copy_from_slice(&self.frame_index_offset.to_be_bytes());
        b[46..50].copy_from_slice(&self.chunk_pool_offset.to_be_bytes());
        b[50] = self.compress_algo as u8;
        b[51] = self.compress_level;
        // b[52..54] reserved0, b[54..64] reserved 均保持 0
        b
    }

    /// 从字节缓冲解析文件头，自动判定字节序并做合法性校验。
    ///
    /// # Arguments
    ///
    /// * `b` - 至少包含前 54 字节头字段的缓冲。
    ///
    /// # Returns
    ///
    /// 解析出的 [`FileHeader`]（各偏移字段原样保留，供定位其余分区）。
    ///
    /// # Errors
    ///
    /// - 魔数非法返回 [`ArtRecError::BadMagic`]。
    /// - 字节序标记非法返回 [`ArtRecError::BadEndianTag`]。
    /// - 主版本过高返回 [`ArtRecError::UnsupportedVersion`]。
    /// - 压缩算法未知返回 [`ArtRecError::UnknownCompressAlgo`]。
    /// - 缓冲过短返回 [`ArtRecError::Truncated`]。
    pub fn from_bytes(b: &[u8]) -> Result<Self> {
        if b.len() < 52 {
            return Err(ArtRecError::Truncated("文件头不足 52 字节"));
        }
        let mut magic = [0u8; 4];
        magic.copy_from_slice(&b[0..4]);
        if magic != MAGIC {
            return Err(ArtRecError::BadMagic(magic));
        }
        // endian_tag 以大端读取其原始两字节判定
        let tag_be = u16::from_be_bytes([b[4], b[5]]);
        let endian = match tag_be {
            ENDIAN_TAG_BE => Endian::Big,
            ENDIAN_TAG_LE => Endian::Little,
            other => return Err(ArtRecError::BadEndianTag(other)),
        };

        let ver_major = endian.read_u16(&b[6..8]);
        let ver_minor = endian.read_u16(&b[8..10]);
        if ver_major > SUPPORTED_MAJOR {
            return Err(ArtRecError::UnsupportedVersion {
                found: ver_major,
                supported: SUPPORTED_MAJOR,
            });
        }

        let flags = endian.read_u32(&b[10..14]);
        let rec_start_us = endian.read_u64(&b[14..22]);
        let total_duration_us = endian.read_u64(&b[22..30]);
        let universe_count = endian.read_u32(&b[30..34]);
        let frame_count = endian.read_u32(&b[34..38]);
        let universe_desc_offset = endian.read_u32(&b[38..42]);
        let frame_index_offset = endian.read_u32(&b[42..46]);
        let chunk_pool_offset = endian.read_u32(&b[46..50]);
        let compress_algo = CompressAlgo::from_u8(b[50])?;
        let compress_level = b[51];

        Ok(Self {
            flags,
            rec_start_us,
            total_duration_us,
            universe_count,
            frame_count,
            universe_desc_offset,
            frame_index_offset,
            chunk_pool_offset,
            compress_algo,
            compress_level,
            ver_major,
            ver_minor,
        })
    }

    /// 是否允许差分帧。
    #[must_use]
    pub fn allows_diff(&self) -> bool {
        self.flags & FLAG_DIFF_FRAME != 0
    }

    /// 是否推荐循环播放。
    #[must_use]
    pub fn loop_play(&self) -> bool {
        self.flags & FLAG_LOOP != 0
    }
}

/// B 区：单条 Universe 描述。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UniDesc {
    /// ArtNet Net（0~127）。
    pub net: u16,
    /// ArtNet SubUni（0~15）。
    pub subuni: u16,
    /// 完整 Universe 编号 = net*16 + subuni。
    pub universe: u16,
    /// DMX 通道长度（标准 512，支持短帧）。
    pub dmx_len: u16,
}

impl UniDesc {
    /// 由 net/subuni 构造描述，自动计算 `universe` 与默认 512 通道长度。
    ///
    /// # Arguments
    ///
    /// * `net` - ArtNet Net。
    /// * `subuni` - ArtNet SubUni。
    /// * `dmx_len` - DMX 通道长度。
    #[must_use]
    pub fn new(net: u16, subuni: u16, dmx_len: u16) -> Self {
        Self {
            net,
            subuni,
            universe: net * 16 + subuni,
            dmx_len,
        }
    }

    /// 由线性 Universe 编号构造描述（`net = u / 16`，`subuni = u % 16`）。
    ///
    /// 这是运行时 Universe 编号与规范 §4 编码之间的**唯一**换算入口；
    /// 固件若采用不同编码，只需改动此处。
    ///
    /// # Arguments
    ///
    /// * `universe` - 线性 Universe 编号。
    /// * `dmx_len` - DMX 通道长度。
    ///
    /// # Errors
    ///
    /// 编号超过 [`MAX_UNIVERSE`] 返回 [`ArtRecError::UniverseOutOfRange`]。
    pub fn from_universe(universe: u16, dmx_len: u16) -> Result<Self> {
        if universe > MAX_UNIVERSE {
            return Err(ArtRecError::UniverseOutOfRange(universe));
        }
        Ok(Self::new(universe / 16, universe % 16, dmx_len))
    }

    /// 大端序列化为 16 字节。
    #[must_use]
    pub fn to_bytes(&self) -> [u8; UNIDESC_SIZE as usize] {
        let mut b = [0u8; UNIDESC_SIZE as usize];
        b[0..2].copy_from_slice(&self.net.to_be_bytes());
        b[2..4].copy_from_slice(&self.subuni.to_be_bytes());
        b[4..6].copy_from_slice(&self.universe.to_be_bytes());
        b[6..8].copy_from_slice(&self.dmx_len.to_be_bytes());
        // b[8..12] reserved u32 = 0
        b
    }

    /// 从 16 字节解析（大端）。
    ///
    /// # Errors
    ///
    /// 缓冲不足 16 字节返回 [`ArtRecError::Truncated`]。
    pub fn from_bytes(b: &[u8]) -> Result<Self> {
        if b.len() < UNIDESC_SIZE as usize {
            return Err(ArtRecError::Truncated("UniDesc 不足 16 字节"));
        }
        Ok(Self {
            net: u16::from_be_bytes([b[0], b[1]]),
            subuni: u16::from_be_bytes([b[2], b[3]]),
            universe: u16::from_be_bytes([b[4], b[5]]),
            dmx_len: u16::from_be_bytes([b[6], b[7]]),
        })
    }
}

/// C 区：单条帧索引。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameIndex {
    /// 相对节目起点的时间戳（微秒）。
    pub time_us: u64,
    /// Chunk 在 D 区块池内的相对偏移（相对 chunk_pool_offset）。
    pub chunk_pos: u32,
    /// 该 Chunk 总字节大小（ChunkHdr + 压缩 Payload）。
    pub chunk_cmp_len: u16,
}

impl FrameIndex {
    /// 大端序列化为 16 字节。
    #[must_use]
    pub fn to_bytes(&self) -> [u8; FRAMEINDEX_SIZE as usize] {
        let mut b = [0u8; FRAMEINDEX_SIZE as usize];
        b[0..8].copy_from_slice(&self.time_us.to_be_bytes());
        b[8..12].copy_from_slice(&self.chunk_pos.to_be_bytes());
        b[12..14].copy_from_slice(&self.chunk_cmp_len.to_be_bytes());
        // b[14..16] reserved u16 = 0
        b
    }

    /// 从 16 字节解析（大端）。
    ///
    /// # Errors
    ///
    /// 缓冲不足 16 字节返回 [`ArtRecError::Truncated`]。
    pub fn from_bytes(b: &[u8]) -> Result<Self> {
        match b.first_chunk::<{ FRAMEINDEX_SIZE as usize }>() {
            Some(rec) => Ok(Self::from_array(rec)),
            None => Err(ArtRecError::Truncated("FrameIndex 不足 16 字节")),
        }
    }

    /// 从定长 16 字节记录解析（大端，不会失败；crate 内部批量解析索引用）。
    ///
    /// # Arguments
    ///
    /// * `b` - 一条完整的帧索引记录。
    ///
    /// # Returns
    ///
    /// 解析出的帧索引条目。
    pub(crate) fn from_array(b: &[u8; FRAMEINDEX_SIZE as usize]) -> Self {
        Self {
            time_us: u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]),
            chunk_pos: u32::from_be_bytes([b[8], b[9], b[10], b[11]]),
            chunk_cmp_len: u16::from_be_bytes([b[12], b[13]]),
        }
    }
}

/// D 区：Chunk 块头（8 字节）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkHdr {
    /// 0=全量帧；1=差分增量帧。
    pub chunk_type: u16,
    /// 解压之后原始 Payload 总字节数。
    pub payload_raw_sz: u16,
    /// Payload 压缩后字节（不含 8 字节 ChunkHdr）。
    pub payload_cmp_sz: u16,
    /// CRC16-CCITT，仅校验 Payload 区域。
    pub crc16: u16,
}

impl ChunkHdr {
    /// 大端序列化为 8 字节。
    #[must_use]
    pub fn to_bytes(&self) -> [u8; CHUNKHDR_SIZE] {
        let mut b = [0u8; CHUNKHDR_SIZE];
        b[0..2].copy_from_slice(&self.chunk_type.to_be_bytes());
        b[2..4].copy_from_slice(&self.payload_raw_sz.to_be_bytes());
        b[4..6].copy_from_slice(&self.payload_cmp_sz.to_be_bytes());
        b[6..8].copy_from_slice(&self.crc16.to_be_bytes());
        b
    }

    /// 从 8 字节解析（大端）。
    ///
    /// # Errors
    ///
    /// 缓冲不足 8 字节返回 [`ArtRecError::Truncated`]。
    pub fn from_bytes(b: &[u8]) -> Result<Self> {
        if b.len() < CHUNKHDR_SIZE {
            return Err(ArtRecError::Truncated("ChunkHdr 不足 8 字节"));
        }
        Ok(Self {
            chunk_type: u16::from_be_bytes([b[0], b[1]]),
            payload_raw_sz: u16::from_be_bytes([b[2], b[3]]),
            payload_cmp_sz: u16::from_be_bytes([b[4], b[5]]),
            crc16: u16::from_be_bytes([b[6], b[7]]),
        })
    }
}
