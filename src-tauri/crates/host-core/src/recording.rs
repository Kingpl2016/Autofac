//! 录制控制器：把接收循环里的 `DmxFrame` 旁路到专用录制线程，写出 `.artrec`。
//!
//! 设计要点：
//! - **绝不拖慢接收与转发**：接收循环只做一次 `try_send` 到有界通道，通道满则丢帧并计数。
//! - **独立线程**：写盘与 Zstd 压缩在专用 `std::thread` 中执行，不占用 Tokio 工作线程。
//! - **崩溃安全**：落盘细节（`.part` + 索引日志 + 原子重命名）由 `recorder::FileRecorder` 负责。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;

use parking_lot::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use arc_swap::ArcSwapOption;
use artnet_net::DmxFrame;
use recorder::{
    can_start, plan_universes, ActivityDelta, ActivityTimeline, DiskGuard, DiskLevel,
    EncoderConfig, FileRecorder, RecordFilter, RecoveryOutcome, SessionConfig, SessionStats,
    StartParams, UniversePlan,
};
use serde::{Deserialize, Serialize};
use settings::{AppSettings, RecordingCompression};
use signal_engine::UniverseSnapshot;

use crate::mode::{FrameSink, RuntimeMode};
use crate::util::lock;

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
/// 录制期间检查磁盘剩余空间的间隔。
const DISK_CHECK_EVERY: Duration = Duration::from_secs(10);

/// 错误码：已在录制。
pub const ERR_ALREADY_RECORDING: &str = "already_recording";
/// 错误码：没有可录制的 Universe（当前无活跃信号且未手动指定）。
pub const ERR_NO_UNIVERSES: &str = "no_universes";
/// 错误码：当前没有进行中的录制。
pub const ERR_NOT_RECORDING: &str = "not_recording";
/// 错误码：录制目录所在卷的剩余空间不足以开始录制。
pub const ERR_DISK_LOW: &str = "disk_low";

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
    /// 整个录制会话的时长（微秒，跨分段累加）。
    pub session_elapsed_us: u64,
    /// 各分段在会话时间轴上的起点（微秒，升序；第一段为 0；未录制时为空）。
    pub part_starts_us: Vec<u64>,
    /// 会话统计。
    pub stats: SessionStats,
    /// 因录制通道已满而丢弃的帧数。
    pub dropped: u64,
    /// 本次录制的 Universe 集合。
    pub universes: Vec<u16>,
    /// 录制目录所在卷的剩余字节数；无法查询时为 `None`。
    pub disk_free_bytes: Option<u64>,
    /// 最近一次检查得到的磁盘空间等级。
    pub disk_level: DiskLevel,
}

/// 录制活动时间线的前端 DTO（行数据为 Base64 字符串，与时间线概览同一编码）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDto {
    /// 桶布局代次，每次合并桶加一。
    pub generation: u32,
    /// 桶宽（微秒）。
    pub bucket_us: u64,
    /// 时间线当前总桶数。
    pub len: usize,
    /// 本次数据覆盖的第一个桶下标。
    pub from: usize,
    /// 各行对应的 Universe 编号。
    pub universes: Vec<u16>,
    /// 变化强度行（Base64，每字节一个桶，0~255）。
    pub change: Vec<String>,
    /// 最大电平行（Base64，每字节一个桶，0~255）。
    pub level: Vec<String>,
    /// 各分段在会话时间轴上的起点（微秒）。
    pub part_starts_us: Vec<u64>,
}

impl From<ActivityDelta> for ActivityDto {
    fn from(d: ActivityDelta) -> Self {
        Self {
            generation: d.generation,
            bucket_us: d.bucket_us,
            len: d.len,
            from: d.from,
            universes: d.universes,
            change: d.change.iter().map(|r| player::b64::encode(r)).collect(),
            level: d.level.iter().map(|r| player::b64::encode(r)).collect(),
            part_starts_us: d.part_starts_us,
        }
    }
}

/// `recording:stats` 事件载荷：录制状态 + 自上次推送以来的活动时间线增量。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsEvent<'a> {
    /// 录制状态（字段平铺到载荷顶层，与 `recording_status` 返回值同形）。
    #[serde(flatten)]
    status: &'a RecordingStatus,
    /// 活动时间线增量。
    activity: ActivityDto,
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
    /// 非用户主动停止时的原因；用户正常停止时为 `None`。
    pub stopped_by: Option<StopReason>,
}

/// 录制被自动停止的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    /// 磁盘剩余空间低于临界值，已自动收尾并停止。
    Disk,
}

