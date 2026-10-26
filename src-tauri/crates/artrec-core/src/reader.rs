//! ArtRec 随机访问读取器（时间驱动回放用）。
//!
//! 读取器只把文件头、Universe 描述表与帧索引常驻内存，Chunk 按需从底层
//! `Read + Seek` 读取，因此可以直接打开磁盘上的大文件而不必整份载入内存。
//!
//! # 热路径的复用策略
//!
//! - 读一个 Chunk 时按索引里的 `chunk_cmp_len` **一次**读出块头与压缩 Payload，
//!   放进读取器内部复用的暂存缓冲；索引与块头不一致时回退到旧的"先读块头再读 Payload"路径。
//! - Zstd 解压上下文在首次解压时创建并跨帧复用（只读文件头的场景不付出创建成本）。
//! - [`ArtRecReader::read_chunk_into`] / [`ArtRecReader::apply_chunk_into`] 让调用方复用
//!   原始 Payload 缓冲与各路 DMX 缓冲。
//! - 帧索引以 `Arc<[FrameIndex]>` 存放，[`ArtRecReader::with_source`] 可在不重读文件的
//!   前提下为其它数据源（另一个文件句柄、[`crate::ReadAhead`] 等）建立共享索引的读取器。

use std::cell::RefCell;
use std::fmt;
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::ops::Range;
use std::path::Path;
use std::sync::Arc;

use zstd::bulk::Decompressor;

use crate::compress::decompress_into;
use crate::crc::crc16_ccitt;
use crate::error::{ArtRecError, Result};
use crate::model::{
    ChunkHdr, CompressAlgo, FileHeader, FrameIndex, UniDesc, CHUNKHDR_SIZE, CHUNK_FULL,
    FRAMEINDEX_SIZE, HEADER_SIZE, UNIDESC_SIZE,
};
use crate::payload::{apply_diff_payload, split_full_into};

/// ArtRec 读取器：按头部偏移字段定位各分区，支持二分查找随机定位。
///
/// 泛型参数 `R` 为底层数据源，默认是内存中的 `Cursor<Vec<u8>>`（兼容
/// [`ArtRecReader::open`]）；磁盘文件请用 [`ArtRecReader::open_file`]。
///
/// 读取器内部用 `RefCell` 管理数据源与复用缓冲，因此是 `Send`（`R: Send` 时）但不是
/// `Sync`。并行扫描时请在持有原读取器的线程上为每个工作线程调用
/// [`ArtRecReader::with_source`] 建立各自的读取器（共享索引、各自的文件句柄与解压上下文），
/// 再把它们移交给工作线程。
pub struct ArtRecReader<R: Read + Seek = Cursor<Vec<u8>>> {
    src: RefCell<R>,
    len: u64,
    header: FileHeader,
    unis: Vec<UniDesc>,
    /// 帧索引（只读，可被 [`ArtRecReader::with_source`] 派生的读取器共享）。
    index: Arc<[FrameIndex]>,
    /// Zstd 解压上下文：首次解压时创建，之后跨帧复用。
    dctx: RefCell<Option<Decompressor<'static>>>,
    /// 块头 + 压缩 Payload 的暂存缓冲（只增不减，避免反复清零）。
    scratch: RefCell<Vec<u8>>,
    /// [`ArtRecReader::resolve_frame`] 复用的原始 Payload 缓冲。
    raw: RefCell<Vec<u8>>,
}

impl<R: Read + Seek + fmt::Debug> fmt::Debug for ArtRecReader<R> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ArtRecReader")
            .field("src", &self.src)
            .field("len", &self.len)
            .field("header", &self.header)
            .field("unis", &self.unis)
            .field("frames", &self.index.len())
            .finish_non_exhaustive()
    }
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

