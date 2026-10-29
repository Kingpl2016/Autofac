//! 崩溃安全的磁盘落盘与孤立录制恢复。
//!
//! 录制期间写入 `名称.artrec.part`，同时把每个已写 Chunk 的帧索引追加到
//! `名称.artrec.idx`（每帧 16 字节，与 `.artrec` 内索引条目同格式）。
//! 正常结束时补写索引表、回填头部、原子重命名为 `名称.artrec` 并写 sidecar；
//! 异常退出后由 [`recover_orphans`] 依据索引日志重建出可播放的文件。
//!
//! 落盘顺序保证：`sync_data` 在专用刷盘线程（`artrec-flush`）中执行，录制线程不等待磁盘。
//! [`FileRecorder::checkpoint`] 只把 `.part` 的写缓冲刷到操作系统，再把本轮新增的索引日志
//! 条目交给刷盘线程；索引日志文件**只由刷盘线程写**，且每一轮严格按
//! "`.part` `sync_data` → 追加日志条目 → 日志 `sync_data`"的顺序执行。
//! 交付给刷盘线程的条目所指向的 Chunk 在交付前已进入操作系统，又在条目写入日志前随
//! `.part` 一起落盘，因此日志中出现的条目对应的 Chunk 一定已写入磁盘。

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;

use parking_lot::{Condvar, Mutex, MutexGuard};

use artrec_core::{
    read_header_and_unis, ArtRecError, ArtRecWriter, ChunkHdr, FrameIndex, CHUNKHDR_SIZE,
    FRAMEINDEX_SIZE, HEADER_SIZE,
};
use serde::Serialize;

use crate::encoder::Encoded;
use crate::session::{RecorderSession, SessionConfig, SessionStats};
use crate::sidecar::{overview_cache_path, write_sidecar, Sidecar, SIDECAR_VERSION};

/// 录制中的临时文件后缀。
pub const PART_SUFFIX: &str = ".artrec.part";
/// 索引日志后缀。
pub const JOURNAL_SUFFIX: &str = ".artrec.idx";
/// 完成文件后缀。
pub const ARTREC_SUFFIX: &str = ".artrec";

/// 写缓冲大小。
const BUF_CAPACITY: usize = 64 * 1024;
/// 录制线程本地索引日志条目缓冲的初始容量（256 条 ≈ 44Hz 下约 5.8 秒，正常每秒交付一次）。
const JOURNAL_BUF_CAPACITY: usize = 4096;
/// 刷盘线程名。
const FLUSH_THREAD_NAME: &str = "artrec-flush";

/// 刷盘线程要同步的文件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncTarget {
    /// 录制中的 `.part` 文件。
    Part,
    /// 索引日志文件。
    Journal,
}

/// 落盘同步操作：生产环境为 [`File::sync_data`]；测试可替换为慢速、出错或带暂停点的实现。
type SyncFn = Arc<dyn Fn(SyncTarget, &File) -> std::io::Result<()> + Send + Sync>;

/// 生产环境的同步操作：直接 `sync_data`。
fn real_sync() -> SyncFn {
    Arc::new(|_, f: &File| f.sync_data())
}

/// 刷盘线程的运行阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Worker {
    /// 空闲，等待任务。
    #[default]
    Idle,
    /// 正在执行一轮落盘。
    Busy,
    /// 已结束（正常退出或因 IO 错误停止）。
    Stopped,
}

/// 录制线程与刷盘线程共享的状态。只在交接时短暂持锁，持锁期间不做任何 IO。
#[derive(Default)]
struct FlushState {
    /// 已交付、尚未被刷盘线程取走的索引日志条目字节（上一轮未完成时在此累积）。
    pending: Vec<u8>,
    /// 有已交付但尚未开始的工作。
    requested: bool,
    /// 录制线程请求退出：做完已交付的工作后结束。
    shutdown: bool,
    /// 刷盘线程的运行阶段。
    worker: Worker,
    /// 尚未报告给录制线程的 IO 错误。
    error: Option<std::io::Error>,
}

/// [`FlushState`] 及其条件变量。
struct FlushShared {
    state: Mutex<FlushState>,
    cv: Condvar,
}

impl FlushShared {
    /// 加锁（parking_lot 不毒化；刷盘状态在任何时刻都自洽，不因别处 panic 而失效）。
    fn lock(&self) -> MutexGuard<'_, FlushState> {
        self.state.lock()
    }

    /// 在条件变量上等待一次。
    fn wait<'a>(&self, mut guard: MutexGuard<'a, FlushState>) -> MutexGuard<'a, FlushState> {
        self.cv.wait(&mut guard);
        guard
    }
}

/// 后台刷盘线程句柄。被 drop 时请求退出并等待线程结束，保证线程不泄漏。
struct Flusher {
    shared: Arc<FlushShared>,
    handle: Option<JoinHandle<()>>,
}

impl Flusher {
    /// 启动刷盘线程。
    ///
    /// # Arguments
    ///
    /// * `part` - `.part` 文件的 `try_clone()` 句柄，只用于 `sync_data`。
    /// * `journal` - 索引日志文件；移交给刷盘线程后由其独占写入。
    /// * `sync` - 同步操作。
    ///
    /// # Returns
    ///
    /// 空闲等待任务的刷盘线程句柄。
    ///
    /// # Errors
    ///
    /// 创建线程失败时返回 IO 错误。
    fn spawn(part: File, journal: File, sync: SyncFn) -> std::io::Result<Self> {
        let shared = Arc::new(FlushShared {
            state: Mutex::new(FlushState::default()),
            cv: Condvar::new(),
        });
        let worker = Arc::clone(&shared);
        let handle = std::thread::Builder::new()
            .name(FLUSH_THREAD_NAME.into())
            .spawn(move || flush_loop(&worker, &part, journal, &sync))?;
        Ok(Self {
            shared,
            handle: Some(handle),
        })
    }

    /// 交付本轮新增的索引日志条目（不等待磁盘）。
    ///
    /// 调用方必须保证这些条目指向的 Chunk 已经刷到操作系统。条目被追加到共享缓冲后
    /// `entries` 被清空（保留容量）；刷盘线程正忙时条目并入下一轮。没有任何新条目时不发起新一轮。
    ///
    /// # Arguments
    ///
    /// * `entries` - 录制线程本地累积的条目字节。
    ///
    /// # Errors
    ///
    /// 此前某轮刷盘出错时返回该错误（只报告一次）；刷盘线程已停止时返回 IO 错误。
    fn submit(&self, entries: &mut Vec<u8>) -> std::io::Result<()> {
        let mut st = self.shared.lock();
        if let Some(e) = st.error.take() {
            return Err(e);
        }
        if st.worker == Worker::Stopped {
            return Err(std::io::Error::other(
                "后台刷盘线程已因先前的 IO 错误停止，索引日志不再更新",
            ));
        }
        if !entries.is_empty() {
            st.pending.extend_from_slice(entries);
            entries.clear();
            st.requested = true;
            drop(st);
            self.shared.cv.notify_all();
        }
        Ok(())
    }

