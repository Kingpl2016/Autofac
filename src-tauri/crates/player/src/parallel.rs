//! 概览与通道曲线的并行扫描（模块级专用 rayon 线程池，不占用 rayon 全局池）。
//!
//! # 适用范围
//!
//! 只对**未置 ALLOW_DIFF_FRAME** 的文件并行：规范保证这类文件每帧都是独立的全量帧，
//! 某帧之后的状态只取决于"该帧及之前最后一个成功应用的帧"，可以从任意位置开始解码。
//! 允许差分的文件、帧数少于 [`PARALLEL_MIN_FRAMES`] 的扫描、线程池不可用或只有一个
//! 工作线程时，回落到串行实现（仍经顺序预读数据源读帧）。
//!
//! # 与串行逐字节一致的保证
//!
//! 串行遍历器对每帧要么"成功应用"（全量帧整体覆盖状态），要么"跳过"（状态不变），
//! 而是否跳过只取决于该帧自身的字节与文件头标志（见 [`crate::walker`]）。因此串行算法
//! 在第 `a` 帧之前的状态 = 第 `a` 帧之前**最后一个成功应用的帧**解码出的状态；没有这样的帧
//! 时为全零。各段按如下方式取得与串行完全相同的段首状态，再独立执行与串行相同的逐帧累积：
//!
//! 1. 探测 + 累积（并行）：第 `s` 段在第 `s-1` 段的帧范围内从后往前找最后一个可成功应用的帧
//!    （通常第一帧就命中），解码结果即段首状态，随即在同一任务里从段首开始累积；
//!    第 0 段的段首状态恒为全零（曲线查询为区间起点状态）。
//! 2. 串接（罕见，调用线程）：探测落空说明第 `s-1` 段整段都是坏帧，于是
//!    段首状态(s) = 段首状态(s-1) = 段末状态(s-1)；按段序取前一段的段末状态
//!    （前一段若也落空，此时已被赋成它的段首状态），再并行补跑这些段。
//! 3. 合并：各段结果按"计数饱和相加、电平取最大"并入全局矩阵（见 [`crate::overview`]
//!    中累积器的说明），损坏帧计数各段求和，最后统一按全局最大计数映射强度。
//!
//! 概览段的 `last_b` 初值取"段首前一帧所在的桶"——串行算法对被跳过的帧同样推进 `last_b`，
//! 所以这正是串行在段首之前的值；"最后一帧之后的桶延续最终状态"只由最后一段处理。
//! 曲线按桶边界切段（按帧数均衡），段首状态是该桶起点处的串行状态，桶内逐帧逻辑与串行
//! 共用同一函数。曲线的串行实现在区间起点帧损坏时从全零开始、不回看更早的帧，
//! 因此第 0 段只探测区间起点帧本身。
//!
//! 读取器不是 `Sync`：每段的读取器都在调用线程上经 [`ArtRecReader::with_source`] 建好
//! （各自的文件句柄、顺序预读窗口与解压上下文；文件句柄与预读窗口这类不涉及读取器的准备
//! 工作在线程池里并行完成），再以 `&mut` 移交给工作线程；工作线程从不触碰调用方传入的读取器。

use std::fs::File;
use std::io::{Read, Seek};
use std::num::NonZeroUsize;
use std::ops::Range;
use std::path::Path;
use std::sync::OnceLock;

use artrec_core::{ArtRecError, ArtRecReader, FrameIndex, ReadAhead};
use rayon::prelude::*;

use crate::overview::{
    assemble_overview, bucket_of, build_overview, BucketAccum, Overview, MAX_BUCKETS, MIN_BUCKETS,
};
use crate::series::{
    run_buckets, series_serial, ChannelSeries, SeriesError, SeriesQuery, UniTrack,
};
use crate::walker::{apply_frame, FrameWalker};

