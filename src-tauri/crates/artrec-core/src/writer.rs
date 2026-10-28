//! ArtRec 流式写入器。
//!
//! 物理排布为 A(头) → B(UniDesc) → D(Chunk 池) → C(帧索引)。帧索引长度在录制
//! 结束前未知，故置于 D 区之后；分区位置全部由头部偏移字段指明，符合自描述约定。
//!
//! 写入器对所有会导致 u16/u32 字段溢出的输入显式报错，**不做静默截断**。

use std::collections::HashSet;
use std::io::{Seek, SeekFrom, Write};

use crate::compress::ZstdCompressor;
use crate::crc::crc16_ccitt;
use crate::error::{ArtRecError, Result};
use crate::model::{
    ChunkHdr, CompressAlgo, FileHeader, FrameIndex, UniDesc, CHUNKHDR_SIZE, CHUNK_DIFF, CHUNK_FULL,
    HEADER_SIZE, MAX_CHUNK_BYTES, MAX_FULL_PAYLOAD, UNIDESC_SIZE, VER_MAJOR, VER_MINOR,
};
use crate::payload::{assemble_full_into, encode_diff_into, DiffChange};

/// 单个差分帧最多容纳的变更点数（受 `payload_raw_sz` 为 u16 限制：2 + 5×N ≤ 65535）。
pub const MAX_DIFF_CHANGES: usize = (MAX_FULL_PAYLOAD - 2) / 5;

/// 校验 Universe 描述表：无重复，且全量帧总长不超过单 Chunk 上限。
///
/// # Errors
///
/// 重复返回 [`ArtRecError::DuplicateUniverse`]，过大返回 [`ArtRecError::PayloadTooLarge`]。
fn validate_unis(unis: &[UniDesc]) -> Result<()> {
    let mut seen = HashSet::with_capacity(unis.len());
    for u in unis {
        if !seen.insert(u.universe) {
            return Err(ArtRecError::DuplicateUniverse(u.universe));
        }
    }
    let total: usize = unis.iter().map(|u| u.dmx_len as usize).sum();
    if total > MAX_FULL_PAYLOAD {
        return Err(ArtRecError::PayloadTooLarge {
            total,
            max: MAX_FULL_PAYLOAD,
        });
    }
    Ok(())
}

/// 按压缩算法创建写入器持有的压缩上下文。
///
/// # Arguments
///
/// * `algo` - 压缩算法。
/// * `level` - Zstd 压缩等级。
///
/// # Returns
///
/// Zstd 时返回可复用的压缩上下文；无压缩时返回 `None`。
///
/// # Errors
///
/// 压缩上下文创建失败返回 [`ArtRecError::Io`]。
fn new_codec(algo: CompressAlgo, level: u8) -> Result<Option<ZstdCompressor>> {
    match algo {
        CompressAlgo::None => Ok(None),
        CompressAlgo::Zstd => ZstdCompressor::new(level).map(Some),
    }
}

/// ArtRec 流式写入器，泛型于任意 `Write + Seek`（文件或内存 `Cursor`）。
///
/// Zstd 模式下写入器持有一个跨帧复用的压缩上下文与输出缓冲，每帧只做压缩本身，
/// 不再重复创建上下文；产物仍是每个 Chunk 一个独立的标准 Zstd 帧（不写原始大小字段）。
pub struct ArtRecWriter<W: Write + Seek> {
    w: W,
    unis: Vec<UniDesc>,
    algo: CompressAlgo,
    level: u8,
    flags: u32,
    rec_start_us: u64,
    chunk_pool_offset: u32,
    index: Vec<FrameIndex>,
    bytes_written_in_pool: u32,
    /// Zstd 压缩上下文（无压缩时为 `None`）。
    codec: Option<ZstdCompressor>,
    /// 复用的压缩输出缓冲。
    packed: Vec<u8>,
    /// 复用的原始 Payload 装配缓冲。
    raw: Vec<u8>,
}