    /// 请求退出并等待线程结束（线程会先做完已交付的工作）。
    ///
    /// # Returns
    ///
    /// 线程正常结束（或此前已被回收）返回 `true`；线程 panic 返回 `false`。
    fn stop_and_join(&mut self) -> bool {
        let Some(handle) = self.handle.take() else {
            return true;
        };
        self.shared.lock().shutdown = true;
        self.shared.cv.notify_all();
        handle.join().is_ok()
    }

    /// 做完已交付的工作后关闭刷盘线程。
    ///
    /// # Errors
    ///
    /// 尚未报告过的刷盘 IO 错误，或刷盘线程异常退出。
    fn shutdown(mut self) -> std::io::Result<()> {
        let joined = self.stop_and_join();
        if let Some(e) = self.shared.lock().error.take() {
            return Err(e);
        }
        if joined {
            Ok(())
        } else {
            Err(std::io::Error::other("刷盘线程异常退出"))
        }
    }

    /// 阻塞直到已交付的工作全部完成或线程停止（仅测试）。
    #[cfg(test)]
    fn wait_idle(&self) {
        let mut st = self.shared.lock();
        while st.worker != Worker::Stopped && (st.requested || st.worker == Worker::Busy) {
            st = self.shared.wait(st);
        }
    }
}

impl Drop for Flusher {
    fn drop(&mut self) {
        // 提前返回 / panic 展开时也要回收线程；此处无法报告结果，忽略即可
        let _ = self.stop_and_join();
    }
}

/// 刷盘线程主循环：等待任务 → 取走全部已交付条目 → 按序落盘；收到退出请求且无剩余任务时结束。
///
/// 出错后停止：此后不再写日志（之后的 `sync` 成功也不能证明出错那一轮的数据已落盘），
/// 错误留给录制线程在下一次检查点或收尾时报告。
fn flush_loop(shared: &FlushShared, part: &File, mut journal: File, sync: &SyncFn) {
    let mut batch: Vec<u8> = Vec::with_capacity(JOURNAL_BUF_CAPACITY);
    loop {
        {
            let mut st = shared.lock();
            while !st.requested && !st.shutdown {
                st = shared.wait(st);
            }
            if !st.requested {
                st.worker = Worker::Stopped;
                drop(st);
                shared.cv.notify_all();
                return;
            }
            st.requested = false;
            st.worker = Worker::Busy;
            // 交换缓冲：录制线程此后交付的条目进入下一轮；双缓冲稳态不分配
            std::mem::swap(&mut st.pending, &mut batch);
        }
        let res = flush_round(part, &mut journal, &batch, sync);
        batch.clear();
        let mut st = shared.lock();
        let failed = res.is_err();
        if let Err(e) = res {
            st.error = Some(e);
            st.worker = Worker::Stopped;
        } else {
            st.worker = Worker::Idle;
        }
        drop(st);
        shared.cv.notify_all();
        if failed {
            return;
        }
    }
}

/// 执行一轮落盘：`.part` `sync_data` → 追加日志条目 → 日志 `sync_data`，顺序不可调换。
///
/// # Errors
///
/// 任一步失败立即返回，后续步骤不执行（`.part` 同步失败时绝不写日志）。
fn flush_round(
    part: &File,
    journal: &mut File,
    batch: &[u8],
    sync: &SyncFn,
) -> std::io::Result<()> {
    sync(SyncTarget::Part, part)?;
    journal.write_all(batch)?;
    sync(SyncTarget::Journal, journal)
}

/// 落盘层错误。
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// 文件系统错误。
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    /// ArtRec 编码错误。
    #[error("ArtRec 错误: {0}")]
    ArtRec(#[from] ArtRecError),
}

/// 把用户输入的名称规整为安全的文件名主干：替换非法字符、去除首尾空白与点、
/// 避开 Windows 保留名并限制长度；结果为空时回落 `recording`。
///
/// # Arguments
///
/// * `name` - 用户输入的原始名称。
///
/// # Returns
///
/// 可安全用作文件名主干的字符串：非法字符与控制字符替换为 `_`，最长 80 个字符，
/// 命中 Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM0`-`COM9`、`LPT0`-`LPT9`）时加 `_` 前缀，
/// 规整后为空则返回 `recording`。
#[must_use]
pub fn sanitize_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let limited: String = trimmed.chars().take(80).collect();
    let limited = limited.trim().to_string();
    if limited.is_empty() {
        return "recording".to_string();
    }
    let upper = limited.to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        format!("_{limited}")
    } else {
        limited
    }
}

/// 在目录内为 `stem` 找一个不与任何 `suffixes` 冲突的名字（冲突时追加 `-2`、`-3`…）。
pub(crate) fn unique_stem(dir: &Path, stem: &str, suffixes: &[&str]) -> String {
    let taken = |s: &str| {
        suffixes
            .iter()
            .any(|suf| dir.join(format!("{s}{suf}")).exists())
    };
    if !taken(stem) {
        return stem.to_string();
    }
    (2u32..=u32::MAX)
        .map(|n| format!("{stem}-{n}"))
        .find(|c| !taken(c))
        .unwrap_or_else(|| stem.to_string())
}

/// 开始录制所需的非会话参数。
#[derive(Debug, Clone)]
pub struct StartParams {
    /// 录制目录。
    pub dir: PathBuf,
    /// 文件名主干（会被 [`sanitize_file_stem`] 规整并去重）。
    pub stem: String,
    /// 节目显示名。
    pub name: String,
    /// 备注。
    pub notes: String,
    /// 创建时间（Unix 毫秒）。
    pub created_unix_ms: u64,
    /// 应用版本。
    pub app_version: String,
    /// 合并模式字符串（写入 sidecar）。
    pub merge_mode: String,
    /// 合并引擎源超时（毫秒）。
    pub source_timeout_ms: u64,
}

/// 录制结束的结果。
#[derive(Debug, Clone)]
pub struct Finished {
    /// 最终 `.artrec` 路径。
    pub path: PathBuf,
    /// 最终统计。
    pub stats: SessionStats,
    /// 已写入 sidecar 的元数据。
    pub sidecar: Sidecar,
}