/// 待扫描帧数低于该值时，并行函数直接走串行（分段、开文件与线程调度的固定开销不划算）。
pub const PARALLEL_MIN_FRAMES: usize = 2000;
/// 自动分段时每个工作线程分到的段数（多切几段以平衡各段解码耗时的差异）。
const SEGMENTS_PER_THREAD: usize = 3;
/// 自动分段时每段至少包含的帧数。
const MIN_SEGMENT_FRAMES: usize = 64;
/// 顺序预读窗口上限（1 MiB）。
const READ_AHEAD: usize = 1 << 20;
/// 每段预读窗口下限；窗口按段内 Chunk 字节跨度收缩，避免短段整窗预读浪费。
const MIN_WINDOW: usize = 64 << 10;
/// 窗口在段字节跨度之外的余量（容纳一个最大 Chunk）。
const WINDOW_SLACK: usize = 64 << 10;
/// 探测阶段倒序分块的最大块长（帧）。
const PROBE_MAX_BLOCK: usize = 64;

/// 工作线程使用的读取器：独立文件句柄 + 顺序预读。
type ScanReader = ArtRecReader<ReadAhead<File>>;

/// 并行扫描错误。
#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    /// 曲线查询参数非法（Universe 不存在或通道过多），与 [`crate::channel_series`] 相同。
    #[error(transparent)]
    Series(#[from] SeriesError),
    /// 按路径重新打开节目文件失败。
    #[error("打开节目文件失败: {0}")]
    Open(#[from] std::io::Error),
    /// 为扫描建立共享索引的读取器失败（如路径指向的文件长度与已打开的节目不一致）。
    #[error("建立扫描读取器失败: {0}")]
    Reader(#[from] ArtRecError),
}

/// 并行扫描调参（测试可覆盖阈值与分段数，以便在小文件上真正走并行路径）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct Tuning {
    /// 待扫描帧数低于该值时走串行。
    pub(crate) min_frames: usize,
    /// 指定分段数；`None` 时按线程数自动选择（只有一个工作线程时走串行）。
    pub(crate) segments: Option<usize>,
}

impl Tuning {
    /// 生产默认值。
    pub(crate) const DEFAULT: Self = Self {
        min_frames: PARALLEL_MIN_FRAMES,
        segments: None,
    };
}

/// 模块级专用线程池（惰性创建，线程数 = max(1, 可用并行度 − 1)，线程名 `artrec-scan-N`）。
///
/// # Returns
///
/// 线程池；创建失败（系统无法再起线程等）返回 `None`，调用方回落串行，下次调用会重试。
pub(crate) fn scan_pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    if let Some(pool) = POOL.get() {
        return Some(pool);
    }
    let threads = std::thread::available_parallelism()
        .map_or(1, NonZeroUsize::get)
        .saturating_sub(1)
        .max(1);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("artrec-scan-{i}"))
        .build()
        .ok()?;
    // 并发首次调用时只保留先写入的线程池，多建的一个随 `pool` 一起释放
    Some(POOL.get_or_init(|| pool))
}

/// 为路径上的同一份文件建立带顺序预读的扫描读取器（必须在持有 `reader` 的线程上调用）。
///
/// # Arguments
///
/// * `reader` - 已打开的节目（提供共享的头、Universe 表与索引）。
/// * `path` - 该节目的文件路径。
/// * `window` - 预读窗口字节数。
///
/// # Returns
///
/// 拥有独立文件句柄与解压上下文、可移交给工作线程的读取器。
///
/// # Errors
///
/// 打开文件失败返回 [`ScanError::Open`]；长度与 `reader` 不一致等返回 [`ScanError::Reader`]。
fn open_scan<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    path: &Path,
    window: usize,
) -> Result<ScanReader, ScanError> {
    Ok(reader.with_source(ReadAhead::new(File::open(path)?, window))?)
}

/// 为各段建立扫描读取器：文件句柄与预读窗口（需清零分配）在线程池里并行准备
/// （不涉及读取器），随后在调用线程上逐个 [`ArtRecReader::with_source`]。
///
/// # Arguments
///
/// * `pool` - 扫描线程池。
/// * `reader` - 已打开的节目。
/// * `path` - 该节目的文件路径。
/// * `windows` - 各段的预读窗口字节数（决定段数）。
///
/// # Returns
///
/// 与 `windows` 一一对应的读取器。
///
/// # Errors
///
/// 任一文件打开失败返回 [`ScanError::Open`]；长度不一致等返回 [`ScanError::Reader`]。
fn open_segments<R: Read + Seek>(
    pool: &rayon::ThreadPool,
    reader: &ArtRecReader<R>,
    path: &Path,
    windows: &[usize],
) -> Result<Vec<ScanReader>, ScanError> {
    let sources: Vec<ReadAhead<File>> = pool.install(|| {
        windows
            .par_iter()
            .map(|&w| Ok(ReadAhead::new(File::open(path)?, w)))
            .collect::<std::io::Result<_>>()
    })?;
    sources
        .into_iter()
        .map(|src| Ok(reader.with_source(src)?))
        .collect()
}

