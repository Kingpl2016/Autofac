//! 录制控制器：把接收循环里的 `DmxFrame` 旁路到专用录制线程，写出 `.artrec`。
//!
//! 设计要点：
//! - **绝不拖慢接收与转发**：接收循环只做一次 `try_send` 到有界通道，通道满则丢帧并计数。
//! - **独立线程**：写盘与 Zstd 压缩在专用 `std::thread` 中执行，不占用 Tokio 工作线程。
//! - **崩溃安全**：落盘细节（`.part` + 索引日志 + 原子重命名）由 `recorder::FileRecorder` 负责。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use artnet_net::DmxFrame;
use recorder::{
    plan_universes, EncoderConfig, FileRecorder, RecordFilter, RecoveryOutcome, SessionConfig,
    SessionStats, StartParams, UniversePlan,
};
use serde::{Deserialize, Serialize};
use settings::{AppSettings, RecordingCompression};
use signal_engine::{MergeMode, UniverseSnapshot};


/// 录制线程的写帧节拍（约 45Hz，略高于 44Hz 的 DMX 上限以免漏帧）。
const TICK: Duration = Duration::from_millis(22);
/// 检查点（刷盘 + 索引日志落盘）间隔。
const CHECKPOINT_EVERY: Duration = Duration::from_secs(1);
/// 向前端推送统计的间隔。
const STATS_EVERY: Duration = Duration::from_millis(250);
/// 录制通道容量（约 90 个 Universe × 44Hz × 2 秒的余量）。
const CHANNEL_CAP: usize = 16_384;
/// 每轮最多连续排空的帧数，避免长时间不 tick。
const DRAIN_BATCH: usize = 8192;

/// 错误码：已在录制。
pub const ERR_ALREADY_RECORDING: &str = "already_recording";
/// 错误码：没有可录制的 Universe（当前无活跃信号且未手动指定）。
pub const ERR_NO_UNIVERSES: &str = "no_universes";
/// 错误码：当前没有进行中的录制。
pub const ERR_NOT_RECORDING: &str = "not_recording";

/// 启动录制的参数（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartArgs {
    /// 节目显示名。
    #[serde(default)]
    pub name: String,
    /// 备注。
    #[serde(default)]
    pub notes: String,
    /// 文件名主干（前端按本地时间生成，如 `20261025-143012_开场`）；为空则用 Unix 秒。
    #[serde(default)]
    pub file_stem: String,
    /// 过滤条件。
    #[serde(default)]
    pub filter: RecordFilter,
    /// 额外手动指定的 Universe（与"当前活跃且通过过滤的 Universe"取并集）。
    #[serde(default)]
    pub universes: Vec<u16>,
}

/// 启动录制的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartResult {
    /// 最终 `.artrec` 路径（完成后才存在）。
    pub path: String,
    /// Universe 规划结果（含被拒绝项，供 UI 提示）。
    pub plan: UniversePlan,
}

/// 录制实时状态（`recording:stats` 事件载荷与 `recording_status` 返回值）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    /// 是否正在录制。
    pub recording: bool,
    /// 节目显示名。
    pub name: String,
    /// 当前分段的最终路径。
    pub path: String,
    /// 当前分段序号（从 1 起）。
    pub part: u32,
    /// 已录制时长（微秒，当前分段内）。
    pub elapsed_us: u64,
    /// 会话统计。
    pub stats: SessionStats,
    /// 因录制通道已满而丢弃的帧数。
    pub dropped: u64,
    /// 本次录制的 Universe 集合。
    pub universes: Vec<u16>,
}

/// 一个已完成的录制文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishedFile {
    /// `.artrec` 路径。
    pub path: String,
    /// 时长（微秒）。
    pub duration_us: u64,
    /// 帧数。
    pub frames: u64,
    /// 文件字节数。
    pub bytes: u64,
    /// 录到数据的来源 IP。
    pub sources: Vec<String>,
}