/// 正在进行的磁盘录制。
///
/// 持有一个专用刷盘线程（`artrec-flush`）：[`FileRecorder::checkpoint`] 不等待 `sync_data`；
/// [`FileRecorder::finish`] / [`FileRecorder::cancel`] 以及被 drop 时都会先等该线程做完
/// 已交付的工作并退出。
pub struct FileRecorder {
    session: RecorderSession<BufWriter<File>>,
    /// 自上次检查点以来新增、尚未交付刷盘线程的索引日志条目字节。
    journal_buf: Vec<u8>,
    flusher: Flusher,
    part: PathBuf,
    idx: PathBuf,
    final_path: PathBuf,
    meta: Sidecar,
}

impl FileRecorder {
    /// 创建 `.part` 与索引日志并开始会话。
    ///
    /// 返回前同步落盘一次头部与 Universe 表（先 `.part` 后日志），再启动后台刷盘线程。
    ///
    /// # Arguments
    ///
    /// * `params` - 目录、文件名与元数据参数。
    /// * `cfg` - 会话配置（过滤、Universe 集合、合并与编码策略）。
    ///
    /// # Returns
    ///
    /// 已创建 `.part` 文件与索引日志、头部与 Universe 表已落盘的 [`FileRecorder`]。
    ///
    /// # Errors
    ///
    /// 目录不可写、Universe 非法、刷盘线程创建失败等返回 [`StoreError`]。
    pub fn start(params: StartParams, cfg: SessionConfig) -> Result<Self, StoreError> {
        Self::start_with(params, cfg, real_sync())
    }

    /// [`FileRecorder::start`] 的实现体，同步操作可替换（测试注入慢速 / 出错 / 暂停）。
    fn start_with(
        params: StartParams,
        cfg: SessionConfig,
        sync: SyncFn,
    ) -> Result<Self, StoreError> {
        fs::create_dir_all(&params.dir)?;
        let stem = unique_stem(
            &params.dir,
            &sanitize_file_stem(&params.stem),
            &[ARTREC_SUFFIX, PART_SUFFIX],
        );
        let part = params.dir.join(format!("{stem}{PART_SUFFIX}"));
        let idx = params.dir.join(format!("{stem}{JOURNAL_SUFFIX}"));
        let final_path = params.dir.join(format!("{stem}{ARTREC_SUFFIX}"));

        let part_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&part)?;
        let journal_file = match OpenOptions::new().write(true).create_new(true).open(&idx) {
            Ok(f) => f,
            Err(e) => {
                let _ = fs::remove_file(&part);
                return Err(e.into());
            }
        };

        let meta = Sidecar {
            version: SIDECAR_VERSION,
            name: params.name,
            notes: params.notes,
            created_unix_ms: params.created_unix_ms,
            app_version: params.app_version,
            filter: cfg.filter.clone(),
            universes: cfg.universes.clone(),
            merge_mode: params.merge_mode,
            ..Sidecar::default()
        };
        let mut session = match RecorderSession::new(
            BufWriter::with_capacity(BUF_CAPACITY, part_file),
            cfg,
            params.source_timeout_ms,
        ) {
            Ok(s) => s,
            Err(e) => {
                let _ = fs::remove_file(&part);
                let _ = fs::remove_file(&idx);
                return Err(e.into());
            }
        };
        // 让头部与 Universe 表尽早落盘，崩溃后文件始终可解析（与原同步检查点一致：先 `.part` 后日志）
        session.flush()?;
        sync(SyncTarget::Part, session.sink().get_ref())?;
        sync(SyncTarget::Journal, &journal_file)?;