/// 按段内 Chunk 的字节跨度选择预读窗口。
///
/// # Arguments
///
/// * `index` - 帧索引。
/// * `frames` - 该段会读取的帧范围（含探测起点）。
///
/// # Returns
///
/// `[MIN_WINDOW, READ_AHEAD]` 内的窗口字节数。
fn window_for(index: &[FrameIndex], frames: Range<usize>) -> usize {
    let first = index.get(frames.start);
    let last = frames.end.checked_sub(1).and_then(|e| index.get(e));
    let (Some(first), Some(last)) = (first, last) else {
        return MIN_WINDOW;
    };
    let end = u64::from(last.chunk_pos) + u64::from(last.chunk_cmp_len);
    let span = end.saturating_sub(u64::from(first.chunk_pos));
    usize::try_from(span)
        .unwrap_or(READ_AHEAD)
        .saturating_add(WINDOW_SLACK)
        .clamp(MIN_WINDOW, READ_AHEAD)
}

/// 在 `range` 内找最后一个可成功应用的帧，并让状态停在该帧解码后的结果。
///
/// 倒序分块探测：块长从 1 起倍增（上限 [`PROBE_MAX_BLOCK`]），块内顺序应用——全量帧文件中
/// 后成功的帧整体覆盖先成功的帧，所以块内最后一个成功帧的状态即为结果；整块都失败才继续往前，
/// 顺序读取对预读窗口友好，连续坏帧也不会退化为逐帧回填窗口。
///
/// # Arguments
///
/// * `range` - 探测的帧范围。
/// * `apply` - 应用第 `k` 帧：成功时整体覆盖状态并返回 `true`，失败时状态不变并返回 `false`。
///
/// # Returns
///
/// 找到返回 `true`（状态为该帧）；整个范围都失败返回 `false`（状态未变）。
fn probe_last_good(range: Range<usize>, mut apply: impl FnMut(usize) -> bool) -> bool {
    let mut end = range.end;
    let mut block = 1usize;
    while end > range.start {
        let start = end.saturating_sub(block).max(range.start);
        let mut found = false;
        for k in start..end {
            // 不短路：块内每帧都要应用，状态才会停在最后一个成功帧
            found |= apply(k);
        }
        if found {
            return true;
        }
        end = start;
        block = (block * 2).min(PROBE_MAX_BLOCK);
    }
    false
}

/// 选择分段数。
///
/// # Arguments
///
/// * `pool` - 扫描线程池。
/// * `work` - 待扫描帧数。
/// * `tuning` - 调参。
///
/// # Returns
///
/// 指定分段数时钳制到 `[1, max(work, 1)]`；自动时为"线程数 × 每线程段数"并保证每段帧数
/// 不少于 [`MIN_SEGMENT_FRAMES`]，结果不足 2 段（或只有一个工作线程）返回 `None` 表示走串行。
fn segment_count(pool: &rayon::ThreadPool, work: usize, tuning: &Tuning) -> Option<usize> {
    if let Some(p) = tuning.segments {
        return Some(p.clamp(1, work.max(1)));
    }
    let threads = pool.current_num_threads();
    if threads < 2 {
        return None;
    }
    let p = (threads * SEGMENTS_PER_THREAD).min(work / MIN_SEGMENT_FRAMES);
    (p >= 2).then_some(p)
}

