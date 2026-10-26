//! 顺序帧遍历器：按时间顺序逐帧解码并维护当前各路 DMX 状态。
//!
//! 概览与曲线分析都需要"把整段（或一段）节目逐帧还原"；遍历器统一处理全量帧 / 差分帧，
//! 并按规范 §11 的"演出容错"策略：CRC 或解压失败的帧被跳过、继续沿用上一帧数据。
//!
//! # 损坏帧语义
//!
//! 每一帧都经 [`ArtRecReader::read_chunk_into`] 读出并校验，再经
//! [`ArtRecReader::apply_chunk_into`] 应用到当前状态。任一步失败（越界 / 截断 / IO、
//! 解压失败、CRC 不符、全量帧长度与 UniDesc 不符、未置 ALLOW_DIFF_FRAME 却出现差分帧、
//! 差分记录截断）都算"跳过"：状态保持上一帧不变，[`FrameWalker::skipped`] 加一，
//! 但该帧仍被"产出"（[`FrameWalker::advance`] 照常返回它的时间戳）。
//! 是否跳过只取决于该帧自身的字节与文件头标志，与之前的状态无关。

use std::io::{Read, Seek};

use artrec_core::ArtRecReader;

/// 读取并把第 `k` 帧应用到 `buffers`（遍历器与并行扫描共用的单步）。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `k` - 帧下标。
/// * `raw` - 跨帧复用的原始 Payload 缓冲。
/// * `buffers` - 各路 DMX 状态，成功时就地推进一帧，失败时保持不变。
///
/// # Returns
///
/// 读取、校验与应用都成功返回 `true`；任一步失败（该帧应被跳过）返回 `false`。
pub(crate) fn apply_frame<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    k: usize,
    raw: &mut Vec<u8>,
    buffers: &mut Vec<Vec<u8>>,
) -> bool {
    match reader.read_chunk_into(k, raw) {
        Ok(hdr) => reader.apply_chunk_into(buffers, &hdr, raw).is_ok(),
        Err(_) => false,
    }
}

/// 顺序帧遍历器。
///
/// 内部复用一份原始 Payload 缓冲与各路 DMX 缓冲，逐帧推进时不再分配。
pub struct FrameWalker<'a, R: Read + Seek> {
    reader: &'a ArtRecReader<R>,
    next: usize,
    buffers: Vec<Vec<u8>>,
    raw: Vec<u8>,
    skipped: u64,
}

impl<'a, R: Read + Seek> FrameWalker<'a, R> {
    /// 从第 `start` 帧开始遍历（会先回溯到最近的全量帧重建状态，`start` 帧本身会被产出）。
    ///
    /// # Arguments
    ///
    /// * `reader` - 已打开的节目。
    /// * `start` - 起始帧下标；不小于帧总数时遍历器直接处于末尾。
    ///
    /// # Returns
    ///
    /// 已重建好 `start` 之前状态的遍历器，下一次 [`FrameWalker::advance`] 将产出第 `start` 帧。
    #[must_use]
    pub fn from_frame(reader: &'a ArtRecReader<R>, start: usize) -> Self {
        let mut w = Self::resume(reader, 0, reader.zero_buffers());
        if start >= reader.index().len() {
            w.next = reader.index().len();
            return w;
        }
        // 先在 `start` 之前重建状态：从最近全量帧推进到 start-1
        let kf = reader.keyframe_at_or_before(start).unwrap_or(0);
        w.next = kf;
        while w.next < start {
            w.step();
        }
        w
    }

    /// 以给定状态为起点，从第 `next` 帧继续遍历（不回溯、不重建状态）。
    ///
    /// 并行扫描用：调用方已确定第 `next` 帧之前的状态与串行遍历完全一致。
    ///
    /// # Arguments
    ///
    /// * `reader` - 已打开的节目。
    /// * `next` - 下一次 [`FrameWalker::advance`] 要产出的帧下标。
    /// * `buffers` - 第 `next` 帧之前的各路 DMX 状态（形状须与 UniDesc 一致）。
    ///
    /// # Returns
    ///
    /// 跳过计数为 0、位于第 `next` 帧之前的遍历器。
    pub(crate) fn resume(reader: &'a ArtRecReader<R>, next: usize, buffers: Vec<Vec<u8>>) -> Self {
        Self {
            reader,
            next,
            buffers,
            raw: Vec::new(),
            skipped: 0,
        }
    }