        let flusher = match session
            .sink()
            .get_ref()
            .try_clone()
            .and_then(|part_clone| Flusher::spawn(part_clone, journal_file, sync))
        {
            Ok(f) => f,
            Err(e) => {
                // 尚无任何帧：关闭句柄后清理两个文件
                drop(session);
                let _ = fs::remove_file(&part);
                let _ = fs::remove_file(&idx);
                return Err(e.into());
            }
        };
        Ok(Self {
            session,
            journal_buf: Vec::with_capacity(JOURNAL_BUF_CAPACITY),
            flusher,
            part,
            idx,
            final_path,
            meta,
        })
    }

    /// 最终 `.artrec` 路径（录制完成后才存在）。
    ///
    /// # Returns
    ///
    /// 录制正常结束后文件将被重命名到的目标路径。
    #[must_use]
    pub fn final_path(&self) -> &Path {
        &self.final_path
    }

    /// 摄入一帧，见 [`RecorderSession::ingest`]。
    ///
    /// # Arguments
    ///
    /// * `frame` - 接收到的帧。
    /// * `t_us` - 该帧到达时刻（相对录制起点，微秒）。
    pub fn ingest(&mut self, frame: &artnet_net::DmxFrame, t_us: u64) {
        self.session.ingest(frame, t_us);
    }

    /// 周期性调用：变更检测并写帧，写出的帧索引暂存到本地，下次检查点时交付刷盘线程写入日志。
    ///
    /// # Returns
    ///
    /// 写入了帧则返回 [`Encoded`]，无新数据或数据无变化时返回 `None`。
    ///
    /// # Errors
    ///
    /// 写盘失败返回 [`StoreError`]（调用方应终止录制并提示用户）。
    pub fn tick(&mut self) -> Result<Option<Encoded>, StoreError> {
        let e = self.session.tick()?;
        if let Some(enc) = &e {
            self.journal_buf.extend_from_slice(&enc.index.to_bytes());
        }
        Ok(e)
    }

    /// 检查点：把 `.part` 的写缓冲刷到操作系统，再把本轮新增的索引日志条目交给后台刷盘线程，
    /// **不等待** `sync_data`（毫秒内返回）。建议约每秒调用一次。
    ///
    /// 刷盘线程按"`.part` `sync_data` → 追加日志条目 → 日志 `sync_data`"的顺序执行，
    /// 日志中落盘的条目所指向的 Chunk 一定已经落盘；上一轮尚未完成时，本轮条目并入下一轮一起写入。
    /// 自上次检查点以来没有新帧时不发起新一轮（恢复只依赖日志条目，无条目的 `.part` 尾部会被截掉）。
    ///
    /// # Errors
    ///
    /// - 刷新 `.part` 写缓冲失败返回 [`StoreError::ArtRec`]。
    /// - 此前某轮后台刷盘失败时返回该 [`StoreError::Io`]（只报告一次）；刷盘线程随之停止，
    ///   此后的检查点也返回 [`StoreError::Io`]。
    pub fn checkpoint(&mut self) -> Result<(), StoreError> {
        self.session.flush()?;
        self.flusher.submit(&mut self.journal_buf)?;
        Ok(())
    }

    /// 实时统计。
    ///
    /// # Returns
    ///
    /// 当前时刻的 [`SessionStats`] 快照。
    #[must_use]
    pub fn stats(&self) -> SessionStats {
        self.session.stats()
    }

    /// 最近一次写帧时的合并快照，见 [`RecorderSession::snapshot`]。
    ///
    /// # Returns
    ///
    /// 各路快照缓冲的只读切片。
    #[must_use]
    pub fn snapshot(&self) -> &[Vec<u8>] {
        self.session.snapshot()
    }

    /// 本文件录制的 Universe 集合，见 [`RecorderSession::universes`]。
    ///
    /// # Returns
    ///
    /// Universe 编号切片。
    #[must_use]
    pub fn universes(&self) -> &[u16] {
        self.session.universes()
    }

    /// 正常结束：等刷盘线程做完已交付的工作并退出，再补收尾帧与索引、回填头部、
    /// 原子重命名并写 sidecar。
    ///
    /// # Arguments
    ///
    /// * `total_us` - 录制总时长（微秒）。
    ///
    /// # Returns
    ///
    /// [`Finished`]，含最终 `.artrec` 路径、最终统计与已写入的 sidecar 元数据。
    ///
    /// # Errors
    ///
    /// - 后台刷盘出过尚未报告的 IO 错误时返回该 [`StoreError::Io`]，且不再收尾。
    /// - 收尾任一步失败返回 [`StoreError`]。
    ///
    /// 失败时 `.part` 与日志保留，可由 [`recover_orphans`] 恢复。
    pub fn finish(self, total_us: u64) -> Result<Finished, StoreError> {
        let Self {
            session,
            journal_buf: _,
            flusher,
            part,
            idx,
            final_path,
            mut meta,
        } = self;
        // 刷盘线程退出时关闭它持有的 `.part` 副本句柄与日志文件，之后才能安全改名 / 删除
        flusher.shutdown()?;
        let sources = session.sources_seen();
        let protocols = session.protocols_seen();
        let ignored = session.ignored_universes();
        let (bw, stats) = session.finish(total_us)?;
        let file = bw
            .into_inner()
            .map_err(std::io::IntoInnerError::into_error)?;
        file.sync_all()?;
        drop(file);

        fs::rename(&part, &final_path)?;
        let _ = fs::remove_file(&idx);
        // 选名只避开 `.artrec`：同名节目被外部删掉时可能残留旧概览缓存，不能让新节目继承它
        let _ = fs::remove_file(overview_cache_path(&final_path));

        meta.sources = sources;
        meta.protocols = protocols;
        meta.ignored_universes = ignored;
        meta.duration_us = stats.duration_us;
        meta.frames = stats.frames;
        meta.bytes = fs::metadata(&final_path).map_or(stats.bytes, |m| m.len());
        write_sidecar(&final_path, &meta)?;
        Ok(Finished {
            path: final_path,
            stats,
            sidecar: meta,
        })
    }

    /// 取消录制：等刷盘线程退出后删除 `.part` 与日志。
    pub fn cancel(self) {
        let Self {
            session,
            flusher,
            part,
            idx,
            ..
        } = self;
        // 文件随后整体删除，刷盘错误无需报告
        let _ = flusher.shutdown();
        let (file, _) = session.abandon().into_parts();
        drop(file);
        let _ = fs::remove_file(part);
        let _ = fs::remove_file(idx);
    }

    /// 阻塞直到已交付刷盘线程的工作全部完成（仅测试）。
    #[cfg(test)]
    fn wait_flushed(&self) {
        self.flusher.wait_idle();
    }

    /// 模拟"后台刷盘完成之后"崩溃：丢弃用户态写缓冲与未交付的日志条目，保留磁盘文件（仅测试）。
    ///
    /// 刷盘线程照常做完已交付的工作后退出，与 drop 行为一致。
    #[cfg(test)]
    fn crash(self) {
        let Self {
            session, flusher, ..
        } = self;
        let (file, _) = session.abandon().into_parts();
        drop(file);
        drop(flusher);
    }
}

/// 一次孤立录制的恢复结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum RecoveryOutcome {
    /// 已恢复为可播放的 `.artrec`。
    #[serde(rename_all = "camelCase")]
    Recovered {
        /// 恢复后的文件路径。
        path: PathBuf,
        /// 恢复的帧数。
        frames: u64,
        /// 恢复的时长（微秒）。
        duration_us: u64,
    },
    /// 没有任何有效帧，已清理残留文件。
    #[serde(rename_all = "camelCase")]
    Discarded {
        /// 被清理的 `.part` 路径。
        part: PathBuf,
    },
    /// 无法恢复，残留文件已改名为 `.bad` 以免重复处理。
    #[serde(rename_all = "camelCase")]
    Failed {
        /// 原 `.part` 路径。
        part: PathBuf,
        /// 失败原因。
        reason: String,
    },
}

/// 扫描目录中的孤立 `.artrec.part` 并恢复。
///
/// **只应在应用启动、尚未开始任何录制时调用**，否则会把正在写入的文件当作孤立文件。
///
/// # Arguments
///
/// * `dir` - 录制目录。
///
/// # Returns
///
/// 每个孤立文件一条结果；目录不存在或无孤立文件时为空。
#[must_use]
pub fn recover_orphans(dir: &Path) -> Vec<RecoveryOutcome> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut parts: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(PART_SUFFIX))
        })
        .collect();
    parts.sort();
    parts
        .into_iter()
        .map(|part| match recover_one(&part) {
            Ok(o) => o,
            Err(e) => {
                let mut bad = part.as_os_str().to_owned();
                bad.push(".bad");
                let _ = fs::rename(&part, PathBuf::from(bad));
                RecoveryOutcome::Failed {
                    part,
                    reason: e.to_string(),
                }
            }
        })
        .collect()
}

