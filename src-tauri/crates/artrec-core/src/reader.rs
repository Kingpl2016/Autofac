//! ArtRec 随机访问读取器（时间驱动回放用）。
//!
//! 读取器只把文件头、Universe 描述表与帧索引常驻内存，Chunk 按需从底层
//! `Read + Seek` 读取，因此可以直接打开磁盘上的大文件而不必整份载入内存。

use std::cell::RefCell;
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use crate::compress::decompress;
use crate::crc::crc16_ccitt;
use crate::error::{ArtRecError, Result};
use crate::model::{
    ChunkHdr, FileHeader, FrameIndex, UniDesc, CHUNKHDR_SIZE, CHUNK_FULL, FRAMEINDEX_SIZE,
    HEADER_SIZE, UNIDESC_SIZE,
};
use crate::payload::{apply_diff, decode_diff, split_full};

/// ArtRec 读取器：按头部偏移字段定位各分区，支持二分查找随机定位。
///
/// 泛型参数 `R` 为底层数据源，默认是内存中的 `Cursor<Vec<u8>>`（兼容
/// [`ArtRecReader::open`]）；磁盘文件请用 [`ArtRecReader::open_file`]。
#[derive(Debug)]
pub struct ArtRecReader<R: Read + Seek = Cursor<Vec<u8>>> {
    src: RefCell<R>,
    len: u64,
    header: FileHeader,
    unis: Vec<UniDesc>,
    index: Vec<FrameIndex>,
}

impl ArtRecReader<Cursor<Vec<u8>>> {
    /// 解析整份 ArtRec 文件字节（内存版）。
    ///
    /// # Arguments
    ///
    /// * `bytes` - 完整文件内容。
    ///
    /// # Returns
    ///
    /// 已就绪、可随机定位的读取器。
    ///
    /// # Errors
    ///
    /// 见 [`ArtRecReader::from_reader`]。
    pub fn open(bytes: Vec<u8>) -> Result<Self> {
        Self::from_reader(Cursor::new(bytes))
    }
}

impl ArtRecReader<File> {
    /// 以流式方式打开磁盘上的 `.artrec` 文件，不整份载入内存。
    ///
    /// # Arguments
    ///
    /// * `path` - 文件路径。
    ///
    /// # Returns
    ///
    /// 已解析文件头、Universe 表与帧索引、可随机定位的流式读取器。
    ///
    /// # Errors
    ///
    /// 打开失败返回 [`ArtRecError::Io`]，其余见 [`ArtRecReader::from_reader`]。
    pub fn open_file(path: &Path) -> Result<Self> {
        Self::from_reader(File::open(path)?)
    }
}

impl<R: Read + Seek> ArtRecReader<R> {
    /// 从任意 `Read + Seek` 数据源解析文件头、Universe 表与帧索引。
    ///
    /// # Arguments
    ///
    /// * `src` - 数据源。
    ///
    /// # Returns
    ///
    /// 已就绪、可随机定位的读取器。
    ///
    /// # Errors
    ///
    /// - 文件头非法见 [`FileHeader::from_bytes`]。
    /// - 帧索引非升序返回 [`ArtRecError::UnsortedIndex`]。
    /// - 数据截断（含计数字段声明的区域越界）返回 [`ArtRecError::Truncated`]。
    pub fn from_reader(mut src: R) -> Result<Self> {
        let len = src.seek(SeekFrom::End(0))?;
        let head_len = len.min(u64::from(HEADER_SIZE)) as usize;
        let mut head = vec![0u8; head_len];
        src.seek(SeekFrom::Start(0))?;
        src.read_exact(&mut head)?;
        let header = FileHeader::from_bytes(&head)?;

        // 区域越界检查先于分配，避免恶意计数字段导致巨量内存申请。
        let b_off = u64::from(header.universe_desc_offset);
        let b_len = u64::from(header.universe_count) * u64::from(UNIDESC_SIZE);
        if b_off + b_len > len {
            return Err(ArtRecError::Truncated("Universe 描述表越界"));
        }
        let c_off = u64::from(header.frame_index_offset);
        let c_len = u64::from(header.frame_count) * u64::from(FRAMEINDEX_SIZE);
        if c_off + c_len > len {
            return Err(ArtRecError::Truncated("帧索引表越界"));
        }

        let mut b = vec![0u8; b_len as usize];
        src.seek(SeekFrom::Start(b_off))?;
        src.read_exact(&mut b)?;
        let unis = b
            .chunks_exact(UNIDESC_SIZE as usize)
            .map(UniDesc::from_bytes)
            .collect::<Result<Vec<_>>>()?;

        let mut c = vec![0u8; c_len as usize];
        src.seek(SeekFrom::Start(c_off))?;
        src.read_exact(&mut c)?;
        let mut index: Vec<FrameIndex> = Vec::with_capacity(header.frame_count as usize);
        for (i, rec) in c.chunks_exact(FRAMEINDEX_SIZE as usize).enumerate() {
            let fi = FrameIndex::from_bytes(rec)?;
            if i > 0 && fi.time_us < index[i - 1].time_us {
                return Err(ArtRecError::UnsortedIndex(i));
            }
            index.push(fi);
        }

        Ok(Self {
            src: RefCell::new(src),
            len,
            header,
            unis,
            index,
        })
    }