/// 一次录制（可能含多个分段）的最终结果。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingResult {
    /// 已完成的文件（按分段顺序）。
    pub files: Vec<FinishedFile>,
    /// 写盘等致命错误（有值时 `.part` 可能仍待下次启动恢复）。
    pub error: Option<String>,
    /// 录制期间丢弃的帧数。
    pub dropped: u64,
}

/// 加锁并忽略中毒（录制线程 panic 后仍要能停止与查询状态）。
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn unix_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

/// 将配置层合并模式映射为引擎合并模式。
fn map_merge(m: settings::MergeMode) -> (MergeMode, &'static str) {
    match m {
        settings::MergeMode::Htp => (MergeMode::Htp, "htp"),
        settings::MergeMode::Ltp => (MergeMode::Ltp, "ltp"),
        settings::MergeMode::Priority => (MergeMode::Priority, "priority"),
    }
}

/// 解析录制目录：配置非空用配置，否则用 `默认目录`。
///
/// # Arguments
///
/// * `configured` - 配置中的录制目录；首尾空白会被忽略，为空表示未配置。
/// * `default_dir` - 未配置时使用的默认录制目录。
///
/// # Returns
///
/// `configured` 去除首尾空白后非空则返回其对应路径，否则返回 `default_dir` 的副本。
#[must_use]
pub fn resolve_dir(configured: &str, default_dir: &Path) -> PathBuf {
    let c = configured.trim();
    if c.is_empty() {
        default_dir.to_path_buf()
    } else {
        PathBuf::from(c)
    }
}

/// 计算本次录制的 Universe 候选：当前活跃且通过过滤的 Universe ∪ 手动指定。
///
/// # Arguments
///
/// * `snapshot` - 当前活跃 Universe 快照；无协议信息时按 Art-Net 处理，无来源信息时只按 Universe 与协议过滤。
/// * `filter` - 录制过滤条件。
/// * `explicit` - 用户手动指定的 Universe，不经过滤直接并入候选。
///
/// # Returns
///
/// 候选 Universe 列表：先是快照中通过过滤的 Universe，随后是 `explicit`；
/// 不做去重与排序，交由 `plan_universes` 规划。
#[must_use]
pub fn candidate_universes(
    snapshot: &[UniverseSnapshot],
    filter: &RecordFilter,
    explicit: &[u16],
) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for u in snapshot {
        let protocol = u.protocol.unwrap_or(artnet_net::Protocol::ArtNet);
        // 没有来源信息时只按 Universe / 协议判断
        let pass = if u.source_ips.is_empty() {
            filter.matches_parts(protocol, u.universe, None)
        } else {
            u.source_ips.iter().any(|ip| {
                filter.matches_parts(protocol, u.universe, ip.parse().ok())
            })
        };
        if pass {
            out.push(u.universe);
        }
    }
    out.extend_from_slice(explicit);
    out
}

/// 事件发射回调：`(事件名, JSON 载荷)`。生产环境由 Tauri `AppHandle` 实现，测试中可替换。
pub type Emitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// 线程上下文：一次录制的全部不变参数。
struct ThreadCtx {
    emit: Emitter,
    base: StartParams,
    cfg: SessionConfig,
    split: Option<Duration>,
    dropped: Arc<AtomicU64>,
    status: Arc<Mutex<RecordingStatus>>,
    recording: Arc<AtomicBool>,
}

/// 进行中的录制句柄。
struct Active {
    handle: JoinHandle<RecordingResult>,
}

struct Inner {
    /// 是否有录制在进行（接收循环热路径只读此原子量）。
    recording: Arc<AtomicBool>,
    tap: Mutex<Option<SyncSender<DmxFrame>>>,
    dropped: Arc<AtomicU64>,
    active: Mutex<Option<Active>>,
    status: Arc<Mutex<RecordingStatus>>,
    recovered: Mutex<Vec<RecoveryOutcome>>,
}

/// 录制控制器（可克隆，内部共享）。
#[derive(Clone)]
pub struct RecordingController {
    inner: Arc<Inner>,
}

impl Default for RecordingController {
    fn default() -> Self {
        Self::new()
    }
}