/// 用多线程扫描整段节目生成概览，结果与 [`build_overview`] 逐字节一致。
///
/// 只对未置 ALLOW_DIFF_FRAME 的文件并行；允许差分、帧数少于 [`PARALLEL_MIN_FRAMES`]
/// 或线程池不可用时回落串行。无论哪条路径，帧数据都经 `path` 重新打开的顺序预读数据源
/// 读取，`reader` 只提供已解析的头、Universe 表与索引（不会被工作线程访问）。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `path` - 该节目的文件路径，必须与 `reader` 是同一份文件内容。
/// * `buckets` - 期望桶数，会被钳制到 `[MIN_BUCKETS, MAX_BUCKETS]`。
///
/// # Returns
///
/// 概览数据。损坏的帧被跳过并计数，不会让扫描失败。
///
/// # Errors
///
/// - 按 `path` 打开文件失败返回 [`ScanError::Open`]。
/// - `path` 上的文件长度与 `reader` 不一致等返回 [`ScanError::Reader`]。
pub fn build_overview_parallel<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    path: &Path,
    buckets: u32,
) -> Result<Overview, ScanError> {
    overview_with(reader, path, buckets, &Tuning::DEFAULT)
}

/// 概览分段：读取器、负责的帧范围、探测范围、状态与结果。
struct OverviewSeg {
    /// 本段专用读取器。
    reader: ScanReader,
    /// 本段负责累积的帧范围。
    frames: Range<usize>,
    /// 探测范围（前一段的帧范围；第 0 段为空）。
    probe: Range<usize>,
    /// 累积前为段首之前的各路状态；累积后为段末状态（即下一段的段首状态）。
    state: Vec<Vec<u8>>,
    /// 探测用的原始 Payload 缓冲。
    raw: Vec<u8>,
    /// 段首状态是否已确定（第 0 段恒确定，其余段探测命中才确定）。
    ready: bool,
    /// 累积结果：`(累积器, 本段被跳过的帧数)`。
    out: Option<(BucketAccum, u64)>,
}

impl OverviewSeg {
    /// 第一阶段：建立全零状态并探测段首状态；已确定则立即累积。
    ///
    /// # Arguments
    ///
    /// * `first` - 是否为第 0 段（段首状态恒为全零）。
    /// * `nb` - 全局桶数。
    /// * `duration` - 节目总时长（微秒）。
    /// * `last` - 是否为最后一段。
    fn probe_and_run(&mut self, first: bool, nb: usize, duration: u64, last: bool) {
        let Self {
            reader,
            probe,
            state,
            raw,
            ..
        } = self;
        let reader = &*reader;
        *state = reader.zero_buffers();
        let found = probe_last_good(probe.clone(), |k| apply_frame(reader, k, raw, state));
        self.ready = first || found;
        if self.ready {
            self.run(nb, duration, last);
        }
    }

    /// 从段首开始执行串行累积，结果写入 `out`，`state` 换成段末状态。
    ///
    /// # Arguments
    ///
    /// * `nb` - 全局桶数。
    /// * `duration` - 节目总时长（微秒）。
    /// * `last` - 是否为最后一段（负责末尾延续）。
    fn run(&mut self, nb: usize, duration: u64, last: bool) {
        let index = self.reader.index();
        let bucket = |k: usize| {
            index
                .get(k)
                .map_or(0, |f| bucket_of(f.time_us, duration, nb))
        };
        let (a, b) = (self.frames.start, self.frames.end);
        // 串行在段首之前的 last_b：前一帧（无论是否被跳过）所在的桶
        let last_b = a.checked_sub(1).map_or(0, &bucket);
        let hi = if last {
            nb - 1
        } else {
            bucket(b.saturating_sub(1))
        };
        let state = std::mem::take(&mut self.state);
        let mut acc = BucketAccum::new(nb, duration, last_b, hi, state.clone());
        let mut walker = FrameWalker::resume(&self.reader, a, state);
        while walker.position() < b {
            let Some((t, applied)) = walker.advance_applied() else {
                break;
            };
            acc.frame(t, applied, walker.buffers());
        }
        if last {
            acc.finish_tail();
        }
        let skipped = walker.skipped();
        self.state = walker.into_buffers();
        self.out = Some((acc, skipped));
    }
}

/// 并行概览的分段方案。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `tuning` - 调参。
///
/// # Returns
///
/// `Some((线程池, 段边界))`，段边界为 `[0, a1, …, 帧数]`、严格递增；应走串行时返回 `None`。
fn plan_overview<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    tuning: &Tuning,
) -> Option<(&'static rayon::ThreadPool, Vec<usize>)> {
    let n = reader.index().len();
    if reader.header().allows_diff() || n == 0 || n < tuning.min_frames {
        return None;
    }
    let pool = scan_pool()?;
    let p = segment_count(pool, n, tuning)?;
    let cuts = (0..=p)
        .map(|s| (s as u64 * n as u64 / p as u64) as usize)
        .collect();
    Some((pool, cuts))
}