    /// 文件总字节数。
    ///
    /// # Returns
    ///
    /// 打开时探测到的数据源总字节数。
    #[must_use]
    pub fn file_len(&self) -> u64 {
        self.len
    }

    /// 文件头。
    ///
    /// # Returns
    ///
    /// 已解析的 [`FileHeader`] 的只读引用。
    #[must_use]
    pub fn header(&self) -> &FileHeader {
        &self.header
    }

    /// Universe 描述表。
    ///
    /// # Returns
    ///
    /// 文件内全部 [`UniDesc`] 的只读切片，顺序与文件中 B 区一致。
    #[must_use]
    pub fn unis(&self) -> &[UniDesc] {
        &self.unis
    }

    /// 帧索引表。
    ///
    /// # Returns
    ///
    /// 全部 [`FrameIndex`] 的只读切片，按时间戳升序排列。
    #[must_use]
    pub fn index(&self) -> &[FrameIndex] {
        &self.index
    }

    /// 二分查找满足 `time_us <= now_us` 的最大帧索引下标。
    ///
    /// # Arguments
    ///
    /// * `now_us` - 当前播放相对时间（微秒）。
    ///
    /// # Returns
    ///
    /// 命中帧的下标；若 `now_us` 早于首帧则返回 `None`。
    #[must_use]
    pub fn find_index(&self, now_us: u64) -> Option<usize> {
        if self.index.is_empty() || now_us < self.index[0].time_us {
            return None;
        }
        // partition_point 返回首个 time_us > now_us 的位置
        let p = self.index.partition_point(|fi| fi.time_us <= now_us);
        Some(p - 1)
    }

    /// 从绝对偏移读取恰好 `buf.len()` 字节；越界按截断处理。
    fn read_exact_at(&self, off: u64, buf: &mut [u8], what: &'static str) -> Result<()> {
        if off + buf.len() as u64 > self.len {
            return Err(ArtRecError::Truncated(what));
        }
        let mut src = self.src.borrow_mut();
        src.seek(SeekFrom::Start(off))?;
        src.read_exact(buf)?;
        Ok(())
    }

    fn chunk_base(&self, i: usize) -> u64 {
        u64::from(self.header.chunk_pool_offset) + u64::from(self.index[i].chunk_pos)
    }

    /// 读取指定下标 Chunk 的头。
    fn read_chunk_hdr(&self, i: usize) -> Result<ChunkHdr> {
        let mut b = [0u8; CHUNKHDR_SIZE];
        self.read_exact_at(self.chunk_base(i), &mut b, "ChunkHdr 越界")?;
        ChunkHdr::from_bytes(&b)
    }

    /// 读取并解压校验指定下标 Chunk 的原始 Payload。
    ///
    /// # Arguments
    ///
    /// * `i` - 帧索引下标。
    ///
    /// # Returns
    ///
    /// `(ChunkHdr, 解压后的原始 Payload)`。
    ///
    /// # Errors
    ///
    /// - CRC 不符返回 [`ArtRecError::CrcMismatch`]。
    /// - 解压失败返回 [`ArtRecError::Decompress`]。
    pub fn read_chunk(&self, i: usize) -> Result<(ChunkHdr, Vec<u8>)> {
        let hdr = self.read_chunk_hdr(i)?;
        let mut packed = vec![0u8; hdr.payload_cmp_sz as usize];
        self.read_exact_at(
            self.chunk_base(i) + CHUNKHDR_SIZE as u64,
            &mut packed,
            "Chunk Payload 越界",
        )?;
        let raw = decompress(
            self.header.compress_algo,
            &packed,
            hdr.payload_raw_sz as usize,
        )?;
        let actual = crc16_ccitt(&raw);
        if actual != hdr.crc16 {
            return Err(ArtRecError::CrcMismatch {
                expected: hdr.crc16,
                actual,
            });
        }
        Ok((hdr, raw))
    }

