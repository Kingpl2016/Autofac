//! ArtRec（`.artrec`）灯光节目录制文件格式的编解码核心。
//!
//! 本 crate 是 ArtRec 二进制格式的权威实现，纯逻辑、不依赖任何运行时或 IO 框架，
//! 便于在录制器、回放器与测试中复用。对齐《ArtRec 灯光节目录制文件规范 v1.0》：
//! 大端字节序、固定文件头、Universe 描述表、升序帧索引、Chunk 块池，支持 Zstd
//! 压缩、CRC16-CCITT 校验、二分查找随机定位，以及可选的差分增量帧。
//!
//! # 容量上限（写入端显式报错，不做静默截断）
//!
//! - Universe 编号 ≤ 2047（规范 §4：`net` 0~127、`subuni` 0~15），换算见 [`UniDesc::from_universe`]。
//! - 单帧全量 Payload ≤ 65527 字节（约 127 路 512 通道），受 `payload_raw_sz` / `chunk_cmp_len` 为 u16 限制。
//! - 文件 ≤ 4 GiB（偏移字段为 u32）。
//!
//! # 关于文件头尺寸
//!
//! 规范正文与 §13 示例以 **64 字节**头为准（`universe_desc_offset = 64`），而 C 结构体
//! 含 `reserved[34]`、`pack(1)` 实为 88 字节，二者矛盾。本实现写入 64 字节头，读取端
//! 完全按头部偏移字段定位分区，兼容两种尺寸。最终以嵌入式固件实现为准对齐。

mod compress;
mod crc;
mod error;
mod model;
mod payload;
mod reader;
mod writer;

pub use compress::{compress, decompress};
pub use crc::crc16_ccitt;
pub use error::{ArtRecError, Result};
pub use model::{
    ChunkHdr, CompressAlgo, FileHeader, FrameIndex, UniDesc, CHUNKHDR_SIZE, CHUNK_DIFF,
    CHUNK_FULL, ENDIAN_TAG_BE, ENDIAN_TAG_LE, FLAG_DIFF_FRAME, FLAG_LOOP, FLAG_SMPTE,
    FRAMEINDEX_SIZE, HEADER_SIZE, MAGIC, MAX_CHUNK_BYTES, MAX_FULL_PAYLOAD, MAX_NET,
    MAX_UNIVERSE, SUPPORTED_MAJOR, UNIDESC_SIZE, VER_MAJOR, VER_MINOR,
};
pub use payload::{
    apply_diff, assemble_full, decode_diff, encode_diff, split_full, DiffChange,
};
pub use reader::ArtRecReader;
pub use writer::{ArtRecWriter, MAX_DIFF_CHANGES};