/// [`build_overview_parallel`] 的实现（调参可覆盖）。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `path` - 该节目的文件路径。
/// * `buckets` - 期望桶数。
/// * `tuning` - 调参。
///
/// # Returns
///
/// 与 [`build_overview`] 逐字节一致的概览。
///
/// # Errors
///
/// 见 [`build_overview_parallel`]。
pub(crate) fn overview_with<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    path: &Path,
    buckets: u32,
    tuning: &Tuning,
) -> Result<Overview, ScanError> {
    let Some((pool, cuts)) = plan_overview(reader, tuning) else {
        let scan = open_scan(reader, path, READ_AHEAD)?;
        return Ok(build_overview(&scan, buckets));
    };
    let buckets = buckets.clamp(MIN_BUCKETS, MAX_BUCKETS);
    let nb = buckets as usize;
    let duration = reader.header().total_duration_us;
    let index = reader.index();

    // 读取器在调用线程上建好（文件句柄与预读窗口并行准备），再移交给工作线程
    let windows: Vec<usize> = cuts
        .windows(2)
        .map(|w| window_for(index, w[0].saturating_sub(1)..w[1]))
        .collect();
    let readers = open_segments(pool, reader, path, &windows)?;
    let mut segs: Vec<OverviewSeg> = readers
        .into_iter()
        .zip(cuts.windows(2).enumerate())
        .map(|(reader, (s, w))| OverviewSeg {
            reader,
            frames: w[0]..w[1],
            probe: if s == 0 {
                w[0]..w[0]
            } else {
                cuts[s - 1]..w[0]
            },
            // 全零缓冲在工作线程上创建
            state: Vec::new(),
            raw: Vec::new(),
            ready: false,
            out: None,
        })
        .collect();
    let last = segs.len().saturating_sub(1);

    // 第一阶段：各段在前一段范围内倒查最后一个可成功应用的帧，命中即得段首状态并立即累积
    pool.install(|| {
        segs.par_iter_mut()
            .enumerate()
            .for_each(|(s, seg)| seg.probe_and_run(s == 0, nb, duration, s == last));
    });
    // 串接（罕见）：探测落空说明前一段整段都是坏帧，前一段的段末状态 = 它的段首状态 = 本段段首状态。
    // 按段序处理，前一段若也落空，此时已被赋成它的段首状态。
    let mut pending = false;
    for s in 1..segs.len() {
        let (head, tail) = segs.split_at_mut(s);
        if let (Some(prev), Some(cur)) = (head.last(), tail.first_mut())
            && !cur.ready {
                cur.state.clone_from(&prev.state);
                pending = true;
            }
    }
    // 第二阶段（仅在有落空段时）：补跑落空段
    if pending {
        pool.install(|| {
            segs.par_iter_mut()
                .enumerate()
                .filter(|(_, seg)| !seg.ready)
                .for_each(|(s, seg)| seg.run(nb, duration, s == last));
        });
    }

    let rows = reader.unis().len();
    let mut counts = vec![0u32; rows * nb];
    let mut level = vec![0u8; rows * nb];
    let mut skipped = 0u64;
    for (acc, sk) in segs.iter().filter_map(|seg| seg.out.as_ref()) {
        acc.merge_into(&mut counts, &mut level);
        skipped += sk;
    }
    Ok(assemble_overview(reader, buckets, &counts, &level, skipped))
}