    /// 回溯到 `<= i` 的最近全量帧下标。
    ///
    /// 若沿途遇到差分帧而文件未置 ALLOW_DIFF_FRAME，返回
    /// [`ArtRecError::DiffFrameNotAllowed`]；回溯到首帧仍是差分帧时返回 0。
    ///
    /// # Arguments
    ///
    /// * `i` - 起始帧下标，从该帧向前回溯。
    ///
    /// # Returns
    ///
    /// `<= i` 的最近全量帧下标；若一直回溯到首帧仍是差分帧则返回 `0`。
    ///
    /// # Errors
    ///
    /// Chunk 头读取失败或差分帧未被允许时返回对应错误。
    pub fn keyframe_at_or_before(&self, i: usize) -> Result<usize> {
        let mut k = i;
        loop {
            let hdr = self.read_chunk_hdr(k)?;
            if hdr.chunk_type == CHUNK_FULL {
                return Ok(k);
            }
            if !self.header.allows_diff() {
                return Err(ArtRecError::DiffFrameNotAllowed);
            }
            if k == 0 {
                return Ok(0);
            }
            k -= 1;
        }
    }

    /// 由单个 Chunk 的原始 Payload 在给定缓冲基础上就地推进一帧。
    ///
    /// 全量帧整体替换，差分帧在 `buffers` 上原地修改。
    ///
    /// # Arguments
    ///
    /// * `buffers` - 各路 DMX 缓冲，就地被更新。
    /// * `hdr` - 该 Chunk 的头，用于区分全量帧与差分帧。
    /// * `raw` - 该 Chunk 解压后的原始 Payload。
    ///
    /// # Errors
    ///
    /// Payload 长度或差分记录非法时返回对应错误。
    pub fn apply_chunk(
        &self,
        buffers: &mut Vec<Vec<u8>>,
        hdr: &ChunkHdr,
        raw: &[u8],
    ) -> Result<()> {
        if hdr.chunk_type == CHUNK_FULL {
            *buffers = split_full(&self.unis, raw)?;
        } else {
            apply_diff(buffers, &decode_diff(raw)?);
        }
        Ok(())
    }

    /// 全 0 缓冲（差分帧缺少基准时的起点）。
    ///
    /// # Returns
    ///
    /// 与 UniDesc 一一对应的全零缓冲，每路长度为对应的 `dmx_len`。
    #[must_use]
    pub fn zero_buffers(&self) -> Vec<Vec<u8>> {
        self.unis
            .iter()
            .map(|u| vec![0u8; u.dmx_len as usize])
            .collect()
    }

    /// 解析指定下标帧为各路 DMX 缓冲（差分帧自动回溯最近全量帧并前向应用）。
    ///
    /// # Arguments
    ///
    /// * `i` - 帧索引下标。
    ///
    /// # Returns
    ///
    /// 与 UniDesc 一一对应的各路 DMX 缓冲。
    ///
    /// # Errors
    ///
    /// - 差分帧出现但未置 ALLOW_DIFF_FRAME 返回 [`ArtRecError::DiffFrameNotAllowed`]。
    /// - 读取/解压/CRC 失败见 [`ArtRecReader::read_chunk`]。
    pub fn resolve_frame(&self, i: usize) -> Result<Vec<Vec<u8>>> {
        let start = self.keyframe_at_or_before(i)?;
        let mut buffers = self.zero_buffers();
        for k in start..=i {
            let (hdr, raw) = self.read_chunk(k)?;
            self.apply_chunk(&mut buffers, &hdr, &raw)?;
        }
        Ok(buffers)
    }

    /// 按播放时间定位并解析该时刻应输出的帧。
    ///
    /// # Arguments
    ///
    /// * `now_us` - 当前播放相对时间（微秒）。
    ///
    /// # Returns
    ///
    /// 命中则返回各路 DMX 缓冲；`now_us` 早于首帧返回 `Ok(None)`。
    ///
    /// # Errors
    ///
    /// 帧解析失败见 [`ArtRecReader::resolve_frame`]。
    pub fn frame_at(&self, now_us: u64) -> Result<Option<Vec<Vec<u8>>>> {
        match self.find_index(now_us) {
            None => Ok(None),
            Some(i) => Ok(Some(self.resolve_frame(i)?)),
        }
    }
}