/// 录制目录所在卷的空间信息（`recording_disk_info` 返回值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    /// 被查询的目录。
    pub path: String,
    /// 剩余字节数；无法查询（目录及其上级都不存在、平台不支持等）时为 `None`。
    pub free_bytes: Option<u64>,
    /// 空间等级；无法查询时为 [`DiskLevel::Ok`]。
    pub level: DiskLevel,
    /// 是否允许开始录制；无法查询时为 `true`（不因查询失败而阻止录制）。
    pub can_start: bool,
}

/// 对一个候选录制目录的检查结果（`recording_check_dir` 返回值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirCheck {
    /// 被检查的目录。
    pub path: String,
    /// 路径是否已存在（文件或目录均算）。
    pub exists: bool,
    /// 路径是否是目录；已存在却不是目录（例如是一个文件）时为 `false`。
    pub is_dir: bool,
    /// 能否在该目录写入：目录尚未创建时检查其最近一个已存在的上级目录。
    pub writable: bool,
    /// 所在卷的剩余空间信息。
    pub disk: DiskInfo,
}

/// 探测 `dir` 是否可写：创建并立即删除一个唯一命名的临时文件。
///
/// # Arguments
///
/// * `dir` - 一个已存在的目录。
///
/// # Returns
///
/// 能创建临时文件时为 `true`。
fn probe_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".artnet-studio-write-test-{}", std::process::id()));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 剩余空间查询函数：输入目录，返回其所在卷的可用字节数；无法查询时返回 `None`。
pub type FreeSpaceFn = Arc<dyn Fn(&Path) -> Option<u64> + Send + Sync>;

/// 真实的剩余空间查询：取 `path` 最近一个已存在的上级目录所在卷的可用字节数。
///
/// # Arguments
///
/// * `path` - 录制目录；目录尚未创建时向上寻找已存在的祖先。
///
/// # Returns
///
/// 可用字节数；路径上没有已存在的目录或系统调用失败时为 `None`。
#[must_use]
pub fn real_free_space(path: &Path) -> Option<u64> {
    path.ancestors()
        .find(|p| p.exists())
        .and_then(|p| fs4::available_space(p).ok())
}

fn unix_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
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
            u.source_ips
                .iter()
                .any(|ip| filter.matches_parts(protocol, u.universe, ip.parse().ok()))
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
    mode: Arc<RuntimeMode>,
    free_space: FreeSpaceFn,
    /// 磁盘空间检查间隔。
    disk_every: Duration,
    /// 本次录制的活动时间线（录制线程写，`recording_activity` 命令读）。
    activity: Arc<Mutex<ActivityTimeline>>,
}

/// 进行中的录制句柄。
struct Active {
    handle: JoinHandle<RecordingResult>,
}

struct Inner {
    /// 录制 / 回放互斥仲裁（录制状态即 `mode.is_recording()`，接收循环热路径只读）。
    mode: Arc<RuntimeMode>,
    /// 录制旁路的发送端：接收循环热路径无锁读取；置空即断开通道，录制线程排空剩余帧后收尾。
    tap: ArcSwapOption<SyncSender<DmxFrame>>,
    dropped: Arc<AtomicU64>,
    active: Mutex<Option<Active>>,
    status: Arc<Mutex<RecordingStatus>>,
    recovered: Mutex<Vec<RecoveryOutcome>>,
    free_space: FreeSpaceFn,
    /// 磁盘空间检查间隔（毫秒）；生产环境恒为 [`DISK_CHECK_EVERY`]，测试可缩短。
    disk_every_ms: AtomicU64,
    /// 最近一次录制的活动时间线（开始录制时复位，停止后保留到下次开始）。
    activity: Arc<Mutex<ActivityTimeline>>,
}

impl FrameSink for Inner {
    /// 把一帧旁路给录制线程。未录制时只有一次原子读取；录制中无锁读取发送端；
    /// 通道满时丢弃并计数，绝不阻塞。
    fn offer(&self, frame: &DmxFrame) {
        if !self.mode.is_recording() {
            return;
        }
        let tap = self.tap.load();
        if let Some(tx) = tap.as_deref()
            && let Err(TrySendError::Full(_)) = tx.try_send(frame.clone()) {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
    }
}

/// 录制控制器（可克隆，内部共享）。
#[derive(Clone)]
pub struct RecordingController {
    inner: Arc<Inner>,
}

impl Default for RecordingController {
    fn default() -> Self {
        Self::new(Arc::new(RuntimeMode::new()))
    }
}

impl RecordingController {
    /// 以共享的运行时仲裁创建空闲控制器。
    ///
    /// # Arguments
    ///
    /// * `mode` - 录制 / 回放互斥仲裁，与接收循环及回放控制器共享。
    ///
    /// # Returns
    ///
    /// 未在录制、丢帧计数为 0 且无恢复结果的 [`RecordingController`]。
    #[must_use]
    pub fn new(mode: Arc<RuntimeMode>) -> Self {
        Self::with_free_space(mode, Arc::new(real_free_space))
    }