impl<W: Write + Seek> ArtRecWriter<W> {
    /// 创建写入器并写出文件头占位与 Universe 描述表。
    ///
    /// # Arguments
    ///
    /// * `w` - 目标写入流。
    /// * `unis` - Universe 描述表。
    /// * `algo` - 压缩算法。
    /// * `level` - Zstd 压缩等级（无压缩忽略）。
    /// * `flags` - 全局标志位。
    /// * `rec_start_us` - 录制开始 Unix 时间戳（微秒，仅记日志）。
    ///
    /// # Returns
    ///
    /// 已写出头占位与 B 区、就绪接收帧的写入器。
    ///
    /// # Errors
    ///
    /// - Universe 重复或全量帧过大，见 [`ArtRecError::DuplicateUniverse`] / [`ArtRecError::PayloadTooLarge`]。
    /// - Zstd 压缩上下文创建失败或底层写入失败返回 [`ArtRecError::Io`]。
    pub fn new(
        mut w: W,
        unis: Vec<UniDesc>,
        algo: CompressAlgo,
        level: u8,
        flags: u32,
        rec_start_us: u64,
    ) -> Result<Self> {
        validate_unis(&unis)?;
        let codec = new_codec(algo, level)?;
        let universe_desc_offset = HEADER_SIZE;
        let chunk_pool_offset = HEADER_SIZE + unis.len() as u32 * UNIDESC_SIZE;

        // 头占位：计数/时长/索引偏移先置 0，关闭时回填。
        let header = FileHeader {
            flags,
            rec_start_us,
            total_duration_us: 0,
            universe_count: unis.len() as u32,
            frame_count: 0,
            universe_desc_offset,
            frame_index_offset: 0,
            chunk_pool_offset,
            compress_algo: algo,
            compress_level: level,
            ver_major: VER_MAJOR,
            ver_minor: VER_MINOR,
        };
        w.seek(SeekFrom::Start(0))?;
        w.write_all(&header.to_bytes())?;
        for u in &unis {
            w.write_all(&u.to_bytes())?;
        }

        Ok(Self {
            w,
            unis,
            algo,
            level,
            flags,
            rec_start_us,
            chunk_pool_offset,
            index: Vec::new(),
            bytes_written_in_pool: 0,
            codec,
            packed: Vec::new(),
            raw: Vec::new(),
        })
    }

    /// 在已写出头与 B 区、且 Chunk 池已有若干帧的流上恢复写入（崩溃恢复用）。
    ///
    /// 调用方需保证 `w` 的内容在 `chunk_pool_offset + 已有 Chunk 总长` 之后已被截断。
    /// 恢复后可继续追加帧，或直接 [`ArtRecWriter::finish`] 补写索引与头部。
    ///
    /// # Arguments
    ///
    /// * `w` - 目标流（头与 B 区已存在）。
    /// * `unis` - Universe 描述表（须与文件中 B 区一致）。
    /// * `algo` - 压缩算法。
    /// * `level` - Zstd 压缩等级。
    /// * `flags` - 全局标志位。
    /// * `rec_start_us` - 录制开始时间戳。
    /// * `index` - 已确认完整落盘的帧索引（升序）。
    ///
    /// # Returns
    ///
    /// 已将流定位到 Chunk 池末尾、持有既有 `index` 的写入器，可继续追加帧或直接结束。
    ///
    /// # Errors
    ///
    /// 参数校验失败、Zstd 压缩上下文创建失败或定位失败时返回对应 [`ArtRecError`]。
    pub fn resume(
        mut w: W,
        unis: Vec<UniDesc>,
        algo: CompressAlgo,
        level: u8,
        flags: u32,
        rec_start_us: u64,
        index: Vec<FrameIndex>,
    ) -> Result<Self> {
        validate_unis(&unis)?;
        let codec = new_codec(algo, level)?;
        let chunk_pool_offset = HEADER_SIZE + unis.len() as u32 * UNIDESC_SIZE;
        let pool_len = index.last().map_or(0u64, |l| {
            u64::from(l.chunk_pos) + u64::from(l.chunk_cmp_len)
        });
        let pool_len = u32::try_from(pool_len).map_err(|_| ArtRecError::FileTooLarge)?;
        w.seek(SeekFrom::Start(
            u64::from(chunk_pool_offset) + u64::from(pool_len),
        ))?;
        Ok(Self {
            w,
            unis,
            algo,
            level,
            flags,
            rec_start_us,
            chunk_pool_offset,
            index,
            bytes_written_in_pool: pool_len,
            codec,
            packed: Vec::new(),
            raw: Vec::new(),
        })
    }