// 恢复流程是一条线性的"校验 → 截断 → 补尾 → 改名"，拆分反而难读
fn recover_one(part: &Path) -> Result<RecoveryOutcome, StoreError> {
    let dir = part.parent().unwrap_or_else(|| Path::new("."));
    let name = part
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let stem = name.strip_suffix(PART_SUFFIX).unwrap_or(name).to_string();
    let idx_path = dir.join(format!("{stem}{JOURNAL_SUFFIX}"));

    let mut f = File::open(part)?;
    // 头部都没落盘就崩溃：日志不可能引用任何 Chunk，没有可恢复的内容
    if f.metadata()?.len() < u64::from(HEADER_SIZE) {
        drop(f);
        let _ = fs::remove_file(part);
        let _ = fs::remove_file(&idx_path);
        return Ok(RecoveryOutcome::Discarded {
            part: part.to_path_buf(),
        });
    }
    // 文件头与 Universe 表的读取/校验与随机访问读取器共用 artrec-core 的实现
    let (len, header, unis) = read_header_and_unis(&mut f)?;

    // 取日志中"连续、时间非降、且 Chunk 头一致"的最长前缀
    let pool_off = u64::from(header.chunk_pool_offset);
    let journal = fs::read(&idx_path).unwrap_or_default();
    let mut index: Vec<FrameIndex> = Vec::new();
    let mut expect_pos = 0u64;
    let mut prev_t = 0u64;
    // 末尾不足一条的残片（写入中途断电）被 `as_chunks` 自然丢弃
    for rec in journal.as_chunks::<{ FRAMEINDEX_SIZE as usize }>().0 {
        let fi = FrameIndex::from_bytes(rec)?;
        let cmp_len = u64::from(fi.chunk_cmp_len);
        if u64::from(fi.chunk_pos) != expect_pos
            || fi.time_us < prev_t
            || cmp_len < CHUNKHDR_SIZE as u64
            || pool_off + expect_pos + cmp_len > len
        {
            break;
        }
        let mut hb = [0u8; CHUNKHDR_SIZE];
        f.seek(SeekFrom::Start(pool_off + expect_pos))?;
        f.read_exact(&mut hb)?;
        let hdr = ChunkHdr::from_bytes(&hb)?;
        if CHUNKHDR_SIZE as u64 + u64::from(hdr.payload_cmp_sz) != cmp_len {
            break;
        }
        index.push(fi);
        expect_pos += cmp_len;
        prev_t = fi.time_us;
    }
    drop(f);

    let Some(last) = index.last().copied() else {
        let _ = fs::remove_file(part);
        let _ = fs::remove_file(&idx_path);
        return Ok(RecoveryOutcome::Discarded {
            part: part.to_path_buf(),
        });
    };

    // 截掉未被日志确认的尾部，再补索引表与头部
    let file = OpenOptions::new().read(true).write(true).open(part)?;
    file.set_len(pool_off + expect_pos)?;
    let frames = index.len() as u64;
    let writer = ArtRecWriter::resume(
        file,
        unis.clone(),
        header.compress_algo,
        header.compress_level,
        header.flags,
        header.rec_start_us,
        index,
    )?;
    let file = writer.finish(last.time_us)?;
    file.sync_all()?;
    drop(file);

    let final_stem = unique_stem(dir, &stem, &[ARTREC_SUFFIX]);
    let final_path = dir.join(format!("{final_stem}{ARTREC_SUFFIX}"));
    fs::rename(part, &final_path)?;
    let _ = fs::remove_file(&idx_path);
    // 同上：恢复出的节目不能继承同名旧节目残留的概览缓存
    let _ = fs::remove_file(overview_cache_path(&final_path));

    let sidecar = Sidecar {
        version: SIDECAR_VERSION,
        name: stem,
        created_unix_ms: header.rec_start_us / 1000,
        universes: unis.iter().map(|u| u.universe).collect(),
        duration_us: last.time_us,
        frames,
        bytes: fs::metadata(&final_path).map_or(0, |m| m.len()),
        recovered: true,
        ..Sidecar::default()
    };
    write_sidecar(&final_path, &sidecar)?;
    Ok(RecoveryOutcome::Recovered {
        path: final_path,
        frames,
        duration_us: last.time_us,
    })
}