    /// 与 [`RecordingController::new`] 相同，但可注入剩余空间查询（测试用）。
    ///
    /// # Arguments
    ///
    /// * `mode` - 录制 / 回放互斥仲裁，与接收循环及回放控制器共享。
    /// * `free_space` - 剩余空间查询函数。
    ///
    /// # Returns
    ///
    /// 使用给定查询函数的空闲 [`RecordingController`]。
    #[must_use]
    pub fn with_free_space(mode: Arc<RuntimeMode>, free_space: FreeSpaceFn) -> Self {
        Self {
            inner: Arc::new(Inner {
                mode,
                tap: ArcSwapOption::empty(),
                dropped: Arc::new(AtomicU64::new(0)),
                active: Mutex::new(None),
                status: Arc::new(Mutex::new(RecordingStatus::default())),
                recovered: Mutex::new(Vec::new()),
                free_space,
                disk_every_ms: AtomicU64::new(DISK_CHECK_EVERY.as_millis() as u64),
                activity: Arc::new(Mutex::new(ActivityTimeline::new(Vec::new()))),
            }),
        }
    }

    /// 检查一个候选录制目录：是否存在、是不是目录、能否写入，以及所在卷的剩余空间。
    ///
    /// 只做只读探测（写入测试用的临时文件会被立即删除），**不会**创建目录。
    ///
    /// # Arguments
    ///
    /// * `dir` - 候选录制目录（可以尚未创建）。
    ///
    /// # Returns
    ///
    /// 汇总的 [`DirCheck`]。目录尚未创建时，`writable` 反映其最近一个已存在上级目录的可写性。
    #[must_use]
    pub fn check_dir(&self, dir: &Path) -> DirCheck {
        let exists = dir.exists();
        let is_dir = dir.is_dir();
        // 以最近一个已存在的路径为准：它必须是目录且可写；若它是文件（路径经过文件），则不可写
        let writable = match dir.ancestors().find(|p| p.exists()) {
            Some(p) if p.is_dir() => probe_writable(p),
            _ => false,
        };
        DirCheck {
            path: dir.to_string_lossy().into_owned(),
            exists,
            is_dir,
            writable,
            disk: self.disk_info(dir),
        }
    }

    /// 缩短磁盘空间检查间隔（测试用）。
    ///
    /// # Arguments
    ///
    /// * `every` - 新的检查间隔，对此后开始的录制生效。
    #[cfg(test)]
    pub fn set_disk_check_interval(&self, every: Duration) {
        self.inner
            .disk_every_ms
            .store(every.as_millis() as u64, Ordering::Relaxed);
    }

    /// 查询录制目录所在卷的空间信息。
    ///
    /// # Arguments
    ///
    /// * `dir` - 录制目录（可以尚未创建）。
    ///
    /// # Returns
    ///
    /// 剩余字节数、等级以及是否允许开始录制的 [`DiskInfo`]。
    #[must_use]
    pub fn disk_info(&self, dir: &Path) -> DiskInfo {
        let free = (self.inner.free_space)(dir);
        DiskInfo {
            path: dir.to_string_lossy().into_owned(),
            free_bytes: free,
            level: free.map_or(DiskLevel::Ok, recorder::classify),
            can_start: free.is_none_or(can_start),
        }
    }

    /// 本控制器的帧接收器（弱引用），供接收循环的 [`crate::mode::FrameFanout`] 注册。
    ///
    /// # Returns
    ///
    /// 指向内部状态的 [`FrameSink`] 弱引用；控制器存活期间有效。
    #[must_use]
    pub fn sink(&self) -> Weak<dyn FrameSink> {
        // 先把 Arc<Inner> 向上转型为 Arc<dyn FrameSink>，再降级为弱引用。
        let arc: Arc<dyn FrameSink> = self.inner.clone();
        Arc::downgrade(&arc)
    }

    /// 是否正在录制。
    ///
    /// # Returns
    ///
    /// 有录制在进行时返回 `true`，否则返回 `false`。
    #[must_use]
    pub fn is_recording(&self) -> bool {
        self.inner.mode.is_recording()
    }