    /// 写入一帧全量帧。
    ///
    /// # Arguments
    ///
    /// * `time_us` - 相对节目起点的时间戳（微秒）。
    /// * `buffers` - 与 UniDesc 一一对应的各路 DMX 缓冲。
    ///
    /// # Returns
    ///
    /// 新追加的帧索引条目（调用方可据此写崩溃恢复日志）。
    ///
    /// # Errors
    ///
    /// 装配/压缩/写入失败时返回对应 [`ArtRecError`]。
    pub fn add_full_frame(&mut self, time_us: u64, buffers: &[Vec<u8>]) -> Result<FrameIndex> {
        // 原始 Payload 装配进复用缓冲；先取出再放回，避免与 `&mut self` 借用冲突
        let mut raw = std::mem::take(&mut self.raw);
        let res = assemble_full_into(&self.unis, buffers, &mut raw)
            .and_then(|()| self.write_chunk(CHUNK_FULL, time_us, &raw));
        self.raw = raw;
        res
    }

    /// 写入一帧差分增量帧（需 flags 已置 ALLOW_DIFF_FRAME）。
    ///
    /// # Arguments
    ///
    /// * `time_us` - 相对节目起点的时间戳（微秒）。
    /// * `changes` - 相对上一帧的变更点列表，不得超过 [`MAX_DIFF_CHANGES`]。
    ///
    /// # Returns
    ///
    /// 新追加的帧索引条目。
    ///
    /// # Errors
    ///
    /// 变更点过多返回 [`ArtRecError::ChunkTooLarge`]；压缩/写入失败返回对应错误。
    pub fn add_diff_frame(&mut self, time_us: u64, changes: &[DiffChange]) -> Result<FrameIndex> {
        if changes.len() > MAX_DIFF_CHANGES {
            return Err(ArtRecError::ChunkTooLarge {
                size: 2 + changes.len() * 5,
                max: MAX_FULL_PAYLOAD,
            });
        }
        let mut raw = std::mem::take(&mut self.raw);
        encode_diff_into(changes, &mut raw);
        let res = self.write_chunk(CHUNK_DIFF, time_us, &raw);
        self.raw = raw;
        res
    }

    fn write_chunk(&mut self, chunk_type: u16, time_us: u64, raw: &[u8]) -> Result<FrameIndex> {
        if let Some(last) = self.index.last()
            && time_us < last.time_us {
                return Err(ArtRecError::NonMonotonicTime {
                    prev: last.time_us,
                    now: time_us,
                });
            }
        // Zstd：复用上下文压缩进复用缓冲；无压缩：直接写原始 Payload，不再拷贝
        let packed: &[u8] = match self.codec.as_mut() {
            Some(codec) => {
                codec.compress_into(raw, &mut self.packed)?;
                &self.packed
            }
            None => raw,
        };
        let total = CHUNKHDR_SIZE + packed.len();
        if raw.len() > MAX_CHUNK_BYTES || total > MAX_CHUNK_BYTES {
            return Err(ArtRecError::ChunkTooLarge {
                size: total.max(raw.len()),
                max: MAX_CHUNK_BYTES,
            });
        }
        let new_pool = u32::try_from(u64::from(self.bytes_written_in_pool) + total as u64)
            .map_err(|_| ArtRecError::FileTooLarge)?;
        // 索引表（16 字节/帧）也要落在 u32 可寻址范围内
        let index_end = u64::from(self.chunk_pool_offset)
            + u64::from(new_pool)
            + (self.index.len() as u64 + 1) * 16;
        if index_end > u64::from(u32::MAX) {
            return Err(ArtRecError::FileTooLarge);
        }

        let hdr = ChunkHdr {
            chunk_type,
            payload_raw_sz: raw.len() as u16,
            payload_cmp_sz: packed.len() as u16,
            crc16: crc16_ccitt(raw),
        };
        let chunk_pos = self.bytes_written_in_pool;
        self.w.write_all(&hdr.to_bytes())?;
        self.w.write_all(packed)?;
        self.bytes_written_in_pool = new_pool;
        let entry = FrameIndex {
            time_us,
            chunk_pos,
            chunk_cmp_len: total as u16,
        };
        self.index.push(entry);
        Ok(entry)
    }