    /// 从第一帧开始遍历。
    ///
    /// # Arguments
    ///
    /// * `reader` - 已打开的节目。
    ///
    /// # Returns
    ///
    /// 位于第一帧之前、各路状态全零的遍历器。
    #[must_use]
    pub fn new(reader: &'a ArtRecReader<R>) -> Self {
        Self::from_frame(reader, 0)
    }

    /// 应用下一个 Chunk；失败的帧计入 `skipped` 并沿用上一帧。
    ///
    /// # Returns
    ///
    /// 该帧成功应用返回 `true`，被跳过返回 `false`。
    fn step(&mut self) -> bool {
        let k = self.next;
        self.next += 1;
        let ok = apply_frame(self.reader, k, &mut self.raw, &mut self.buffers);
        if !ok {
            self.skipped += 1;
        }
        ok
    }

    /// 推进一帧。
    ///
    /// # Returns
    ///
    /// 新应用帧的时间戳（微秒）；已到末尾返回 `None`。之后可用 [`FrameWalker::buffers`] 读取状态。
    pub fn advance(&mut self) -> Option<u64> {
        self.advance_applied().map(|(t, _)| t)
    }

    /// 推进一帧，并报告该帧是否成功应用。
    ///
    /// # Returns
    ///
    /// `Some((时间戳, 是否成功应用))`；被跳过的帧返回 `false`，此时状态与上一帧相同。
    /// 已到末尾返回 `None`。
    pub(crate) fn advance_applied(&mut self) -> Option<(u64, bool)> {
        let t = self.reader.index().get(self.next)?.time_us;
        let ok = self.step();
        Some((t, ok))
    }

    /// 下一次 [`FrameWalker::advance`] 将产出的帧下标。
    ///
    /// # Returns
    ///
    /// 帧下标；已到末尾时等于帧总数。
    pub(crate) fn position(&self) -> usize {
        self.next
    }

    /// 取出当前各路状态。
    ///
    /// # Returns
    ///
    /// 遍历到当前位置为止的各路 DMX 缓冲。
    pub(crate) fn into_buffers(self) -> Vec<Vec<u8>> {
        self.buffers
    }

    /// 下一帧的时间戳（不推进）；已到末尾返回 `None`。
    ///
    /// # Returns
    ///
    /// 下一帧的时间戳（微秒）；已无后续帧时返回 `None`。
    #[must_use]
    pub fn peek_time(&self) -> Option<u64> {
        self.reader.index().get(self.next).map(|f| f.time_us)
    }

    /// 当前各路 DMX 状态（与 UniDesc 顺序一致）。
    ///
    /// # Returns
    ///
    /// 各路 Universe 当前缓冲的只读切片，顺序与 UniDesc 一致。
    #[must_use]
    pub fn buffers(&self) -> &[Vec<u8>] {
        &self.buffers
    }