/// 用多线程查询通道曲线，结果与 [`crate::channel_series`] 逐字节一致。
///
/// 区间内待扫描帧数较多且文件未置 ALLOW_DIFF_FRAME 时，按桶边界切段并行（每段的初始状态
/// 是该桶起点处的串行状态）；否则回落串行。帧数据都经 `path` 重新打开的顺序预读数据源读取，
/// `reader` 只提供已解析的头、Universe 表与索引。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `path` - 该节目的文件路径，必须与 `reader` 是同一份文件内容。
/// * `universe` - Universe 编号（不是文件内下标）。
/// * `channels` - 通道号列表（0 起，超出 `dmx_len` 的通道被忽略）。
/// * `t0` / `t1` - 查询区间（微秒）。
/// * `max_points` - 最大点数，钳制到 `[2, MAX_POINTS]`。
///
/// # Returns
///
/// 每个有效通道一条 [`ChannelSeries`]（保持传入顺序），点按时间升序、不超过 `max_points` 个。
///
/// # Errors
///
/// - 通道过多或 Universe 不存在返回 [`ScanError::Series`]（先于任何文件操作校验）。
/// - 按 `path` 打开文件失败返回 [`ScanError::Open`]。
/// - `path` 上的文件长度与 `reader` 不一致等返回 [`ScanError::Reader`]。
pub fn channel_series_parallel<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    path: &Path,
    universe: u16,
    channels: &[u16],
    t0: u64,
    t1: u64,
    max_points: u32,
) -> Result<Vec<ChannelSeries>, ScanError> {
    let q = SeriesQuery::new(reader, universe, channels, t0, t1, max_points)?;
    series_with(reader, path, &q, &Tuning::DEFAULT)
}

/// 曲线分段方案中的一段。
#[derive(Debug, Clone)]
struct SeriesSegPlan {
    /// 本段负责的桶范围。
    buckets: Range<usize>,
    /// 段首桶起点处第一个尚未处理的帧下标。
    start: usize,
    /// 本段之后第一个不归本段处理的帧下标（用于选择预读窗口）。
    end: usize,
    /// 探测范围：第 0 段为区间起点帧，其余为前一段的帧范围。
    probe: Range<usize>,
}

/// 曲线分段：读取器、方案、目标 Universe 状态与结果。
struct SeriesSeg {
    /// 本段专用读取器。
    reader: ScanReader,
    /// 分段方案。
    plan: SeriesSegPlan,
    /// 目标 Universe 状态：处理前为段首状态，处理后为段末状态（即下一段的段首状态）。
    track: UniTrack,
    /// 段首状态是否已确定（第 0 段恒确定，其余段探测命中才确定）。
    ready: bool,
    /// 本段各桶的 `(min, max)` 包络。
    envelope: Vec<(u8, u8)>,
}

impl SeriesSeg {
    /// 第一阶段：探测段首状态；已确定则立即处理本段的桶。
    ///
    /// # Arguments
    ///
    /// * `first` - 是否为第 0 段（段首状态即区间起点状态，探测落空时为全零）。
    /// * `q` - 已校验的查询。
    fn probe_and_run(&mut self, first: bool, q: &SeriesQuery) {
        let Self {
            reader,
            plan,
            track,
            ..
        } = self;
        let reader = &*reader;
        let found = probe_last_good(plan.probe.clone(), |k| track.apply(reader, k));
        self.ready = first || found;
        if self.ready {
            self.run(q);
        }
    }

    /// 从段首桶开始执行与串行相同的分桶循环。
    ///
    /// # Arguments
    ///
    /// * `q` - 已校验的查询。
    fn run(&mut self, q: &SeriesQuery) {
        let mut next = self.plan.start;
        run_buckets(
            &self.reader,
            &mut self.track,
            &mut next,
            q,
            self.plan.buckets.clone(),
            &mut self.envelope,
        );
    }
}