/// 读取并校验 ArtRec 文件头（A 区）与 Universe 描述表（B 区）。
///
/// 自身用 `seek` 探测总长度，仅校验 B 区边界；帧索引（C 区）由各调用方按需处理。
/// 随机访问读取器与孤儿录制恢复共用此函数，避免重复的"读头 + 解表"胶水代码。
///
/// # Arguments
///
/// * `src` - 数据源（`File`、`Cursor` 等均可）。
///
/// # Returns
///
/// `(文件总字节数, 文件头, Universe 描述表)`。
///
/// # Errors
///
/// 文件头非法见 [`FileHeader::from_bytes`]；B 区越界返回 [`ArtRecError::Truncated`]。
pub fn read_header_and_unis<R: Read + Seek>(
    src: &mut R,
) -> Result<(u64, FileHeader, Vec<UniDesc>)> {
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
    let mut b = vec![0u8; b_len as usize];
    src.seek(SeekFrom::Start(b_off))?;
    src.read_exact(&mut b)?;
    let unis = b
        .as_chunks::<{ UNIDESC_SIZE as usize }>()
        .0
        .iter()
        .map(|rec| UniDesc::from_bytes(rec))
        .collect::<Result<Vec<_>>>()?;
    Ok((len, header, unis))
}

/// 保证 `buf` 至少有 `n` 字节并返回前 `n` 字节的可写切片（只增不减，避免反复清零）。
///
/// # Arguments
///
/// * `buf` - 复用的暂存缓冲。
/// * `n` - 需要的字节数。
///
/// # Returns
///
/// `buf[..n]`。
fn prefix_mut(buf: &mut Vec<u8>, n: usize) -> &mut [u8] {
    if buf.len() < n {
        buf.resize(n, 0);
    }
    &mut buf[..n]
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
        let (len, header, unis) = read_header_and_unis(&mut src)?;

        // 帧索引（C 区）为 reader 独有，孤儿恢复路径不读此区。
        let c_off = u64::from(header.frame_index_offset);
        let c_len = u64::from(header.frame_count) * u64::from(FRAMEINDEX_SIZE);
        if c_off + c_len > len {
            return Err(ArtRecError::Truncated("帧索引表越界"));
        }

        let mut c = vec![0u8; c_len as usize];
        src.seek(SeekFrom::Start(c_off))?;
        src.read_exact(&mut c)?;
        // 定长记录切片迭代器长度确定，`collect` 直接一次性分配 `Arc<[_]>`，不经中间 Vec
        let index: Arc<[FrameIndex]> = c
            .as_chunks::<{ FRAMEINDEX_SIZE as usize }>()
            .0
            .iter()
            .map(FrameIndex::from_array)
            .collect();
        if let Some(p) = index.windows(2).position(|w| w[1].time_us < w[0].time_us) {
            return Err(ArtRecError::UnsortedIndex(p + 1));
        }

        Ok(Self {
            src: RefCell::new(src),
            len,
            header,
            unis,
            index,
            dctx: RefCell::new(None),
            scratch: RefCell::new(Vec::new()),
            raw: RefCell::new(Vec::new()),
        })
    }

    /// 基于本读取器已解析的文件头、Universe 表与帧索引，为另一个数据源建立读取器。
    ///
    /// 不重读文件头与索引（索引以 `Arc` 共享），新读取器拥有自己的数据源、解压上下文与
    /// 复用缓冲，可移交给其它线程独立读帧。典型用法：
    ///
    /// - 并行扫描：每个工作线程一个 `reader.with_source(File::open(path)?)?`；
    /// - 顺序扫描：`reader.with_source(ReadAhead::new(File::open(path)?, 1 << 20))?`，
    ///   见 [`crate::ReadAhead`]。
    ///
    /// # Arguments
    ///
    /// * `src` - 新数据源，必须与本读取器打开的是同一份文件内容。
    ///
    /// # Returns
    ///
    /// 共享头、Universe 表与索引的新读取器。
    ///
    /// # Errors
    ///
    /// - 探测 `src` 长度失败返回 [`ArtRecError::Io`]。
    /// - `src` 总长度与原文件不一致返回 [`ArtRecError::SourceLenMismatch`]。
    pub fn with_source<S: Read + Seek>(&self, mut src: S) -> Result<ArtRecReader<S>> {
        let actual = src.seek(SeekFrom::End(0))?;
        if actual != self.len {
            return Err(ArtRecError::SourceLenMismatch {
                expected: self.len,
                actual,
            });
        }
        Ok(ArtRecReader {
            src: RefCell::new(src),
            len: self.len,
            header: self.header.clone(),
            unis: self.unis.clone(),
            index: Arc::clone(&self.index),
            dctx: RefCell::new(None),
            scratch: RefCell::new(Vec::new()),
            raw: RefCell::new(Vec::new()),
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
        let first = self.index.first()?;
        if now_us < first.time_us {
            return None;
        }
        // partition_point 返回首个 time_us > now_us 的位置
        let p = self.index.partition_point(|fi| fi.time_us <= now_us);
        Some(p - 1)
    }

    /// 取第 `i` 条帧索引。
    ///
    /// # Arguments
    ///
    /// * `i` - 帧索引下标。
    ///
    /// # Returns
    ///
    /// 该帧的索引条目（拷贝）。
    ///
    /// # Errors
    ///
    /// 下标越界返回 [`ArtRecError::FrameOutOfRange`]。
    fn entry(&self, i: usize) -> Result<FrameIndex> {
        self.index
            .get(i)
            .copied()
            .ok_or(ArtRecError::FrameOutOfRange {
                index: i,
                count: self.index.len(),
            })
    }

    /// 从绝对偏移读取恰好 `buf.len()` 字节；越界按截断处理。
    ///
    /// # Arguments
    ///
    /// * `off` - 文件内绝对偏移。
    /// * `buf` - 接收数据的缓冲，长度即读取字节数。
    /// * `what` - 越界时 [`ArtRecError::Truncated`] 携带的说明。
    ///
    /// # Errors
    ///
    /// 越界返回 [`ArtRecError::Truncated`]；底层定位 / 读取失败返回 [`ArtRecError::Io`]。
    fn read_exact_at(&self, off: u64, buf: &mut [u8], what: &'static str) -> Result<()> {
        if off + buf.len() as u64 > self.len {
            return Err(ArtRecError::Truncated(what));
        }
        let mut src = self.src.borrow_mut();
        src.seek(SeekFrom::Start(off))?;
        src.read_exact(buf)?;
        Ok(())
    }

    /// Chunk 在文件中的绝对偏移。
    ///
    /// # Arguments
    ///
    /// * `fi` - 该帧的索引条目。
    ///
    /// # Returns
    ///
    /// `chunk_pool_offset + chunk_pos`。
    fn chunk_base(&self, fi: &FrameIndex) -> u64 {
        u64::from(self.header.chunk_pool_offset) + u64::from(fi.chunk_pos)
    }

    /// 读取位于绝对偏移 `base` 的 Chunk 头。
    ///
    /// # Arguments
    ///
    /// * `base` - Chunk 在文件中的绝对偏移。
    ///
    /// # Returns
    ///
    /// 解析出的 [`ChunkHdr`]。
    ///
    /// # Errors
    ///
    /// 越界返回 [`ArtRecError::Truncated`]；底层读取失败返回 [`ArtRecError::Io`]。
    fn read_chunk_hdr_at(&self, base: u64) -> Result<ChunkHdr> {
        let mut b = [0u8; CHUNKHDR_SIZE];
        self.read_exact_at(base, &mut b, "ChunkHdr 越界")?;
        ChunkHdr::from_bytes(&b)
    }

    /// 以块头为准，单独读出压缩 Payload（旧的两次读取路径的第二步）。
    ///
    /// # Arguments
    ///
    /// * `base` - Chunk 在文件中的绝对偏移。
    /// * `hdr` - 已读出的块头（决定 Payload 长度）。
    /// * `scratch` - 暂存缓冲，Payload 被读到其开头。
    ///
    /// # Returns
    ///
    /// `(块头, Payload 在 scratch 中的区间)`。
    ///
    /// # Errors
    ///
    /// 越界返回 [`ArtRecError::Truncated`]；底层读取失败返回 [`ArtRecError::Io`]。
    fn read_payload_by_hdr(
        &self,
        base: u64,
        hdr: ChunkHdr,
        scratch: &mut Vec<u8>,
    ) -> Result<(ChunkHdr, Range<usize>)> {
        let n = usize::from(hdr.payload_cmp_sz);
        let buf = prefix_mut(scratch, n);
        self.read_exact_at(base + CHUNKHDR_SIZE as u64, buf, "Chunk Payload 越界")?;
        Ok((hdr, 0..n))
    }

    /// 把一个 Chunk 的块头与压缩 Payload 读进 `scratch`。
    ///
    /// 优先按索引的 `chunk_cmp_len` 一次读出整块，并交叉校验
    /// `payload_cmp_sz + 8 == chunk_cmp_len`；索引长度异常（不足块头、越界）或校验不一致时，
    /// 回退到"先读 8 字节块头、再按块头读 Payload"的旧路径（以块头为准），
    /// 对旧文件与异常索引的容忍度与改动前一致。
    ///
    /// # Arguments
    ///
    /// * `fi` - 该帧的索引条目。
    /// * `scratch` - 暂存缓冲（只增不减）。
    ///
    /// # Returns
    ///
    /// `(块头, 压缩 Payload 在 scratch 中的区间)`。
    ///
    /// # Errors
    ///
    /// 越界返回 [`ArtRecError::Truncated`]；底层读取失败返回 [`ArtRecError::Io`]。
    fn load_chunk(
        &self,
        fi: &FrameIndex,
        scratch: &mut Vec<u8>,
    ) -> Result<(ChunkHdr, Range<usize>)> {
        let base = self.chunk_base(fi);
        let total = usize::from(fi.chunk_cmp_len);
        if total >= CHUNKHDR_SIZE && base + total as u64 <= self.len {
            let buf = prefix_mut(scratch, total);
            self.read_exact_at(base, buf, "Chunk 越界")?;
            let hdr = ChunkHdr::from_bytes(&buf[..CHUNKHDR_SIZE])?;
            if usize::from(hdr.payload_cmp_sz) + CHUNKHDR_SIZE == total {
                return Ok((hdr, CHUNKHDR_SIZE..total));
            }
            // 索引与块头不一致：以块头为准（块头字节与旧路径读到的相同），单独读 Payload
            return self.read_payload_by_hdr(base, hdr, scratch);
        }
        let hdr = self.read_chunk_hdr_at(base)?;
        self.read_payload_by_hdr(base, hdr, scratch)
    }

    /// 读取并解压校验指定下标 Chunk 的原始 Payload，写入调用方复用的缓冲。
    ///
    /// 与 [`ArtRecReader::read_chunk`] 语义相同，但不为每帧分配新的 Payload 缓冲：
    /// `raw` 先被清空，再保证容量不小于 `payload_raw_sz`，解压结果直接写入其中。
    /// 返回错误时 `raw` 的内容未定义（可能为空或残留部分数据）。
    ///
    /// # Arguments
    ///
    /// * `i` - 帧索引下标。
    /// * `raw` - 接收解压后原始 Payload 的缓冲（跨帧复用）。
    ///
    /// # Returns
    ///
    /// 该 Chunk 的 [`ChunkHdr`]；原始 Payload 位于 `raw`。
    ///
    /// # Errors
    ///
    /// - 下标越界返回 [`ArtRecError::FrameOutOfRange`]。
    /// - 块头或 Payload 超出文件范围返回 [`ArtRecError::Truncated`]；底层读失败返回 [`ArtRecError::Io`]。
    /// - Zstd 解码失败，或解压长度不等于 `payload_raw_sz`，返回 [`ArtRecError::Decompress`]。
    /// - CRC 不符返回 [`ArtRecError::CrcMismatch`]。
    pub fn read_chunk_into(&self, i: usize, raw: &mut Vec<u8>) -> Result<ChunkHdr> {
        let fi = self.entry(i)?;
        let mut scratch = self.scratch.borrow_mut();
        let (hdr, range) = self.load_chunk(&fi, &mut scratch)?;
        let payload = &scratch[range];
        match self.header.compress_algo {
            CompressAlgo::None => {
                raw.clear();
                raw.extend_from_slice(payload);
            }
            CompressAlgo::Zstd => {
                let mut slot = self.dctx.borrow_mut();
                let dctx = match &mut *slot {
                    Some(d) => d,
                    None => slot.insert(Decompressor::new()?),
                };
                decompress_into(dctx, payload, usize::from(hdr.payload_raw_sz), raw)?;
            }
        }
        let actual = crc16_ccitt(raw);
        if actual != hdr.crc16 {
            return Err(ArtRecError::CrcMismatch {
                expected: hdr.crc16,
                actual,
            });
        }
        Ok(hdr)
    }

    /// 读取并解压校验指定下标 Chunk 的原始 Payload。
    ///
    /// 每次返回新分配的 Payload；循环读帧请用 [`ArtRecReader::read_chunk_into`] 复用缓冲。
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
    /// 见 [`ArtRecReader::read_chunk_into`]（CRC 不符返回 [`ArtRecError::CrcMismatch`]，
    /// 解压失败返回 [`ArtRecError::Decompress`]）。
    pub fn read_chunk(&self, i: usize) -> Result<(ChunkHdr, Vec<u8>)> {
        let mut raw = Vec::new();
        let hdr = self.read_chunk_into(i, &mut raw)?;
        Ok((hdr, raw))
    }

    /// 回溯到 `<= i` 的最近全量帧下标。
    ///
    /// 文件未置 ALLOW_DIFF_FRAME 时规范保证每帧都是全量帧，直接返回 `i`，不读盘；
    /// 若这类文件中实际出现了差分帧，会在应用该帧时由 [`ArtRecReader::apply_chunk_into`]
    /// （及 [`ArtRecReader::apply_chunk`]、[`ArtRecReader::resolve_frame`]）返回
    /// [`ArtRecError::DiffFrameNotAllowed`]。置位时逐帧读块头向前回溯；
    /// 回溯到首帧仍是差分帧时返回 0。
    ///
    /// # Arguments
    ///
    /// * `i` - 起始帧下标，从该帧向前回溯。
    ///
    /// # Returns
    ///
    /// `<= i` 的最近全量帧下标；未置 ALLOW_DIFF_FRAME 时恒为 `i`；
    /// 若一直回溯到首帧仍是差分帧则返回 `0`。
    ///
    /// # Errors
    ///
    /// - 下标越界返回 [`ArtRecError::FrameOutOfRange`]。
    /// - 回溯途中 Chunk 头读取失败返回 [`ArtRecError::Truncated`] / [`ArtRecError::Io`]。
    pub fn keyframe_at_or_before(&self, i: usize) -> Result<usize> {
        if i >= self.index.len() {
            return Err(ArtRecError::FrameOutOfRange {
                index: i,
                count: self.index.len(),
            });
        }
        if !self.header.allows_diff() {
            return Ok(i);
        }
        let mut k = i;
        loop {
            let hdr = self.read_chunk_hdr_at(self.chunk_base(&self.entry(k)?))?;
            if hdr.chunk_type == CHUNK_FULL || k == 0 {
                return Ok(k);
            }
            k -= 1;
        }
    }

    /// 由单个 Chunk 的原始 Payload 在给定缓冲基础上就地推进一帧。
    ///
    /// 全量帧覆盖全部缓冲，差分帧在 `buffers` 上原地修改；内部与
    /// [`ArtRecReader::apply_chunk_into`] 相同（全量帧尽量原地拷贝，不重新分配）。
    ///
    /// # Arguments
    ///
    /// * `buffers` - 各路 DMX 缓冲，就地被更新。
    /// * `hdr` - 该 Chunk 的头，用于区分全量帧与差分帧。
    /// * `raw` - 该 Chunk 解压后的原始 Payload。
    ///
    /// # Errors
    ///
    /// 见 [`ArtRecReader::apply_chunk_into`]。
    pub fn apply_chunk(
        &self,
        buffers: &mut Vec<Vec<u8>>,
        hdr: &ChunkHdr,
        raw: &[u8],
    ) -> Result<()> {
        self.apply_chunk_into(buffers, hdr, raw)
    }

    /// 由单个 Chunk 的原始 Payload 原地推进一帧，尽量复用已有缓冲。
    ///
    /// - 全量帧：各路切片 `copy_from_slice` 进已有缓冲；只有路数或某路长度与 UniDesc
    ///   不符时才调整对应缓冲。结果与 [`crate::split_full`] 整体替换完全相同。
    /// - 差分帧：文件须置 ALLOW_DIFF_FRAME，在 `buffers` 上原地应用变更点
    ///   （越界的 Universe / 通道被忽略），行为同 [`ArtRecReader::apply_chunk`]。
    ///
    /// 返回错误时 `buffers` 保持不变。
    ///
    /// # Arguments
    ///
    /// * `buffers` - 各路 DMX 缓冲，就地被更新。
    /// * `hdr` - 该 Chunk 的头，用于区分全量帧与差分帧。
    /// * `raw` - 该 Chunk 解压后的原始 Payload。
    ///
    /// # Errors
    ///
    /// - 全量帧 Payload 总长与 UniDesc 不符返回 [`ArtRecError::PayloadLenMismatch`]。
    /// - 差分帧而文件未置 ALLOW_DIFF_FRAME 返回 [`ArtRecError::DiffFrameNotAllowed`]。
    /// - 差分记录截断返回 [`ArtRecError::Truncated`]。
    pub fn apply_chunk_into(
        &self,
        buffers: &mut Vec<Vec<u8>>,
        hdr: &ChunkHdr,
        raw: &[u8],
    ) -> Result<()> {
        if hdr.chunk_type == CHUNK_FULL {
            split_full_into(&self.unis, raw, buffers)
        } else if self.header.allows_diff() {
            apply_diff_payload(buffers, raw)
        } else {
            Err(ArtRecError::DiffFrameNotAllowed)
        }
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
            .map(|u| vec![0u8; usize::from(u.dmx_len)])
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
    /// - 下标越界返回 [`ArtRecError::FrameOutOfRange`]。
    /// - 差分帧出现但未置 ALLOW_DIFF_FRAME 返回 [`ArtRecError::DiffFrameNotAllowed`]。
    /// - 读取/解压/CRC 失败见 [`ArtRecReader::read_chunk_into`]。
    pub fn resolve_frame(&self, i: usize) -> Result<Vec<Vec<u8>>> {
        let start = self.keyframe_at_or_before(i)?;
        let mut buffers = self.zero_buffers();
        let mut raw = self.raw.borrow_mut();
        for k in start..=i {
            let hdr = self.read_chunk_into(k, &mut raw)?;
            self.apply_chunk_into(&mut buffers, &hdr, &raw)?;
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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::ArtRecReader;
    use crate::error::ArtRecError;
    use crate::model::{ChunkHdr, CompressAlgo, UniDesc, CHUNK_DIFF, CHUNK_FULL, FLAG_DIFF_FRAME};
    use crate::payload::DiffChange;
    use crate::writer::ArtRecWriter;

    fn unis() -> Vec<UniDesc> {
        vec![UniDesc::new(0, 0, 512), UniDesc::new(0, 1, 512)]
    }

    /// 写一个 "全量, 差分, 差分, 全量, 差分" 的节目（`flags` 由调用方决定是否置位差分）。
    fn mixed(flags: u32, algo: CompressAlgo) -> Vec<u8> {
        let mut w = ArtRecWriter::new(Cursor::new(Vec::new()), unis(), algo, 3, flags, 0).unwrap();
        let mut f = vec![vec![0u8; 512]; 2];
        f[0][0] = 1;
        w.add_full_frame(0, &f).unwrap();
        w.add_diff_frame(
            10,
            &[DiffChange {
                uni_idx: 0,
                ch_addr: 1,
                ch_val: 2,
            }],
        )
        .unwrap();
        w.add_diff_frame(
            20,
            &[DiffChange {
                uni_idx: 1,
                ch_addr: 2,
                ch_val: 3,
            }],
        )
        .unwrap();
        f[0][0] = 4;
        w.add_full_frame(30, &f).unwrap();
        w.add_diff_frame(
            40,
            &[DiffChange {
                uni_idx: 0,
                ch_addr: 0,
                ch_val: 5,
            }],
        )
        .unwrap();
        w.finish(40).unwrap().into_inner()
    }

    #[test]
    fn keyframe_scan_when_diff_allowed() {
        let r = ArtRecReader::open(mixed(FLAG_DIFF_FRAME, CompressAlgo::Zstd)).unwrap();
        let got: Vec<usize> = (0..5)
            .map(|i| r.keyframe_at_or_before(i).unwrap())
            .collect();
        assert_eq!(got, [0, 0, 0, 3, 3]);
        let f2 = r.resolve_frame(2).unwrap();
        assert_eq!((f2[0][0], f2[0][1], f2[1][2]), (1, 2, 3));
        let f4 = r.resolve_frame(4).unwrap();
        // 第 3 帧为全量帧：之前差分帧的修改被覆盖
        assert_eq!((f4[0][0], f4[0][1], f4[1][2]), (5, 0, 0));
    }

    #[test]
    fn diff_frame_without_flag_is_rejected_on_apply() {
        let r = ArtRecReader::open(mixed(0, CompressAlgo::None)).unwrap();
        // 未置位：不读盘，直接认定为关键帧
        for i in 0..5 {
            assert_eq!(r.keyframe_at_or_before(i).unwrap(), i);
        }
        // 全量帧照常解析
        assert_eq!(r.resolve_frame(3).unwrap()[0][0], 4);
        // 差分帧在应用时被拒绝（规范：未置 ALLOW_DIFF_FRAME 却出现差分帧必须拒绝）
        assert!(matches!(
            r.resolve_frame(1),
            Err(ArtRecError::DiffFrameNotAllowed)
        ));
        assert!(matches!(
            r.frame_at(45),
            Err(ArtRecError::DiffFrameNotAllowed)
        ));
        let (hdr, raw) = r.read_chunk(2).unwrap();
        assert_eq!(hdr.chunk_type, CHUNK_DIFF);
        let mut b = r.zero_buffers();
        assert!(matches!(
            r.apply_chunk(&mut b, &hdr, &raw),
            Err(ArtRecError::DiffFrameNotAllowed)
        ));
        assert!(matches!(
            r.apply_chunk_into(&mut b, &hdr, &raw),
            Err(ArtRecError::DiffFrameNotAllowed)
        ));
        assert_eq!(b, r.zero_buffers(), "被拒绝的差分帧不得修改缓冲");
    }

    #[test]
    fn out_of_range_index_is_an_error_not_a_panic() {
        let r = ArtRecReader::open(mixed(FLAG_DIFF_FRAME, CompressAlgo::Zstd)).unwrap();
        let oob = |e| matches!(e, ArtRecError::FrameOutOfRange { index: 5, count: 5 });
        assert!(oob(r.read_chunk(5).unwrap_err()));
        assert!(oob(r.read_chunk_into(5, &mut Vec::new()).unwrap_err()));
        assert!(oob(r.keyframe_at_or_before(5).unwrap_err()));
        assert!(oob(r.resolve_frame(5).unwrap_err()));
    }

    #[test]
    fn read_chunk_into_reuses_buffer_and_matches_read_chunk() {
        for algo in [CompressAlgo::None, CompressAlgo::Zstd] {
            let r = ArtRecReader::open(mixed(FLAG_DIFF_FRAME, algo)).unwrap();
            let mut raw = Vec::new();
            // 先读大帧再读小帧，再读大帧：缓冲复用后内容必须与一次性读取一致
            for i in [0usize, 1, 3, 2, 4, 0] {
                let hdr = r.read_chunk_into(i, &mut raw).unwrap();
                let (hdr2, raw2) = r.read_chunk(i).unwrap();
                assert_eq!(hdr, hdr2);
                assert_eq!(raw, raw2, "{algo:?} i={i}");
                assert_eq!(raw.len(), usize::from(hdr.payload_raw_sz));
            }
        }
    }

    #[test]
    fn apply_chunk_into_rebuilds_only_when_shape_differs() {
        let r = ArtRecReader::open(mixed(FLAG_DIFF_FRAME, CompressAlgo::Zstd)).unwrap();
        let (hdr, raw) = r.read_chunk(3).unwrap();
        assert_eq!(hdr.chunk_type, CHUNK_FULL);
        let want = crate::payload::split_full(r.unis(), &raw).unwrap();

        // 形状一致：原地拷贝，不换底层分配
        let mut b = r.zero_buffers();
        let ptrs: Vec<*const u8> = b.iter().map(Vec::as_ptr).collect();
        r.apply_chunk_into(&mut b, &hdr, &raw).unwrap();
        assert_eq!(b, want);
        assert_eq!(ptrs, b.iter().map(Vec::as_ptr).collect::<Vec<_>>());

        // 路数 / 长度不符：重建为正确形状
        for mut b in [Vec::new(), vec![vec![9u8; 3]; 7], vec![vec![0u8; 512]]] {
            r.apply_chunk_into(&mut b, &hdr, &raw).unwrap();
            assert_eq!(b, want);
        }

        // Payload 长度非法：报错且不修改缓冲
        let mut b = r.zero_buffers();
        let bad = ChunkHdr {
            payload_raw_sz: 3,
            ..hdr
        };
        assert!(matches!(
            r.apply_chunk_into(&mut b, &bad, &raw[..3]),
            Err(ArtRecError::PayloadLenMismatch { .. })
        ));
        assert_eq!(b, r.zero_buffers());
    }

    #[test]
    fn readers_are_send() {
        fn assert_send<T: Send>() {}
        assert_send::<ArtRecReader>();
        assert_send::<ArtRecReader<std::fs::File>>();
        assert_send::<ArtRecReader<crate::ReadAhead<std::fs::File>>>();
        assert_send::<ArtRecWriter<std::fs::File>>();
    }
}