impl RecordingController {
    /// 创建空闲的控制器。
    ///
    /// # Returns
    ///
    /// 未在录制、丢帧计数为 0 且无恢复结果的 [`RecordingController`]。
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                recording: Arc::new(AtomicBool::new(false)),
                tap: Mutex::new(None),
                dropped: Arc::new(AtomicU64::new(0)),
                active: Mutex::new(None),
                status: Arc::new(Mutex::new(RecordingStatus::default())),
                recovered: Mutex::new(Vec::new()),
            }),
        }
    }

    /// 是否正在录制。
    ///
    /// # Returns
    ///
    /// 有录制在进行时返回 `true`，否则返回 `false`。
    #[must_use]
    pub fn is_recording(&self) -> bool {
        self.inner.recording.load(Ordering::Relaxed)
    }

    /// 接收循环调用：把帧旁路给录制线程。未录制时只有一次原子读取。
    ///
    /// 通道满时丢弃该帧并累加丢帧计数，**不会阻塞**调用方。
    ///
    /// # Arguments
    ///
    /// * `frame` - 接收循环收到的 DMX 帧（内部克隆后送入录制通道）。
    pub fn offer(&self, frame: &DmxFrame) {
        if !self.inner.recording.load(Ordering::Relaxed) {
            return;
        }
        let guard = lock(&self.inner.tap);
        if let Some(tx) = guard.as_ref() {
            if let Err(TrySendError::Full(_)) = tx.try_send(frame.clone()) {
                self.inner.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// 当前状态快照。
    ///
    /// # Returns
    ///
    /// [`RecordingStatus`] 的副本，其中 `recording` 与 `dropped` 取自读取时刻的最新值。
    #[must_use]
    pub fn status(&self) -> RecordingStatus {
        let mut s = lock(&self.inner.status).clone();
        s.recording = self.is_recording();
        s.dropped = self.inner.dropped.load(Ordering::Relaxed);
        s
    }

    /// 取走启动时恢复出的孤立录制结果（取走后清空）。
    ///
    /// # Returns
    ///
    /// 此前通过 [`RecordingController::set_recovered`] 记录的恢复结果；没有或已被取走时为空。
    #[must_use]
    pub fn take_recovered(&self) -> Vec<RecoveryOutcome> {
        std::mem::take(&mut *lock(&self.inner.recovered))
    }

    /// 记录启动时的恢复结果。
    ///
    /// # Arguments
    ///
    /// * `outcomes` - 启动时孤立录制的恢复结果，会覆盖此前记录的内容。
    pub fn set_recovered(&self, outcomes: Vec<RecoveryOutcome>) {
        *lock(&self.inner.recovered) = outcomes;
    }

    /// 开始录制。
    ///
    /// # Arguments
    ///
    /// * `emit` - 事件发射回调（生产环境包装 Tauri `AppHandle::emit`）。
    /// * `cfg` - 当前应用配置（合并模式、压缩、分段）。
    /// * `dir` - 已解析的录制目录。
    /// * `snapshot` - 当前活跃 Universe 快照。
    /// * `args` - 前端提交的参数。
    ///
    /// # Returns
    ///
    /// 最终文件路径与 Universe 规划结果。
    ///
    /// # Errors
    ///
    /// - [`ERR_ALREADY_RECORDING`]：已在录制。
    /// - [`ERR_NO_UNIVERSES`]：没有可录制的 Universe。
    /// - 其它：目录不可写等落盘错误描述。
    pub fn start(
        &self,
        emit: Emitter,
        cfg: &AppSettings,
        dir: PathBuf,
        snapshot: &[UniverseSnapshot],
        args: RecordingStartArgs,
    ) -> Result<RecordingStartResult, String> {
        let split = (cfg.recording.split_minutes > 0)
            .then(|| Duration::from_secs(u64::from(cfg.recording.split_minutes) * 60));
        self.start_inner(emit, cfg, dir, snapshot, args, split)
    }

    /// [`RecordingController::start`] 的实现体，分段时长可直接指定（测试用）。
    fn start_inner(
        &self,
        emit: Emitter,
        cfg: &AppSettings,
        dir: PathBuf,
        snapshot: &[UniverseSnapshot],
        args: RecordingStartArgs,
        split: Option<Duration>,
    ) -> Result<RecordingStartResult, String> {
        let mut active = lock(&self.inner.active);
        if active.is_some() {
            return Err(ERR_ALREADY_RECORDING.to_string());
        }

        let plan = plan_universes(candidate_universes(snapshot, &args.filter, &args.universes));
        if plan.accepted.is_empty() {
            return Err(ERR_NO_UNIVERSES.to_string());
        }

        let (merge_mode, merge_name) = map_merge(cfg.merge.mode);
        let algo = match cfg.recording.compression {
            RecordingCompression::Zstd => artrec_core::CompressAlgo::Zstd,
            RecordingCompression::None => artrec_core::CompressAlgo::None,
        };
        let session_cfg = SessionConfig {
            filter: args.filter,
            universes: plan.accepted.clone(),
            merge_mode,
            encoder: EncoderConfig {
                algo,
                level: cfg.recording.zstd_level,
                ..EncoderConfig::default()
            },
            rec_start_unix_us: unix_micros(),
        };
        let stem = if args.file_stem.trim().is_empty() {
            format!("rec-{}", unix_micros() / 1_000_000)
        } else {
            args.file_stem
        };
        let name = if args.name.trim().is_empty() {
            stem.clone()
        } else {
            args.name
        };
        let base = StartParams {
            dir,
            stem,
            name: name.clone(),
            notes: args.notes,
            created_unix_ms: unix_micros() / 1000,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            merge_mode: merge_name.to_string(),
            source_timeout_ms: u64::from(cfg.merge.source_timeout_ms),
        };

        let first = FileRecorder::start(base.clone(), session_cfg.clone())
            .map_err(|e| e.to_string())?;
        let path = first.final_path().to_string_lossy().into_owned();

        let (tx, rx) = mpsc::sync_channel::<DmxFrame>(CHANNEL_CAP);
        self.inner.dropped.store(0, Ordering::Relaxed);
        *lock(&self.inner.status) = RecordingStatus {
            recording: true,
            name,
            path: path.clone(),
            part: 1,
            universes: plan.accepted.clone(),
            ..RecordingStatus::default()
        };
        *lock(&self.inner.tap) = Some(tx);
        self.inner.recording.store(true, Ordering::Relaxed);

        let ctx = ThreadCtx {
            emit,
            base,
            cfg: session_cfg,
            split,
            dropped: self.inner.dropped.clone(),
            status: self.inner.status.clone(),
            recording: self.inner.recording.clone(),
        };
        let handle = std::thread::Builder::new()
            .name("artrec-recorder".into())
            .spawn(move || record_loop(&ctx, first, &rx))
            .map_err(|e| {
                self.inner.recording.store(false, Ordering::Relaxed);
                *lock(&self.inner.tap) = None;
                e.to_string()
            })?;
        *active = Some(Active { handle });
        Ok(RecordingStartResult { path, plan })
    }

    /// 停止录制并等待收尾完成（**阻塞**，异步命令里请放到 `spawn_blocking`）。
    ///
    /// # Returns
    ///
    /// 本次录制的最终 [`RecordingResult`]（已完成的文件、致命错误与丢帧数）。
    ///
    /// # Errors
    ///
    /// - [`ERR_NOT_RECORDING`]：当前没有进行中的录制。
    /// - 录制线程异常退出时返回描述。
    pub fn stop(&self) -> Result<RecordingResult, String> {
        let Some(active) = lock(&self.inner.active).take() else {
            return Err(ERR_NOT_RECORDING.to_string());
        };
        // 丢弃发送端 → 录制线程排空剩余帧后收尾
        *lock(&self.inner.tap) = None;
        let result = active
            .handle
            .join()
            .map_err(|_| "录制线程异常退出".to_string());
        self.inner.recording.store(false, Ordering::Relaxed);
        lock(&self.inner.status).recording = false;
        result
    }
}

/// 序列化为事件载荷；序列化不会失败，失败时退化为 `null`。
fn to_json<T: Serialize>(v: &T) -> serde_json::Value {
    serde_json::to_value(v).unwrap_or(serde_json::Value::Null)
}

/// 把 `Finished` 转成前端 DTO。
fn to_finished_file(f: &recorder::Finished) -> FinishedFile {
    FinishedFile {
        path: f.path.to_string_lossy().into_owned(),
        duration_us: f.sidecar.duration_us,
        frames: f.sidecar.frames,
        bytes: f.sidecar.bytes,
        sources: f.sidecar.sources.iter().map(ToString::to_string).collect(),
    }
}

/// 录制线程主循环。
fn record_loop(ctx: &ThreadCtx, first: FileRecorder, rx: &Receiver<DmxFrame>) -> RecordingResult {
    let mut result = RecordingResult::default();
    let mut rec = first;
    let mut part: u32 = 1;
    let mut t0 = Instant::now();
    let mut next_tick = t0 + TICK;
    let mut next_checkpoint = t0 + CHECKPOINT_EVERY;
    let mut next_stats = t0 + STATS_EVERY;

    'outer: loop {
        let mut disconnected = false;
        match rx.recv_timeout(TICK) {
            Ok(f) => feed(&mut rec, &f, t0),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => disconnected = true,
        }
        for _ in 0..DRAIN_BATCH {
            match rx.try_recv() {
                Ok(f) => feed(&mut rec, &f, t0),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }

        let now = Instant::now();
        if now >= next_tick {
            if let Err(e) = rec.tick() {
                result.error = Some(e.to_string());
                break 'outer;
            }
            next_tick = now + TICK;
        }
        if now >= next_checkpoint {
            if let Err(e) = rec.checkpoint() {
                result.error = Some(e.to_string());
                break 'outer;
            }
            next_checkpoint = now + CHECKPOINT_EVERY;
        }
        if now >= next_stats {
            publish(ctx, &rec, part, t0);
            next_stats = now + STATS_EVERY;
        }

        // 自动分段：收尾当前文件，立即在同目录开始下一段（Universe 集合保持不变）
        if !disconnected && ctx.split.is_some_and(|s| now.duration_since(t0) >= s) {
            let total = now.duration_since(t0).as_micros() as u64;
            match rec.finish(total) {
                Ok(done) => result.files.push(to_finished_file(&done)),
                Err(e) => {
                    result.error = Some(e.to_string());
                    result.dropped = ctx.dropped.load(Ordering::Relaxed);
                    finish_flags(ctx, &result);
                    return result;
                }
            }
            part += 1;
            let mut params = ctx.base.clone();
            params.stem = format!("{}-part{part}", ctx.base.stem);
            params.name = format!("{} ({part})", ctx.base.name);
            params.created_unix_ms = unix_micros() / 1000;
            match FileRecorder::start(params, ctx.cfg.clone()) {
                Ok(next) => {
                    rec = next;
                    t0 = Instant::now();
                    next_tick = t0 + TICK;
                    next_checkpoint = t0 + CHECKPOINT_EVERY;
                    next_stats = t0 + STATS_EVERY;
                }
                Err(e) => {
                    result.error = Some(e.to_string());
                    result.dropped = ctx.dropped.load(Ordering::Relaxed);
                    finish_flags(ctx, &result);
                    return result;
                }
            }
        }

        if disconnected {
            break;
        }
    }

    let total = t0.elapsed().as_micros() as u64;
    match rec.finish(total) {
        Ok(done) => result.files.push(to_finished_file(&done)),
        Err(e) => {
            result.error.get_or_insert_with(|| e.to_string());
        }
    }
    result.dropped = ctx.dropped.load(Ordering::Relaxed);
    finish_flags(ctx, &result);
    result
}

/// 摄入一帧，时间戳取接收点的单调时刻。
fn feed(rec: &mut FileRecorder, frame: &DmxFrame, t0: Instant) {
    let t_us = frame.received_at.saturating_duration_since(t0).as_micros() as u64;
    rec.ingest(frame, t_us);
}

/// 刷新共享状态并向前端推送 `recording:stats`。
fn publish(ctx: &ThreadCtx, rec: &FileRecorder, part: u32, t0: Instant) {
    let status = {
        let mut s = lock(&ctx.status);
        s.recording = true;
        s.part = part;
        s.path = rec.final_path().to_string_lossy().into_owned();
        s.elapsed_us = t0.elapsed().as_micros() as u64;
        s.stats = rec.stats();
        s.dropped = ctx.dropped.load(Ordering::Relaxed);
        s.clone()
    };
    (ctx.emit)("recording:stats", to_json(&status));
}

/// 录制结束：复位状态并通知前端。
fn finish_flags(ctx: &ThreadCtx, result: &RecordingResult) {
    ctx.recording.store(false, Ordering::Relaxed);
    let status = {
        let mut s = lock(&ctx.status);
        s.recording = false;
        s.clone()
    };
    (ctx.emit)("recording:stats", to_json(&status));
    (ctx.emit)("recording:finished", to_json(result));
}

#[cfg(test)]
mod tests {
    use super::{candidate_universes, resolve_dir};
    use artnet_net::Protocol;
    use recorder::{RecordFilter, UniverseRange};
    use signal_engine::UniverseSnapshot;
    use std::path::Path;

    fn snap(universe: u16, protocol: Protocol, ips: &[&str]) -> UniverseSnapshot {
        UniverseSnapshot {
            universe,
            protocol: Some(protocol),
            source_ips: ips.iter().map(ToString::to_string).collect(),
            source_count: ips.len(),
            active_channels: 1,
            conflict_channels: 0,
            total_packets: 1,
        }
    }

    #[test]
    fn candidates_follow_source_filter() {
        let snapshot = vec![
            snap(1, Protocol::ArtNet, &["10.0.0.1"]),
            snap(2, Protocol::ArtNet, &["10.0.0.2"]),
            snap(3, Protocol::ArtNet, &["10.0.0.1", "10.0.0.2"]),
        ];
        let filter = RecordFilter {
            sources: vec!["10.0.0.1".parse().unwrap()],
            ..RecordFilter::default()
        };
        assert_eq!(candidate_universes(&snapshot, &filter, &[]), vec![1, 3]);
    }

    #[test]
    fn candidates_respect_universe_range_protocol_and_explicit() {
        let snapshot = vec![
            snap(1, Protocol::ArtNet, &["10.0.0.1"]),
            snap(9, Protocol::Sacn, &["10.0.0.1"]),
        ];
        let filter = RecordFilter {
            universes: vec![UniverseRange { start: 0, end: 5 }],
            protocols: vec![Protocol::ArtNet],
            ..RecordFilter::default()
        };
        assert_eq!(candidate_universes(&snapshot, &filter, &[40, 41]), vec![1, 40, 41]);
    }

    #[test]
    fn blank_dir_uses_default() {
        assert_eq!(resolve_dir("  ", Path::new("/d")), Path::new("/d"));
        assert_eq!(resolve_dir("/x", Path::new("/d")), Path::new("/x"));
    }

    // ---- 端到端：控制器 + 录制线程 + 真实文件 ----

    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use artnet_net::DmxFrame;
    use artrec_core::ArtRecReader;
    use settings::AppSettings;

    use super::{
        Emitter, RecordingController, RecordingStartArgs, ERR_ALREADY_RECORDING, ERR_NOT_RECORDING,
        ERR_NO_UNIVERSES,
    };

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "artnet-studio-rec-{tag}-{}-{}",
                std::process::id(),
                Instant::now().elapsed().as_nanos() ^ u128::from(rand_suffix())
            ));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn rand_suffix() -> u32 {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    }

    fn noop() -> Emitter {
        Arc::new(|_, _| {})
    }

    fn dmx(universe: u16, ip: &str, v: u8) -> DmxFrame {
        DmxFrame {
            protocol: Protocol::ArtNet,
            universe,
            data: vec![v; 8],
            source: Some(ip.parse().unwrap()),
            sequence: 0,
            received_at: Instant::now(),
        }
    }

    fn args(stem: &str, filter: RecordFilter, universes: Vec<u16>) -> RecordingStartArgs {
        RecordingStartArgs {
            name: stem.into(),
            notes: String::new(),
            file_stem: stem.into(),
            filter,
            universes,
        }
    }

    #[test]
    fn end_to_end_records_only_selected_source() {
        let tmp = Tmp::new("e2e");
        let ctl = RecordingController::new();
        let snapshot = vec![snap(1, Protocol::ArtNet, &["10.0.0.1", "10.0.0.2"])];
        let filter = RecordFilter {
            sources: vec!["10.0.0.1".parse().unwrap()],
            ..RecordFilter::default()
        };
        let started = ctl
            .start(noop(), &AppSettings::default(), tmp.0.clone(), &snapshot, args("e2e", filter, vec![]))
            .unwrap();
        assert_eq!(started.plan.accepted, vec![1]);
        assert!(ctl.is_recording());

        for i in 0..40u8 {
            ctl.offer(&dmx(1, "10.0.0.1", i + 1));
            ctl.offer(&dmx(1, "10.0.0.2", 200)); // 被过滤的设备
            std::thread::sleep(Duration::from_millis(5));
        }
        let out = ctl.stop().unwrap();
        assert!(!ctl.is_recording());
        assert!(out.error.is_none(), "{:?}", out.error);
        assert_eq!(out.dropped, 0);
        assert_eq!(out.files.len(), 1);
        let file = &out.files[0];
        assert_eq!(file.sources, vec!["10.0.0.1".to_string()]);
        assert!(file.frames >= 2, "frames={}", file.frames);

        let r = ArtRecReader::open_file(std::path::Path::new(&file.path)).unwrap();
        let mut last = 0u8;
        for i in 0..r.index().len() {
            let f = r.resolve_frame(i).unwrap();
            assert_ne!(f[0][0], 200, "被过滤设备的数据不应出现在文件里");
            assert!(f[0][0] >= last, "录制值应随时间单调递增");
            last = f[0][0];
        }
        assert_eq!(last, 40, "最终应录到该设备的最后一个值");
    }

    #[test]
    fn start_stop_error_codes() {
        let tmp = Tmp::new("errs");
        let ctl = RecordingController::new();
        let cfg = AppSettings::default();
        assert_eq!(ctl.stop().unwrap_err(), ERR_NOT_RECORDING);
        // 无活跃信号且未手动指定
        let e = ctl
            .start(noop(), &cfg, tmp.0.clone(), &[], args("x", RecordFilter::default(), vec![]))
            .unwrap_err();
        assert_eq!(e, ERR_NO_UNIVERSES);
        // 手动指定 Universe 可在无信号时武装录制
        ctl.start(noop(), &cfg, tmp.0.clone(), &[], args("x", RecordFilter::default(), vec![5]))
            .unwrap();
        let again = ctl
            .start(noop(), &cfg, tmp.0.clone(), &[], args("y", RecordFilter::default(), vec![5]))
            .unwrap_err();
        assert_eq!(again, ERR_ALREADY_RECORDING);
        let out = ctl.stop().unwrap();
        assert_eq!(out.files.len(), 1);
        assert_eq!(out.files[0].frames, 0);
    }

    /// 录制目录不可用（这里用"目标是一个已存在的文件"模拟）时给出错误，控制器保持空闲、可重试。
    #[test]
    fn unusable_directory_fails_cleanly_and_leaves_controller_idle() {
        let tmp = Tmp::new("baddir");
        let not_a_dir = tmp.0.join("occupied");
        std::fs::write(&not_a_dir, b"x").unwrap();
        let ctl = RecordingController::new();
        let snapshot = vec![snap(1, Protocol::ArtNet, &["10.0.0.1"])];
        let cfg = AppSettings::default();

        let err = ctl
            .start(noop(), &cfg, not_a_dir, &snapshot, args("x", RecordFilter::default(), vec![]))
            .unwrap_err();
        assert!(!err.is_empty() && err != ERR_ALREADY_RECORDING);
        assert!(!ctl.is_recording());
        assert_eq!(ctl.stop().unwrap_err(), ERR_NOT_RECORDING);

        // 换一个可写目录即可正常录制
        let good = tmp.0.join("good");
        ctl.start(noop(), &cfg, good, &snapshot, args("y", RecordFilter::default(), vec![]))
            .unwrap();
        ctl.stop().unwrap();
    }

    /// 压力：50 个 Universe × 44Hz 持续约 2 秒，不应丢帧，且录出的文件完整可读。
    #[test]
    fn sustained_fifty_universe_load_drops_nothing() {
        let tmp = Tmp::new("stress");
        let ctl = RecordingController::new();
        let snapshot: Vec<_> = (0..50u16).map(|u| snap(u, Protocol::ArtNet, &["10.0.0.1"])).collect();
        ctl.start(noop(), &AppSettings::default(), tmp.0.clone(), &snapshot, args("load", RecordFilter::default(), vec![]))
            .unwrap();

        let producer = {
            let ctl = ctl.clone();
            std::thread::spawn(move || {
                for i in 0..88u32 {
                    let tick = Instant::now();
                    for u in 0..50u16 {
                        let mut f = dmx(u, "10.0.0.1", (i % 250) as u8 + 1);
                        f.data = vec![(i % 250) as u8 + 1; 512];
                        ctl.offer(&f);
                    }
                    if let Some(rest) = Duration::from_millis(22).checked_sub(tick.elapsed()) {
                        std::thread::sleep(rest);
                    }
                }
            })
        };
        producer.join().unwrap();
        let out = ctl.stop().unwrap();

        assert!(out.error.is_none(), "{:?}", out.error);
        assert_eq!(out.dropped, 0, "录制通道不应拥塞");
        let file = &out.files[0];
        assert!(file.frames >= 40, "frames={}", file.frames);
        let r = ArtRecReader::open_file(std::path::Path::new(&file.path)).unwrap();
        assert_eq!(r.unis().len(), 50);
        // 每一帧都能完整解出。录制节拍与生产者互相独立，一次快照可能恰好落在
        // 两轮更新之间（部分 Universe 已更新、部分还是上一轮的值），所以只要求各路
        // 数据最多相差一轮（与真实网络到达的撕裂语义一致），而不是完全相同。
        for i in 0..r.index().len() {
            let f = r.resolve_frame(i).unwrap();
            let lo = f.iter().map(|b| b[0]).min().unwrap();
            let hi = f.iter().map(|b| b[0]).max().unwrap();
            assert!(hi - lo <= 1, "frame {i}: 各路数据相差 {}", hi - lo);
        }
    }

    #[test]
    fn rejected_universes_are_reported_in_plan() {
        let tmp = Tmp::new("plan");
        let ctl = RecordingController::new();
        let snapshot = vec![snap(3, Protocol::ArtNet, &["10.0.0.1"]), snap(5000, Protocol::ArtNet, &["10.0.0.1"])];
        let started = ctl
            .start(noop(), &AppSettings::default(), tmp.0.clone(), &snapshot, args("p", RecordFilter::default(), vec![]))
            .unwrap();
        assert_eq!(started.plan.accepted, vec![3]);
        assert_eq!(started.plan.rejected_out_of_range, vec![5000]);
        ctl.stop().unwrap();
    }

    #[test]
    fn auto_split_rolls_over_to_new_files() {
        let tmp = Tmp::new("split");
        let ctl = RecordingController::new();
        let snapshot = vec![snap(1, Protocol::ArtNet, &["10.0.0.1"])];
        ctl.start_inner(
            noop(),
            &AppSettings::default(),
            tmp.0.clone(),
            &snapshot,
            args("seg", RecordFilter::default(), vec![]),
            Some(Duration::from_millis(200)),
        )
        .unwrap();
        for i in 0..60u8 {
            ctl.offer(&dmx(1, "10.0.0.1", i + 1));
            std::thread::sleep(Duration::from_millis(10));
        }
        let out = ctl.stop().unwrap();
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(out.files.len() >= 2, "应至少分成两段，实际 {}", out.files.len());
        for f in &out.files {
            ArtRecReader::open_file(std::path::Path::new(&f.path)).unwrap();
        }
        assert!(out.files[1].path.contains("seg-part2"));
    }
}