/// 并行曲线的分段方案。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `q` - 已校验的查询。
/// * `tuning` - 调参。
///
/// # Returns
///
/// `Some((线程池, 各段方案))`；应走串行时返回 `None`。
fn plan_series<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    q: &SeriesQuery,
    tuning: &Tuning,
) -> Option<(&'static rayon::ThreadPool, Vec<SeriesSegPlan>)> {
    if reader.header().allows_diff() || q.n < 2 {
        return None;
    }
    let index = reader.index();
    let start_idx = reader.find_index(q.t0);
    // 串行只看区间起点帧及之后的帧（起点帧损坏时状态从全零开始，不回看更早的帧）
    let base = start_idx.unwrap_or(0);
    let f0 = start_idx.map_or(0, |i| i + 1);
    // 串行实际处理的帧：t0 < t ≤ t1 且 t < t0 + n * width
    let limit = q.t0.saturating_add((q.n as u64).saturating_mul(q.width));
    let f_end = index
        .partition_point(|f| f.time_us <= q.t1 && f.time_us < limit)
        .max(f0);
    let work = f_end - f0;
    if work < tuning.min_frames {
        return None;
    }
    let pool = scan_pool()?;
    let p = segment_count(pool, work, tuning)?.min(q.n);

    // 按帧数均分，再取各分界帧所在的桶作为段边界（去重后严格递增）
    let mut cuts = vec![0usize];
    for s in 1..p {
        let b = if work == 0 {
            s * q.n / p
        } else {
            let f = f0 + (s as u64 * work as u64 / p as u64) as usize;
            index.get(f).map_or(q.n, |fi| {
                (fi.time_us.saturating_sub(q.t0) / q.width) as usize
            })
        };
        if cuts.last().is_some_and(|&l| b > l) && b < q.n {
            cuts.push(b);
        }
    }
    cuts.push(q.n);

    let mut plans: Vec<SeriesSegPlan> = Vec::with_capacity(cuts.len() - 1);
    let mut probe_from = base;
    for w in cuts.windows(2) {
        let start = if w[0] == 0 {
            f0
        } else {
            let lo = q.bucket_start(w[0]);
            index.partition_point(|f| f.time_us < lo)
        };
        if let Some(prev) = plans.last_mut() {
            prev.end = start;
        }
        plans.push(SeriesSegPlan {
            buckets: w[0]..w[1],
            start,
            end: f_end,
            probe: probe_from..start,
        });
        probe_from = start;
    }
    Some((pool, plans))
}

/// [`channel_series_parallel`] 的实现（已校验参数，调参可覆盖）。
///
/// # Arguments
///
/// * `reader` - 已打开的节目。
/// * `path` - 该节目的文件路径。
/// * `q` - 已校验的查询。
/// * `tuning` - 调参。
///
/// # Returns
///
/// 与 [`crate::channel_series`] 逐字节一致的曲线。
///
/// # Errors
///
/// 打开文件或建立读取器失败，见 [`channel_series_parallel`]。
pub(crate) fn series_with<R: Read + Seek>(
    reader: &ArtRecReader<R>,
    path: &Path,
    q: &SeriesQuery,
    tuning: &Tuning,
) -> Result<Vec<ChannelSeries>, ScanError> {
    let Some((pool, plans)) = plan_series(reader, q, tuning) else {
        let scan = open_scan(reader, path, READ_AHEAD)?;
        return Ok(series_serial(&scan, q));
    };
    let index = reader.index();

    // 读取器在调用线程上建好（文件句柄与预读窗口并行准备），再移交给工作线程
    let windows: Vec<usize> = plans
        .iter()
        .map(|p| window_for(index, p.start.saturating_sub(1)..p.end))
        .collect();
    let readers = open_segments(pool, reader, path, &windows)?;
    let track = UniTrack::new(reader, q.ui);
    let mut segs: Vec<SeriesSeg> = readers
        .into_iter()
        .zip(plans)
        .map(|(reader, plan)| SeriesSeg {
            reader,
            track: track.clone(),
            ready: false,
            envelope: Vec::with_capacity(plan.buckets.len() * q.chans().len()),
            plan,
        })
        .collect();

    // 第一阶段：探测各段的段首状态，命中即立即处理本段
    pool.install(|| {
        segs.par_iter_mut()
            .enumerate()
            .for_each(|(s, seg)| seg.probe_and_run(s == 0, q));
    });
    // 串接（罕见）：探测落空说明前一段的帧全部损坏，其段末状态 = 段首状态 = 本段段首状态
    let mut pending = false;
    for s in 1..segs.len() {
        let (head, tail) = segs.split_at_mut(s);
        if let (Some(prev), Some(cur)) = (head.last(), tail.first_mut())
            && !cur.ready {
                cur.track.copy_state_from(&prev.track);
                pending = true;
            }
    }
    // 第二阶段（仅在有落空段时）：补跑落空段
    if pending {
        pool.install(|| {
            segs.par_iter_mut()
                .filter(|seg| !seg.ready)
                .for_each(|seg| seg.run(q));
        });
    }

    let mut envelope = Vec::with_capacity(q.n * q.chans().len());
    for seg in &segs {
        envelope.extend_from_slice(&seg.envelope);
    }
    Ok(q.assemble(&envelope))
}

#[cfg(test)]
mod tests;