/// 列出目录下所有 `.artrec` 文件（升序），供节目库使用。
///
/// # Arguments
///
/// * `dir` - 录制目录。
///
/// # Returns
///
/// 按路径升序排列的 `.artrec` 文件路径（扩展名不区分大小写）；目录不存在或无法读取时为空。
#[must_use]
pub fn list_artrec_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let set: BTreeSet<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("artrec"))
        })
        .collect();
    set.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use artnet_net::{Bytes, DmxFrame, Protocol};
    use artrec_core::ArtRecReader;
    use signal_engine::MergeMode;

    use std::fs::File;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    use artrec_core::FrameIndex;

    use super::{
        list_artrec_files, recover_orphans, sanitize_file_stem, FileRecorder, RecoveryOutcome,
        StartParams, StoreError, SyncFn, SyncTarget, PART_SUFFIX,
    };
    use crate::encoder::EncoderConfig;
    use crate::filter::RecordFilter;
    use crate::session::SessionConfig;
    use crate::sidecar::read_sidecar;
    use crate::testutil::TempDir;

    fn cfg(universes: Vec<u16>) -> SessionConfig {
        SessionConfig {
            filter: RecordFilter::default(),
            universes,
            merge_mode: MergeMode::Htp,
            encoder: EncoderConfig::default(),
            rec_start_unix_us: 1_700_000_000_000_000,
        }
    }

    fn params(dir: &TempDir, stem: &str) -> StartParams {
        StartParams {
            dir: dir.path().to_path_buf(),
            stem: stem.to_string(),
            name: stem.to_string(),
            notes: String::new(),
            created_unix_ms: 1_700_000_000_000,
            app_version: "0.1.0".into(),
            merge_mode: "htp".into(),
            source_timeout_ms: 2500,
        }
    }

    fn frame(universe: u16, v: u8) -> DmxFrame {
        DmxFrame {
            protocol: Protocol::ArtNet,
            universe,
            data: Bytes::from(vec![v, v, v]),
            source: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
            sequence: 0,
            received_at: std::time::Instant::now(),
        }
    }

    #[test]
    fn sanitize_handles_illegal_reserved_and_empty() {
        assert_eq!(sanitize_file_stem("a/b:c*?"), "a_b_c__");
        assert_eq!(sanitize_file_stem("  ..  "), "recording");
        assert_eq!(sanitize_file_stem("CON"), "_CON");
        assert_eq!(sanitize_file_stem("com1"), "_com1");
        assert_eq!(sanitize_file_stem("开场 秀"), "开场 秀");
        assert_eq!(sanitize_file_stem(&"x".repeat(200)).chars().count(), 80);
    }

    #[test]
    fn normal_finish_renames_and_writes_sidecar() {
        let dir = TempDir::new("finish");
        let mut rec = FileRecorder::start(params(&dir, "show"), cfg(vec![1])).unwrap();
        for i in 0..10u64 {
            rec.ingest(&frame(1, i as u8), i * 22_000);
            rec.tick().unwrap();
        }
        rec.checkpoint().unwrap();
        let done = rec.finish(300_000).unwrap();

        assert_eq!(done.path, dir.path().join("show.artrec"));
        assert!(!dir.path().join(format!("show{PART_SUFFIX}")).exists());
        assert!(!dir.path().join("show.artrec.idx").exists());
        let r = ArtRecReader::open_file(&done.path).unwrap();
        assert_eq!(u64::from(r.header().frame_count), done.stats.frames);
        assert_eq!(r.frame_at(0).unwrap().unwrap()[0][0], 0);

        let meta = read_sidecar(&done.path).unwrap();
        assert_eq!(meta.name, "show");
        assert_eq!(meta.universes, vec![1]);
        assert_eq!(meta.sources, vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))]);
        assert_eq!(meta.protocols, vec![Protocol::ArtNet]);
        assert_eq!(meta.duration_us, 300_000);
        assert!(!meta.recovered);
    }

    #[test]
    fn duplicate_names_get_suffix() {
        let dir = TempDir::new("dup");
        let a = FileRecorder::start(params(&dir, "same"), cfg(vec![1])).unwrap();
        let b = FileRecorder::start(params(&dir, "same"), cfg(vec![1])).unwrap();
        assert_eq!(a.final_path().file_name().unwrap(), "same.artrec");
        assert_eq!(b.final_path().file_name().unwrap(), "same-2.artrec");
        a.cancel();
        b.cancel();
        assert!(list_artrec_files(dir.path()).is_empty());
    }

    #[test]
    fn cancel_removes_temp_files() {
        let dir = TempDir::new("cancel");
        let mut rec = FileRecorder::start(params(&dir, "gone"), cfg(vec![1])).unwrap();
        rec.ingest(&frame(1, 5), 0);
        rec.tick().unwrap();
        rec.cancel();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn crash_after_checkpoint_recovers_confirmed_frames() {
        let dir = TempDir::new("crash");
        let mut rec = FileRecorder::start(params(&dir, "live"), cfg(vec![0, 1])).unwrap();
        for i in 0..20u64 {
            rec.ingest(&frame(0, (i + 1) as u8), i * 22_000);
            rec.ingest(&frame(1, (i + 50) as u8), i * 22_000);
            rec.tick().unwrap();
        }
        rec.checkpoint().unwrap();
        // checkpoint 之后的数据仍在用户态缓冲里，崩溃时丢失
        for i in 20..30u64 {
            rec.ingest(&frame(0, (i + 1) as u8), i * 22_000);
            rec.tick().unwrap();
        }
        rec.crash();

        let out = recover_orphans(dir.path());
        assert_eq!(out.len(), 1);
        let RecoveryOutcome::Recovered { path, frames, .. } = &out[0] else {
            panic!("应恢复成功: {out:?}");
        };
        assert!(
            *frames >= 20,
            "checkpoint 前的 20 帧必须保留，实际 {frames}"
        );
        assert_eq!(path.file_name().unwrap(), "live.artrec");

        let r = ArtRecReader::open_file(path).unwrap();
        assert_eq!(u64::from(r.header().frame_count), *frames);
        let f = r.frame_at(19 * 22_000).unwrap().unwrap();
        assert_eq!(f[0][0], 20);
        assert_eq!(f[1][0], 69);
        assert!(read_sidecar(path).unwrap().recovered);
        // 孤立文件已清理，重复恢复无事发生
        assert!(recover_orphans(dir.path()).is_empty());
    }

    #[test]
    fn crash_before_any_frame_is_discarded() {
        let dir = TempDir::new("crash-empty");
        let rec = FileRecorder::start(params(&dir, "none"), cfg(vec![1])).unwrap();
        rec.crash();
        let out = recover_orphans(dir.path());
        assert!(matches!(
            out.as_slice(),
            [RecoveryOutcome::Discarded { .. }]
        ));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn torn_journal_tail_is_ignored() {
        let dir = TempDir::new("torn");
        let mut rec = FileRecorder::start(params(&dir, "torn"), cfg(vec![1])).unwrap();
        for i in 0..5u64 {
            rec.ingest(&frame(1, (i + 1) as u8), i * 10_000);
            rec.tick().unwrap();
        }
        rec.checkpoint().unwrap();
        rec.crash();
        // 在日志末尾追加半条记录，模拟写入中途断电
        let idx = dir.path().join("torn.artrec.idx");
        let mut j = std::fs::read(&idx).unwrap();
        j.extend_from_slice(&[0xFF; 7]);
        std::fs::write(&idx, j).unwrap();

        let out = recover_orphans(dir.path());
        let [RecoveryOutcome::Recovered { frames, .. }] = out.as_slice() else {
            panic!("{out:?}");
        };
        assert_eq!(*frames, 5);
    }

    #[test]
    fn missing_header_is_reported_failed_and_quarantined() {
        let dir = TempDir::new("bad");
        std::fs::write(dir.path().join(format!("junk{PART_SUFFIX}")), [b'X'; 100]).unwrap();
        // 不足一个文件头的残骸没有可恢复内容，直接清理
        std::fs::write(dir.path().join(format!("tiny{PART_SUFFIX}")), b"nope").unwrap();
        let out = recover_orphans(dir.path());
        assert!(matches!(
            out.as_slice(),
            [
                RecoveryOutcome::Failed { .. },
                RecoveryOutcome::Discarded { .. }
            ]
        ));
        assert!(dir.path().join(format!("junk{PART_SUFFIX}.bad")).exists());
        assert!(!dir.path().join(format!("tiny{PART_SUFFIX}")).exists());
        assert!(recover_orphans(dir.path()).is_empty());
    }

    #[test]
    fn recovery_does_not_overwrite_existing_final_file() {
        let dir = TempDir::new("collide");
        let mut rec = FileRecorder::start(params(&dir, "take"), cfg(vec![1])).unwrap();
        rec.ingest(&frame(1, 9), 0);
        rec.tick().unwrap();
        rec.checkpoint().unwrap();
        rec.crash();
        std::fs::write(dir.path().join("take.artrec"), b"existing").unwrap();

        let out = recover_orphans(dir.path());
        let [RecoveryOutcome::Recovered { path, .. }] = out.as_slice() else {
            panic!("{out:?}");
        };
        assert_eq!(path.file_name().unwrap(), "take-2.artrec");
        assert_eq!(
            std::fs::read(dir.path().join("take.artrec")).unwrap(),
            b"existing"
        );
    }

    // ---- 后台刷盘线程 ----

    /// 录制一步：两路数据都变化，必写一帧；返回写出的帧索引与第 0 路的值。
    fn record_step(rec: &mut FileRecorder, i: u64) -> (FrameIndex, u8) {
        let v = (i % 200) as u8 + 1;
        rec.ingest(&frame(0, v), i * 22_000);
        rec.ingest(&frame(1, v.wrapping_add(100)), i * 22_000);
        let e = rec.tick().unwrap().expect("每步数据都变化，必写一帧");
        (e.index, v)
    }

    /// 固定录制脚本：`ticks` 步，每 5 步一次检查点（最后一步之后必有一次），每次检查点后调用 `after`。
    ///
    /// 返回 `(全部日志条目字节, 最慢检查点耗时, 最慢 tick 耗时, 检查点次数)`。
    fn drive(
        rec: &mut FileRecorder,
        ticks: u64,
        after: impl Fn(&FileRecorder),
    ) -> (Vec<u8>, Duration, Duration, usize) {
        let mut entries = Vec::new();
        let (mut worst_cp, mut worst_tick, mut checkpoints) = (Duration::ZERO, Duration::ZERO, 0);
        for i in 0..ticks {
            let t = Instant::now();
            let (index, _) = record_step(rec, i);
            worst_tick = worst_tick.max(t.elapsed());
            entries.extend_from_slice(&index.to_bytes());
            if i % 5 == 4 || i + 1 == ticks {
                let t = Instant::now();
                rec.checkpoint().unwrap();
                worst_cp = worst_cp.max(t.elapsed());
                checkpoints += 1;
                after(rec);
            }
        }
        (entries, worst_cp, worst_tick, checkpoints)
    }

    /// 每次同步前先 sleep `delay`，并统计 `.part` 的同步次数（≈ 刷盘轮数）。
    fn slow_sync(delay: Duration, part_syncs: Arc<AtomicUsize>) -> SyncFn {
        Arc::new(move |target, f: &File| {
            if target == SyncTarget::Part {
                part_syncs.fetch_add(1, Ordering::SeqCst);
            }
            std::thread::sleep(delay);
            f.sync_data()
        })
    }

    /// 慢速 sync（200ms）不阻塞录制线程：检查点与 tick 都在毫秒级返回；
    /// 忙时交付的条目并入下一轮且一条不丢；最终文件与"每次检查点都等落盘"的同步做法逐字节一致。
    #[test]
    fn slow_sync_does_not_block_ticks_and_keeps_every_entry() {
        let dir = TempDir::new("slow");
        let part_syncs = Arc::new(AtomicUsize::new(0));
        let mut slow = FileRecorder::start_with(
            params(&dir, "slow"),
            cfg(vec![0, 1]),
            slow_sync(Duration::from_millis(200), part_syncs.clone()),
        )
        .unwrap();
        let base = part_syncs.load(Ordering::SeqCst);
        let (entries, worst_cp, worst_tick, checkpoints) = drive(&mut slow, 60, |_| {});
        assert!(
            worst_cp < Duration::from_millis(50),
            "检查点被磁盘阻塞: {worst_cp:?}"
        );
        assert!(
            worst_tick < Duration::from_millis(50),
            "tick 被磁盘阻塞: {worst_tick:?}"
        );

        slow.wait_flushed();
        let journal = std::fs::read(dir.path().join("slow.artrec.idx")).unwrap();
        assert_eq!(journal.len(), 60 * 16);
        assert!(journal == entries, "日志条目必须完整且保持顺序");
        let rounds = part_syncs.load(Ordering::SeqCst) - base;
        assert!(
            (1..checkpoints).contains(&rounds),
            "忙时交付的条目应并入下一轮：{checkpoints} 次检查点、{rounds} 轮刷盘"
        );
        let done_slow = slow.finish(2_000_000).unwrap();

        // 对照：真实同步，且每次检查点后都等刷盘完成（等价于原来的同步检查点）
        let mut sync = FileRecorder::start(params(&dir, "sync"), cfg(vec![0, 1])).unwrap();
        let (entries_sync, ..) = drive(&mut sync, 60, FileRecorder::wait_flushed);
        let journal_sync = std::fs::read(dir.path().join("sync.artrec.idx")).unwrap();
        assert!(journal_sync == entries_sync && entries_sync == entries);
        let done_sync = sync.finish(2_000_000).unwrap();

        assert_eq!(done_slow.stats, done_sync.stats);
        assert!(
            std::fs::read(&done_slow.path).unwrap() == std::fs::read(&done_sync.path).unwrap(),
            "最终文件应逐字节一致"
        );
    }

    /// 让刷盘线程在指定时刻停住，等测试拍下磁盘快照后再放行。
    struct Gate {
        armed: AtomicBool,
        target: SyncTarget,
        after_sync: bool,
        reached: Mutex<mpsc::Sender<()>>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl Gate {
        fn pause(&self) {
            let _ = self.reached.lock().unwrap().send(());
            // 超时兜底：测试失败时不至于让 drop 永远等下去
            let _ = self
                .release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10));
        }
    }

    /// 真实同步，但在 `gate` 武装后第一次命中目标时停住（同步之前或之后）。
    fn gated_sync(gate: Arc<Gate>) -> SyncFn {
        Arc::new(move |target, f: &File| {
            let hit = target == gate.target && gate.armed.swap(false, Ordering::SeqCst);
            if hit && !gate.after_sync {
                gate.pause();
            }
            f.sync_data()?;
            if hit && gate.after_sync {
                gate.pause();
            }
            Ok(())
        })
    }

    /// 对 `dir` 跑恢复：必须恰好恢复出 `expect` 中的帧，且每帧可读、内容正确。
    fn assert_recovers_exactly(dir: &Path, expect: &[(FrameIndex, u8)], label: &str) {
        let out = recover_orphans(dir);
        let [RecoveryOutcome::Recovered { path, frames, .. }] = out.as_slice() else {
            panic!("{label}: {out:?}");
        };
        assert_eq!(*frames, expect.len() as u64, "{label}");
        let r = ArtRecReader::open_file(path).unwrap();
        let want: Vec<FrameIndex> = expect.iter().map(|(fi, _)| *fi).collect();
        assert_eq!(r.index(), want.as_slice(), "{label}");
        for (i, (_, v)) in expect.iter().enumerate() {
            let f = r.resolve_frame(i).unwrap();
            assert_eq!(f[0][0], *v, "{label} frame {i}");
            assert_eq!(f[1][0], v.wrapping_add(100), "{label} frame {i}");
        }
    }

    /// 在刷盘线程一轮的中间时刻"崩溃"（拍下当时的 `.part` 与日志），恢复结果只含日志已确认的帧且全部可读；
    /// 放行后直接丢弃 `FileRecorder`（不 finish），刷盘线程做完已交付工作后退出、不泄漏。
    #[test]
    fn crash_in_the_middle_of_background_flush_recovers_only_durable_frames() {
        for (target, after_sync, confirmed, label) in [
            (SyncTarget::Part, false, 10, "未 sync .part"),
            (SyncTarget::Part, true, 10, "已 sync .part、未写日志"),
            (SyncTarget::Journal, false, 20, "已写日志、未 sync 日志"),
        ] {
            let dir = TempDir::new("midflush");
            let snap = TempDir::new("midflush-snap");
            let (reached_tx, reached_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let gate = Arc::new(Gate {
                armed: AtomicBool::new(false),
                target,
                after_sync,
                reached: Mutex::new(reached_tx),
                release: Mutex::new(release_rx),
            });
            let mut rec = FileRecorder::start_with(
                params(&dir, "mid"),
                cfg(vec![0, 1]),
                gated_sync(gate.clone()),
            )
            .unwrap();
            let mut written = Vec::new();

            // 第一轮：10 帧完整落盘
            for i in 0..10 {
                written.push(record_step(&mut rec, i));
            }
            rec.checkpoint().unwrap();
            rec.wait_flushed();

            // 第二轮：10 帧，刷盘线程在暂停点停住
            gate.armed.store(true, Ordering::SeqCst);
            for i in 10..20 {
                written.push(record_step(&mut rec, i));
            }
            rec.checkpoint().unwrap();
            reached_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("刷盘线程应到达暂停点");
            // 刷盘线程停住期间录制照常进行：第三轮 5 帧已刷到操作系统并交付，排队等下一轮
            for i in 20..25 {
                written.push(record_step(&mut rec, i));
            }
            rec.checkpoint().unwrap();

            // 崩溃瞬间的磁盘内容（进程崩溃：已进入操作系统的数据都在）
            for name in ["mid.artrec.part", "mid.artrec.idx"] {
                let bytes = std::fs::read(dir.path().join(name)).unwrap();
                std::fs::write(snap.path().join(name), bytes).unwrap();
            }
            let journal_at_crash = std::fs::read(snap.path().join("mid.artrec.idx")).unwrap();
            assert_eq!(journal_at_crash.len(), confirmed * 16, "{label}");
            // 全部 25 帧的 Chunk 都已进入操作系统，其中日志尚未确认的部分恢复时应被截掉
            let last = written[written.len() - 1].0;
            let all_chunks_end = u64::from(artrec_core::HEADER_SIZE)
                + 2 * u64::from(artrec_core::UNIDESC_SIZE)
                + u64::from(last.chunk_pos)
                + u64::from(last.chunk_cmp_len);
            assert!(
                std::fs::metadata(snap.path().join("mid.artrec.part"))
                    .unwrap()
                    .len()
                    >= all_chunks_end,
                "{label}: .part 里应有日志尚未确认的 Chunk"
            );

            // 放行并直接丢弃：drop 时刷盘线程做完已交付的两轮再退出
            release_tx.send(()).unwrap();
            drop(rec);
            assert_eq!(
                Arc::strong_count(&gate),
                1,
                "{label}: 刷盘线程应已退出并释放同步钩子"
            );

            assert_recovers_exactly(snap.path(), &written[..confirmed], label);
            assert_recovers_exactly(dir.path(), &written, label);
        }
    }

    /// 录制线程 panic 展开时 `FileRecorder` 被 drop：刷盘线程同样做完已交付工作并退出。
    #[test]
    fn panic_unwind_drops_recorder_and_joins_flush_thread() {
        let dir = TempDir::new("panic");
        let part_syncs = Arc::new(AtomicUsize::new(0));
        let sync = slow_sync(Duration::from_millis(50), part_syncs.clone());
        let hook = Arc::downgrade(&sync);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut rec =
                FileRecorder::start_with(params(&dir, "boom"), cfg(vec![0, 1]), sync).unwrap();
            for i in 0..8 {
                record_step(&mut rec, i);
            }
            rec.checkpoint().unwrap();
            panic!("模拟录制线程 panic");
        }));
        assert!(res.is_err());
        assert!(hook.upgrade().is_none(), "刷盘线程应已退出并释放同步钩子");
        let journal = std::fs::read(dir.path().join("boom.artrec.idx")).unwrap();
        assert_eq!(journal.len(), 8 * 16, "已交付的条目应在退出前写完");
    }

    /// 可随时切换为失败的同步钩子。
    fn failing_sync(fail: Arc<AtomicBool>) -> SyncFn {
        Arc::new(move |_, f: &File| {
            if fail.load(Ordering::SeqCst) {
                Err(std::io::Error::other("模拟磁盘故障"))
            } else {
                f.sync_data()
            }
        })
    }

    /// 后台刷盘的 IO 错误在下一次检查点以 `StoreError::Io` 报告一次；此后检查点继续报错，
    /// 而 `finish` 照原流程收尾。
    #[test]
    fn background_sync_error_is_reported_at_next_checkpoint() {
        let dir = TempDir::new("syncerr");
        let fail = Arc::new(AtomicBool::new(false));
        let mut rec = FileRecorder::start_with(
            params(&dir, "err"),
            cfg(vec![0, 1]),
            failing_sync(fail.clone()),
        )
        .unwrap();
        record_step(&mut rec, 0);
        rec.checkpoint().unwrap();
        rec.wait_flushed();

        fail.store(true, Ordering::SeqCst);
        record_step(&mut rec, 1);
        rec.checkpoint().unwrap(); // 只交付、不等待
        rec.wait_flushed();
        let err = rec.checkpoint().unwrap_err();
        assert!(
            matches!(&err, StoreError::Io(e) if e.to_string().contains("模拟磁盘故障")),
            "{err}"
        );
        assert!(
            matches!(rec.checkpoint(), Err(StoreError::Io(_))),
            "刷盘线程停止后不应静默成功"
        );

        fail.store(false, Ordering::SeqCst);
        let done = rec.finish(100_000).unwrap();
        assert_eq!(done.stats.frames, 3, "两帧 + 收尾帧");
        let r = ArtRecReader::open_file(&done.path).unwrap();
        assert_eq!(u64::from(r.header().frame_count), done.stats.frames);
    }

    /// 尚未报告的后台刷盘错误由 `finish` 报告：不收尾，`.part` 与日志保留，恢复出已确认的帧。
    #[test]
    fn unreported_sync_error_fails_finish_and_keeps_files_for_recovery() {
        let dir = TempDir::new("syncerr-fin");
        let fail = Arc::new(AtomicBool::new(false));
        let mut rec = FileRecorder::start_with(
            params(&dir, "fin"),
            cfg(vec![0, 1]),
            failing_sync(fail.clone()),
        )
        .unwrap();
        let first = record_step(&mut rec, 0);
        rec.checkpoint().unwrap();
        rec.wait_flushed();

        fail.store(true, Ordering::SeqCst);
        record_step(&mut rec, 1);
        rec.checkpoint().unwrap();
        let err = rec.finish(100_000).unwrap_err();
        assert!(matches!(err, StoreError::Io(_)), "{err}");
        assert!(dir.path().join(format!("fin{PART_SUFFIX}")).exists());
        assert!(dir.path().join("fin.artrec.idx").exists());
        assert!(!dir.path().join("fin.artrec").exists());

        assert_recovers_exactly(dir.path(), &[first], "finish 失败后恢复");
    }
}