    /// 已被跳过（损坏）的帧数。
    ///
    /// # Returns
    ///
    /// 因读取或应用失败而被跳过的帧累计数量。
    #[must_use]
    pub fn skipped(&self) -> u64 {
        self.skipped
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    //! 测试用节目构造器。

    use std::io::Cursor;

    use artrec_core::{
        ArtRecReader, ArtRecWriter, CompressAlgo, DiffChange, UniDesc, FLAG_DIFF_FRAME,
    };

    /// 一帧描述：`(时间 us, [(universe 下标, 通道, 值)])`，基于上一帧的"全量"状态构造。
    pub type FrameSpec = (u64, Vec<(usize, usize, u8)>);

    /// 构造含 `n_uni` 路 Universe（编号 0..n）的内存节目；每帧为全量帧。
    pub fn build_full(
        n_uni: usize,
        frames: &[FrameSpec],
        total_us: u64,
        algo: CompressAlgo,
    ) -> Vec<u8> {
        let unis: Vec<UniDesc> = (0..n_uni as u16)
            .map(|u| UniDesc::from_universe(u, 512).unwrap())
            .collect();
        let mut w = ArtRecWriter::new(Cursor::new(Vec::new()), unis, algo, 1, 0, 0).unwrap();
        let mut cur = vec![vec![0u8; 512]; n_uni];
        for (t, edits) in frames {
            for &(u, ch, v) in edits {
                cur[u][ch] = v;
            }
            w.add_full_frame(*t, &cur).unwrap();
        }
        w.finish(total_us).unwrap().into_inner()
    }

    /// 构造首帧全量、其余为差分帧的节目（启用 ALLOW_DIFF_FRAME）。
    pub fn build_diff(n_uni: usize, frames: &[FrameSpec], total_us: u64) -> Vec<u8> {
        let unis: Vec<UniDesc> = (0..n_uni as u16)
            .map(|u| UniDesc::from_universe(u, 512).unwrap())
            .collect();
        let mut w = ArtRecWriter::new(
            Cursor::new(Vec::new()),
            unis,
            CompressAlgo::None,
            0,
            FLAG_DIFF_FRAME,
            0,
        )
        .unwrap();
        let mut cur = vec![vec![0u8; 512]; n_uni];
        for (i, (t, edits)) in frames.iter().enumerate() {
            for &(u, ch, v) in edits {
                cur[u][ch] = v;
            }
            if i == 0 {
                w.add_full_frame(*t, &cur).unwrap();
            } else {
                let changes: Vec<DiffChange> = edits
                    .iter()
                    .map(|&(u, ch, v)| DiffChange {
                        uni_idx: u as u16,
                        ch_addr: ch as u16,
                        ch_val: v,
                    })
                    .collect();
                w.add_diff_frame(*t, &changes).unwrap();
            }
        }
        w.finish(total_us).unwrap().into_inner()
    }

    pub fn open(bytes: Vec<u8>) -> ArtRecReader {
        ArtRecReader::open(bytes).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use artrec_core::CompressAlgo;

    use super::testkit::{build_diff, build_full, open};
    use super::FrameWalker;

    #[test]
    fn walks_full_frames_in_order() {
        let bytes = build_full(
            2,
            &[
                (0, vec![(0, 0, 10)]),
                (100, vec![(1, 5, 50)]),
                (200, vec![(0, 0, 99)]),
            ],
            200,
            CompressAlgo::Zstd,
        );
        let r = open(bytes);
        let mut w = FrameWalker::new(&r);
        assert_eq!(w.advance(), Some(0));
        assert_eq!(w.buffers()[0][0], 10);
        assert_eq!(w.advance(), Some(100));
        assert_eq!(w.buffers()[1][5], 50);
        assert_eq!(w.advance(), Some(200));
        assert_eq!(w.buffers()[0][0], 99);
        assert_eq!(w.advance(), None);
        assert_eq!(w.skipped(), 0);
    }

    #[test]
    fn diff_frames_accumulate_and_start_mid_stream() {
        let bytes = build_diff(
            1,
            &[
                (0, vec![(0, 1, 1)]),
                (10, vec![(0, 2, 2)]),
                (20, vec![(0, 3, 3)]),
                (30, vec![(0, 1, 9)]),
            ],
            30,
        );
        let r = open(bytes);
        // 从第 2 帧开始：先重建 0..=1 的状态，再产出第 2 帧
        let mut w = FrameWalker::from_frame(&r, 2);
        assert_eq!(w.advance(), Some(20));
        let b = &w.buffers()[0];
        assert_eq!((b[1], b[2], b[3]), (1, 2, 3));
        assert_eq!(w.advance(), Some(30));
        assert_eq!(w.buffers()[0][1], 9);
    }

    #[test]
    fn corrupted_chunk_is_skipped_and_previous_state_kept() {
        let bytes = build_full(
            1,
            &[
                (0, vec![(0, 0, 5)]),
                (10, vec![(0, 0, 6)]),
                (20, vec![(0, 0, 7)]),
            ],
            20,
            CompressAlgo::None,
        );
        let r0 = open(bytes.clone());
        let pool = r0.header().chunk_pool_offset as usize;
        let second = pool + r0.index()[1].chunk_pos as usize + artrec_core::CHUNKHDR_SIZE;
        let mut bad = bytes;
        bad[second] ^= 0xFF; // 第二帧 payload 首字节 → CRC 失败
        let r = open(bad);

        let mut w = FrameWalker::new(&r);
        w.advance();
        w.advance(); // 第二帧损坏：跳过
        assert_eq!(w.buffers()[0][0], 5, "损坏帧不应改变状态");
        assert_eq!(w.skipped(), 1);
        w.advance();
        assert_eq!(w.buffers()[0][0], 7);
    }

    #[test]
    fn start_beyond_end_yields_nothing() {
        let r = open(build_full(1, &[(0, vec![])], 0, CompressAlgo::None));
        let mut w = FrameWalker::from_frame(&r, 99);
        assert_eq!(w.advance(), None);
    }
}