    /// 已写入的帧数。
    ///
    /// # Returns
    ///
    /// 帧索引表当前的条目数，即已写入的帧数。
    #[must_use]
    pub fn frame_count(&self) -> usize {
        self.index.len()
    }

    /// 当前文件已占用的字节数（头 + B 区 + 已写 Chunk，不含尚未写出的索引表）。
    ///
    /// # Returns
    ///
    /// 文件当前占用的字节数，不含尚未写出的帧索引表。
    #[must_use]
    pub fn bytes_written(&self) -> u64 {
        u64::from(self.chunk_pool_offset) + u64::from(self.bytes_written_in_pool)
    }

    /// 最后一帧的时间戳（无帧时为 `None`）。
    ///
    /// # Returns
    ///
    /// 已写入帧时返回最后一帧的时间戳（微秒）；尚无帧时返回 `None`。
    #[must_use]
    pub fn last_time_us(&self) -> Option<u64> {
        self.index.last().map(|f| f.time_us)
    }

    /// 刷新底层流缓冲。
    ///
    /// # Errors
    ///
    /// 刷新失败返回 [`ArtRecError::Io`]。
    pub fn flush(&mut self) -> Result<()> {
        self.w.flush()?;
        Ok(())
    }

    /// 底层流的只读引用（例如对文件调用 `sync_data`）。
    ///
    /// # Returns
    ///
    /// 写入器持有的底层流 `W` 的只读引用。
    #[must_use]
    pub fn get_ref(&self) -> &W {
        &self.w
    }

    /// 放弃写入并取回底层流：**不**补写索引与头部。
    ///
    /// 仅用于崩溃恢复测试与取消录制；得到的文件不是合法的 `.artrec`。
    ///
    /// # Returns
    ///
    /// 消费写入器并返回底层流 `W`，其内容停留在放弃时刻。
    #[must_use]
    pub fn into_inner(self) -> W {
        self.w
    }

    /// 结束录制：写出帧索引表并回填文件头。
    ///
    /// # Arguments
    ///
    /// * `total_duration_us` - 节目总时长（微秒）；通常等于最后一帧的 `time_us`。
    ///
    /// # Returns
    ///
    /// 消费写入器并返回底层流。
    ///
    /// # Errors
    ///
    /// 写入/定位失败返回 [`ArtRecError::Io`]。
    pub fn finish(mut self, total_duration_us: u64) -> Result<W> {
        // 帧索引表紧接 D 区之后
        let frame_index_offset = self.chunk_pool_offset + self.bytes_written_in_pool;
        self.w
            .seek(SeekFrom::Start(u64::from(frame_index_offset)))?;
        for idx in &self.index {
            self.w.write_all(&idx.to_bytes())?;
        }

        // 回填头部
        let header = FileHeader {
            flags: self.flags,
            rec_start_us: self.rec_start_us,
            total_duration_us,
            universe_count: self.unis.len() as u32,
            frame_count: self.index.len() as u32,
            universe_desc_offset: HEADER_SIZE,
            frame_index_offset,
            chunk_pool_offset: self.chunk_pool_offset,
            compress_algo: self.algo,
            compress_level: self.level,
            ver_major: VER_MAJOR,
            ver_minor: VER_MINOR,
        };
        self.w.seek(SeekFrom::Start(0))?;
        self.w.write_all(&header.to_bytes())?;
        self.w.flush()?;
        Ok(self.w)
    }
}