    /// 直接把一帧旁路给录制线程（测试便捷封装）。
    ///
    /// 生产路径由接收循环经 [`crate::mode::FrameFanout`] 回调 [`FrameSink::offer`]，
    /// 不走此方法。通道满时丢弃并计数，**不会阻塞**。
    ///
    /// # Arguments
    ///
    /// * `frame` - 要旁路的 DMX 帧（内部克隆后送入录制通道）。
    #[cfg(test)]
    pub fn offer(&self, frame: &DmxFrame) {
        self.inner.offer(frame);
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

    /// 最近一次录制的活动时间线全量快照（`recording_activity` 命令用）。
    ///
    /// 前端中途打开页面、或桶布局代次与本地不一致时，用它一次取回全部桶。
    ///
    /// # Returns
    ///
    /// 全量 [`ActivityDto`]（`from = 0`）。从未录制过时总桶数为 0、Universe 集合为空；
    /// 录制停止后保留最后一次录制的数据，直到下次开始录制。
    #[must_use]
    pub fn activity(&self) -> ActivityDto {
        lock(&self.inner.activity).snapshot().into()
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
    /// - [`ERR_DISK_LOW`]：录制目录所在卷的剩余空间不足 500 MB。
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
        if let Some(a) = active.as_ref() {
            if !a.handle.is_finished() {
                return Err(ERR_ALREADY_RECORDING.to_string());
            }
            // 线程已自行结束（磁盘告急 / 写盘错误）：结果早已通过 `recording:finished` 送达，
            // 这里回收句柄，让用户无需先调用 `stop` 就能再次开始录制。
            if let Some(done) = active.take() {
                let _ = done.handle.join();
            }
            self.inner.tap.store(None);
        }

        let plan = plan_universes(candidate_universes(snapshot, &args.filter, &args.universes));
        if plan.accepted.is_empty() {
            return Err(ERR_NO_UNIVERSES.to_string());
        }

        let merge_mode = cfg.merge.mode;
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
            merge_mode: merge_mode.as_str().to_string(),
            source_timeout_ms: u64::from(cfg.merge.source_timeout_ms),
        };

        let free_now = (self.inner.free_space)(&base.dir);
        if free_now.is_some_and(|f| !can_start(f)) {
            return Err(ERR_DISK_LOW.to_string());
        }

        let first =
            FileRecorder::start(base.clone(), session_cfg.clone()).map_err(|e| e.to_string())?;
        let path = first.final_path().to_string_lossy().into_owned();

        let (tx, rx) = mpsc::sync_channel::<DmxFrame>(CHANNEL_CAP);
        self.inner.dropped.store(0, Ordering::Relaxed);
        *lock(&self.inner.status) = RecordingStatus {
            recording: true,
            name,
            path: path.clone(),
            part: 1,
            part_starts_us: vec![0],
            universes: plan.accepted.clone(),
            disk_free_bytes: free_now,
            disk_level: free_now.map_or(DiskLevel::Ok, recorder::classify),
            ..RecordingStatus::default()
        };
        lock(&self.inner.activity).reset(first.universes().to_vec());
        self.inner.tap.store(Some(Arc::new(tx)));
        self.inner.mode.set_recording(true);

        let ctx = ThreadCtx {
            emit,
            base,
            cfg: session_cfg,
            split,
            dropped: self.inner.dropped.clone(),
            status: self.inner.status.clone(),
            mode: self.inner.mode.clone(),
            free_space: self.inner.free_space.clone(),
            disk_every: Duration::from_millis(self.inner.disk_every_ms.load(Ordering::Relaxed)),
            activity: self.inner.activity.clone(),
        };
        let handle = std::thread::Builder::new()
            .name("artrec-recorder".into())
            .spawn(move || record_loop(&ctx, first, &rx))
            .map_err(|e| {
                self.inner.mode.set_recording(false);
                self.inner.tap.store(None);
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
        // 丢弃发送端 → 录制线程排空剩余帧后收尾（正在 `offer` 的读者释放其临时引用后通道即断开）
        self.inner.tap.store(None);
        let result = active
            .handle
            .join()
            .map_err(|_| "录制线程异常退出".to_string());
        self.inner.mode.set_recording(false);
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
    // 当前分段在会话时间轴上的起点（微秒）：活动时间线与会话时长跨分段累加
    let mut part_offset: u64 = 0;
    let mut t0 = Instant::now();
    let mut next_tick = t0 + TICK;
    let mut next_checkpoint = t0 + CHECKPOINT_EVERY;
    let mut next_stats = t0 + STATS_EVERY;
    let mut next_disk = t0 + ctx.disk_every;
    let mut guard = DiskGuard::new();
    // 开始时先查一次：偏低就立刻告警，而不是等 10 秒
    if check_disk(ctx, &mut guard) == Some(DiskLevel::Critical) {
        result.stopped_by = Some(StopReason::Disk);
    }

    'outer: loop {
        if result.stopped_by.is_some() {
            break;
        }
        let mut disconnected = false;
        // 最多等到下一个节拍时刻，空闲时也能按时 tick
        let wait = next_tick
            .saturating_duration_since(Instant::now())
            .min(TICK);
        match rx.recv_timeout(wait) {
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
            match rec.tick() {
                Ok(Some(enc)) => {
                    lock(&ctx.activity).observe(part_offset + enc.index.time_us, rec.snapshot());
                }
                Ok(None) => {}
                Err(e) => {
                    result.error = Some(e.to_string());
                    break 'outer;
                }
            }
            // 按绝对时刻推进，不累积漂移；落后超过一个 TICK 时直接对齐到当前时刻，避免连续追帧
            next_tick += TICK;
            if now > next_tick {
                next_tick = now + TICK;
            }
        }
        if now >= next_checkpoint {
            if let Err(e) = rec.checkpoint() {
                result.error = Some(e.to_string());
                break 'outer;
            }
            next_checkpoint = now + CHECKPOINT_EVERY;
        }
        if now >= next_stats {
            publish(ctx, &rec, part, part_offset, t0);
            next_stats = now + STATS_EVERY;
        }
        if now >= next_disk {
            next_disk = now + ctx.disk_every;
            if check_disk(ctx, &mut guard) == Some(DiskLevel::Critical) {
                result.stopped_by = Some(StopReason::Disk);
                break 'outer;
            }
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
            part_offset += total;
            lock(&ctx.activity).mark_part(part_offset);
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

/// 检查一次磁盘空间：更新共享状态，并在等级变化时推送 `recording:disk`。
///
/// # Arguments
///
/// * `ctx` - 录制线程上下文（目录、查询函数、共享状态、事件发射）。
/// * `guard` - 本次录制的磁盘守卫，记住上一次的等级。
///
/// # Returns
///
/// 等级相对上次变化时为 `Some(新等级)`；无变化或无法查询时为 `None`。
fn check_disk(ctx: &ThreadCtx, guard: &mut DiskGuard) -> Option<DiskLevel> {
    let free = (ctx.free_space)(&ctx.base.dir)?;
    let changed = guard.observe(free);
    {
        let mut s = lock(&ctx.status);
        s.disk_free_bytes = Some(free);
        s.disk_level = guard.level();
    }
    if let Some(level) = changed {
        (ctx.emit)(
            "recording:disk",
            serde_json::json!({ "level": level, "freeBytes": free }),
        );
    }
    changed
}

/// 刷新共享状态并向前端推送 `recording:stats`（状态 + 活动时间线增量）。
///
/// # Arguments
///
/// * `ctx` - 录制线程上下文。
/// * `rec` - 当前分段的录制器。
/// * `part` - 当前分段序号（从 1 起）。
/// * `part_offset` - 当前分段在会话时间轴上的起点（微秒）。
/// * `t0` - 当前分段的起始时刻。
fn publish(ctx: &ThreadCtx, rec: &FileRecorder, part: u32, part_offset: u64, t0: Instant) {
    let elapsed_us = t0.elapsed().as_micros() as u64;
    let session_us = part_offset + elapsed_us;
    let delta = {
        let mut a = lock(&ctx.activity);
        a.advance_to(session_us);
        a.take_delta()
    };
    let status = {
        let mut s = lock(&ctx.status);
        s.recording = true;
        s.part = part;
        s.path = rec.final_path().to_string_lossy().into_owned();
        s.elapsed_us = elapsed_us;
        s.session_elapsed_us = session_us;
        s.part_starts_us.clone_from(&delta.part_starts_us);
        s.stats = rec.stats();
        s.dropped = ctx.dropped.load(Ordering::Relaxed);
        s.clone()
    };
    let event = StatsEvent {
        status: &status,
        activity: delta.into(),
    };
    (ctx.emit)("recording:stats", to_json(&event));
}

/// 录制结束：复位状态并通知前端。
fn finish_flags(ctx: &ThreadCtx, result: &RecordingResult) {
    ctx.mode.set_recording(false);
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
            packet_rate: 0,
            sources: Vec::new(),
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
        assert_eq!(
            candidate_universes(&snapshot, &filter, &[40, 41]),
            vec![1, 40, 41]
        );
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

    use crate::mode::RuntimeMode;

    use artnet_net::{Bytes, DmxFrame};
    use artrec_core::ArtRecReader;
    use settings::AppSettings;

    use super::{
        Emitter, RecordingController, RecordingStartArgs, ERR_ALREADY_RECORDING, ERR_DISK_LOW,
        ERR_NOT_RECORDING, ERR_NO_UNIVERSES,
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
            data: Bytes::from(vec![v; 8]),
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
        let ctl = RecordingController::new(Arc::new(RuntimeMode::new()));
        let snapshot = vec![snap(1, Protocol::ArtNet, &["10.0.0.1", "10.0.0.2"])];
        let filter = RecordFilter {
            sources: vec!["10.0.0.1".parse().unwrap()],
            ..RecordFilter::default()
        };
        let started = ctl
            .start(
                noop(),
                &AppSettings::default(),
                tmp.0.clone(),
                &snapshot,
                args("e2e", filter, vec![]),
            )
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
    fn activity_is_empty_before_any_recording() {
        let ctl = RecordingController::new(Arc::new(RuntimeMode::new()));
        let a = ctl.activity();
        assert_eq!((a.len, a.from), (0, 0));
        assert!(a.universes.is_empty() && a.change.is_empty() && a.level.is_empty());
        assert!(ctl.status().part_starts_us.is_empty());
    }

    #[test]
    fn start_stop_error_codes() {
        let tmp = Tmp::new("errs");
        let ctl = RecordingController::new(Arc::new(RuntimeMode::new()));
        let cfg = AppSettings::default();
        assert_eq!(ctl.stop().unwrap_err(), ERR_NOT_RECORDING);
        // 无活跃信号且未手动指定
        let e = ctl
            .start(
                noop(),
                &cfg,
                tmp.0.clone(),
                &[],
                args("x", RecordFilter::default(), vec![]),
            )
            .unwrap_err();
        assert_eq!(e, ERR_NO_UNIVERSES);
        // 手动指定 Universe 可在无信号时武装录制
        ctl.start(
            noop(),
            &cfg,
            tmp.0.clone(),
            &[],
            args("x", RecordFilter::default(), vec![5]),
        )
        .unwrap();
        let again = ctl
            .start(
                noop(),
                &cfg,
                tmp.0.clone(),
                &[],
                args("y", RecordFilter::default(), vec![5]),
            )
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
        let ctl = RecordingController::new(Arc::new(RuntimeMode::new()));
        let snapshot = vec![snap(1, Protocol::ArtNet, &["10.0.0.1"])];
        let cfg = AppSettings::default();

        let err = ctl
            .start(
                noop(),
                &cfg,
                not_a_dir,
                &snapshot,
                args("x", RecordFilter::default(), vec![]),
            )
            .unwrap_err();
        assert!(!err.is_empty() && err != ERR_ALREADY_RECORDING);
        assert!(!ctl.is_recording());
        assert_eq!(ctl.stop().unwrap_err(), ERR_NOT_RECORDING);

        // 换一个可写目录即可正常录制
        let good = tmp.0.join("good");
        ctl.start(
            noop(),
            &cfg,
            good,
            &snapshot,
            args("y", RecordFilter::default(), vec![]),
        )
        .unwrap();
        ctl.stop().unwrap();
    }

    /// 压力：50 个 Universe × 44Hz 持续约 2 秒，不应丢帧，且录出的文件完整可读。
    #[test]
    fn sustained_fifty_universe_load_drops_nothing() {
        let tmp = Tmp::new("stress");
        let ctl = RecordingController::new(Arc::new(RuntimeMode::new()));
        let snapshot: Vec<_> = (0..50u16)
            .map(|u| snap(u, Protocol::ArtNet, &["10.0.0.1"]))
            .collect();
        ctl.start(
            noop(),
            &AppSettings::default(),
            tmp.0.clone(),
            &snapshot,
            args("load", RecordFilter::default(), vec![]),
        )
        .unwrap();

        let producer = {
            let ctl = ctl.clone();
            std::thread::spawn(move || {
                for i in 0..88u32 {
                    let tick = Instant::now();
                    for u in 0..50u16 {
                        let mut f = dmx(u, "10.0.0.1", (i % 250) as u8 + 1);
                        f.data = Bytes::from(vec![(i % 250) as u8 + 1; 512]);
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

    /// 造一个"剩余空间由测试随时改写"的控制器。
    fn ctl_with_free(free: &Arc<std::sync::atomic::AtomicU64>) -> RecordingController {
        let f = free.clone();
        RecordingController::with_free_space(
            Arc::new(RuntimeMode::new()),
            Arc::new(move |_| Some(f.load(std::sync::atomic::Ordering::Relaxed))),
        )
    }

    #[test]
    fn low_disk_refuses_to_start_and_stays_idle() {
        let tmp = Tmp::new("disklow");
        let free = Arc::new(std::sync::atomic::AtomicU64::new(100_000_000));
        let ctl = ctl_with_free(&free);
        let snapshot = vec![snap(1, Protocol::ArtNet, &["10.0.0.1"])];

        let err = ctl
            .start(
                noop(),
                &AppSettings::default(),
                tmp.0.clone(),
                &snapshot,
                args("d", RecordFilter::default(), vec![]),
            )
            .unwrap_err();
        assert_eq!(err, ERR_DISK_LOW);
        assert!(!ctl.is_recording());
        assert!(!ctl.disk_info(&tmp.0).can_start);

        // 空间恢复后即可开始
        free.store(5_000_000_000, std::sync::atomic::Ordering::Relaxed);
        assert!(ctl.disk_info(&tmp.0).can_start);
        ctl.start(
            noop(),
            &AppSettings::default(),
            tmp.0.clone(),
            &snapshot,
            args("d2", RecordFilter::default(), vec![]),
        )
        .unwrap();
        ctl.stop().unwrap();
    }

    #[test]
    fn check_dir_reports_existing_missing_and_non_directory_paths() {
        let tmp = Tmp::new("checkdir");
        let ctl = RecordingController::with_free_space(
            Arc::new(RuntimeMode::new()),
            Arc::new(|_| Some(7_000_000_000)),
        );

        let ok = ctl.check_dir(&tmp.0);
        assert!(ok.exists && ok.is_dir && ok.writable);
        assert_eq!(ok.disk.free_bytes, Some(7_000_000_000));
        assert_eq!(
            std::fs::read_dir(&tmp.0).unwrap().count(),
            0,
            "探测文件必须被清理"
        );

        // 尚未创建：反映最近已存在上级目录的可写性，且不会创建目录
        let missing = tmp.0.join("a").join("b");
        let c = ctl.check_dir(&missing);
        assert!(!c.exists && !c.is_dir && c.writable);
        assert!(!tmp.0.join("a").exists(), "检查不应创建目录");

        // 路径是一个文件：不可写
        let file = tmp.0.join("occupied");
        std::fs::write(&file, b"x").unwrap();
        let f = ctl.check_dir(&file);
        assert!(f.exists && !f.is_dir && !f.writable);
        // 路径经过一个文件，同样不可写
        assert!(!ctl.check_dir(&file.join("sub")).writable);
    }

    #[test]
    fn unknown_free_space_does_not_block_recording() {
        let tmp = Tmp::new("diskunk");
        let ctl =
            RecordingController::with_free_space(Arc::new(RuntimeMode::new()), Arc::new(|_| None));
        let snapshot = vec![snap(1, Protocol::ArtNet, &["10.0.0.1"])];
        assert!(ctl.disk_info(&tmp.0).can_start);
        ctl.start(
            noop(),
            &AppSettings::default(),
            tmp.0.clone(),
            &snapshot,
            args("u", RecordFilter::default(), vec![]),
        )
        .unwrap();
        ctl.stop().unwrap();
    }

    /// 录制中空间跌破临界值：自动收尾为合法文件、发出事件、标明原因，且无需先 `stop` 即可再次开始。
    #[test]
    fn critical_disk_auto_stops_with_valid_file_and_allows_restart() {
        use std::sync::atomic::Ordering;
        let tmp = Tmp::new("diskcrit");
        let free = Arc::new(std::sync::atomic::AtomicU64::new(5_000_000_000));
        let ctl = ctl_with_free(&free);
        ctl.set_disk_check_interval(Duration::from_millis(50));
        let events: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> = Arc::default();
        let sink = events.clone();
        let emit: Emitter =
            Arc::new(move |name, v| sink.lock().unwrap().push((name.to_string(), v)));
        let snapshot = vec![snap(1, Protocol::ArtNet, &["10.0.0.1"])];
        ctl.start(
            emit,
            &AppSettings::default(),
            tmp.0.clone(),
            &snapshot,
            args("crit", RecordFilter::default(), vec![]),
        )
        .unwrap();
        for i in 0..5u8 {
            ctl.offer(&dmx(1, "10.0.0.1", i + 1));
            std::thread::sleep(Duration::from_millis(10));
        }

        // 先降到"偏低"：只告警，仍在录制
        free.store(900_000_000, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(250));
        assert!(ctl.is_recording());
        assert_eq!(ctl.status().disk_level, recorder::DiskLevel::Low);

        // 再降到临界：自动停止
        free.store(50_000_000, Ordering::Relaxed);
        let deadline = Instant::now() + Duration::from_secs(3);
        while ctl.is_recording() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!ctl.is_recording(), "临界空间应自动停止录制");

        let finished = events
            .lock()
            .unwrap()
            .iter()
            .find(|(n, _)| n == "recording:finished")
            .map(|(_, v)| v.clone())
            .expect("应发出 recording:finished");
        assert_eq!(finished["stoppedBy"], "disk");
        let path = finished["files"][0]["path"].as_str().unwrap().to_string();
        ArtRecReader::open_file(std::path::Path::new(&path)).expect("自动停止后的文件必须合法可读");
        let levels: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter(|(n, _)| n == "recording:disk")
            .map(|(_, v)| v["level"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(levels, vec!["low", "critical"]);

        // 线程已自行结束：无需先 stop，空间恢复后可直接再次开始
        free.store(5_000_000_000, Ordering::Relaxed);
        ctl.start(
            noop(),
            &AppSettings::default(),
            tmp.0.clone(),
            &snapshot,
            args("again", RecordFilter::default(), vec![]),
        )
        .expect("自动停止后应能再次开始");
        ctl.stop().unwrap();
    }

    #[test]
    fn rejected_universes_are_reported_in_plan() {
        let tmp = Tmp::new("plan");
        let ctl = RecordingController::new(Arc::new(RuntimeMode::new()));
        let snapshot = vec![
            snap(3, Protocol::ArtNet, &["10.0.0.1"]),
            snap(5000, Protocol::ArtNet, &["10.0.0.1"]),
        ];
        let started = ctl
            .start(
                noop(),
                &AppSettings::default(),
                tmp.0.clone(),
                &snapshot,
                args("p", RecordFilter::default(), vec![]),
            )
            .unwrap();
        assert_eq!(started.plan.accepted, vec![3]);
        assert_eq!(started.plan.rejected_out_of_range, vec![5000]);
        ctl.stop().unwrap();
    }

    #[test]
    fn auto_split_rolls_over_to_new_files() {
        let tmp = Tmp::new("split");
        let ctl = RecordingController::new(Arc::new(RuntimeMode::new()));
        let snapshot = vec![snap(1, Protocol::ArtNet, &["10.0.0.1"])];
        let events: Arc<std::sync::Mutex<Vec<serde_json::Value>>> = Arc::default();
        let sink = events.clone();
        let emit: Emitter = Arc::new(move |name, v| {
            if name == "recording:stats" {
                sink.lock().unwrap().push(v);
            }
        });
        ctl.start_inner(
            emit,
            &AppSettings::default(),
            tmp.0.clone(),
            &snapshot,
            args("seg", RecordFilter::default(), vec![]),
            // 分段长度需大于统计推送间隔（250ms），否则分段内来不及推送 stats
            Some(Duration::from_millis(400)),
        )
        .unwrap();
        for i in 0..110u8 {
            ctl.offer(&dmx(1, "10.0.0.1", i + 1));
            std::thread::sleep(Duration::from_millis(10));
        }
        let live = ctl.status();
        assert!(live.session_elapsed_us >= live.elapsed_us);
        let out = ctl.stop().unwrap();

        // 会话时长跨分段单调递增，分段起点被记录且与 activity 一致
        let events = events.lock().unwrap();
        let live_events: Vec<_> = events.iter().filter(|v| v["recording"] == true).collect();
        assert!(!live_events.is_empty());
        let mut last = 0u64;
        for v in &live_events {
            let s = v["sessionElapsedUs"].as_u64().unwrap();
            assert!(s >= last, "会话时长应单调递增");
            last = s;
            assert!(v["activity"].is_object(), "录制中的 stats 应携带 activity");
        }
        let final_live = live_events.last().unwrap();
        let starts = final_live["partStartsUs"].as_array().unwrap();
        assert!(starts.len() >= 2, "分段起点 {starts:?}");
        assert_eq!(starts[0], 0);
        assert!(starts[1].as_u64().unwrap() >= 400_000);
        assert_eq!(final_live["activity"]["partStartsUs"], final_live["partStartsUs"]);
        // 增量拼起来覆盖整个时间线，且有非零变化
        let full = ctl.activity();
        assert_eq!(full.from, 0);
        assert_eq!(full.universes, vec![1]);
        assert!(full.len > 0);
        assert!(live_events.iter().any(|v| {
            v["activity"]["change"][0]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        }));
        drop(events);
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(
            out.files.len() >= 2,
            "应至少分成两段，实际 {}",
            out.files.len()
        );
        for f in &out.files {
            ArtRecReader::open_file(std::path::Path::new(&f.path)).unwrap();
        }
        assert!(out.files[1].path.contains("seg-part2"));
    }
}
