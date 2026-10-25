//! 应用运行时：绑定收发、驱动信号引擎与设备发现，按 UI 刷新率向前端发事件。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use artnet_net::artnet::PollReplyInfo;
use artnet_net::socket::{self, DmxSender};
use artnet_net::{DmxFrame, Protocol};
use discovery::{Device, DeviceCategory, DeviceRegistry};
use forwarding::{ForwardingTable, RateLimiter};
use settings::AppSettings;
use signal_engine::{SignalEngine, SourceStat, UniverseSnapshot};

use crate::app_mode::{AppMode, ModeDeps, ModeManager, ModeStatus, ReceiversState};
use crate::dispatch::{DispatchTarget, Dispatcher};
use crate::mode::{FrameFanout, RuntimeMode};
use crate::playback::{OpenParams, PlaybackController, PlaybackStatus};
use crate::recording::RecordingController;
use crate::sacn::{plan_sacn, SacnPlan};
use crate::sender::{self, SenderHealth};
use crate::util::lock;

/// 本应用固定 CID（用于 sACN 发送与发现）。
const APP_CID: [u8; 16] = [
    0x41, 0x72, 0x74, 0x4e, 0x65, 0x74, 0x53, 0x74, 0x75, 0x64, 0x69, 0x6f, 0x00, 0x00, 0x00, 0x01,
];

/// 设备离线判定阈值（毫秒）。
const DEVICE_OFFLINE_MS: u64 = 8000;

/// 一次网络扫描发送 ArtPoll 的轮数。
const SCAN_ROUNDS: u32 = 3;
/// 相邻两轮 ArtPoll 的间隔。
const SCAN_ROUND_GAP: Duration = Duration::from_millis(300);
/// 最后一轮发送后等待节点回复的时间。
const SCAN_SETTLE: Duration = Duration::from_millis(800);

/// 扫描错误码：Art-Net 协议未启用（接收套接字未绑定，收不到回复）。
pub const SCAN_ERR_ARTNET_DISABLED: &str = "artnet_disabled";
/// 扫描错误码：已有一次扫描在进行。
pub const SCAN_ERR_IN_PROGRESS: &str = "scan_in_progress";

/// 网络扫描结果摘要（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    /// 尝试广播的目标地址数量。
    pub targets: usize,
    /// 成功发出的 ArtPoll 包数量。
    pub sent: usize,
    /// 本次扫描期间有响应的 Art-Net 节点数。
    pub responded: usize,
    /// 扫描结束时已知的 Art-Net 节点总数。
    pub total_artnet: usize,
    /// 部分目标发送失败的原因（去重）。
    pub errors: Vec<String>,
}

/// 扫描进行中标志的 RAII 守卫：离开作用域（含提前返回 / panic）时自动复位。
struct ScanGuard(Arc<AtomicBool>);

impl ScanGuard {
    /// 尝试占用扫描槽；已被占用返回 None。
    fn acquire(flag: &Arc<AtomicBool>) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(flag.clone()))
    }
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// 引擎统计事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsPayload {
    /// 活跃 Universe 数。
    pub active_universes: usize,
    /// 累计包数。
    pub total_packets: u64,
    /// 每秒包数（上一周期估算）。
    pub packet_rate: u32,
    /// 运行时长（秒）。
    pub uptime_sec: u64,
}

/// 单个被查看 Universe 的通道数据事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelsPayload {
    /// Universe 编号。
    pub universe: u16,
    /// 合并后的通道数据。
    pub data: Vec<u8>,
}

/// sACN 接收任务的当前状态，由 [`Runtime::reconcile_sacn`] 维护。
#[derive(Default)]
struct SacnState {
    /// 已生效的方案；`None` 表示当前没有（或尚未成功建立）接收任务。
    applied: Option<SacnPlan>,
    /// 运行中的接收任务；绑定在异步任务里完成，所以可能晚于 `applied` 才出现。
    handle: Option<tokio::task::JoinHandle<()>>,
    /// 每次方案变化自增。异步绑定完成时据此判断自己是否已被更新的方案取代。
    generation: u64,
}

/// Art-Net 接收任务的配置与句柄；与 [`SacnState`] 对应，但配置只在启动时读取。
#[derive(Default)]
struct ArtnetRx {
    /// 运行中的接收任务；`abort()` 会丢弃套接字并释放端口。
    handle: Option<tokio::task::JoinHandle<()>>,
    /// 启动时读取的绑定网卡；`None` 表示尚未 `spawn`。
    bind_ip: Option<Ipv4Addr>,
    /// 配置是否启用 Art-Net 接收。
    enabled: bool,
    /// 帧通道发送端：重建接收任务时需要。
    frame_tx: Option<mpsc::Sender<DmxFrame>>,
    /// ArtPollReply 通道发送端：重建接收任务时需要。
    reply_tx: Option<mpsc::Sender<PollReplyInfo>>,
}

/// 应用运行时句柄：共享引擎、设备注册表与被查看集合。
#[derive(Clone)]
pub struct Runtime {
    engine: Arc<Mutex<SignalEngine>>,
    registry: Arc<Mutex<DeviceRegistry>>,
    forwarding: Arc<Mutex<ForwardingTable>>,
    sender: Arc<tokio::sync::Mutex<Option<DmxSender>>>,
    /// 输出分发器：实时转发与录制回放共用。
    dispatcher: Dispatcher,
    /// 录制 / 回放互斥仲裁：接收循环据 `is_playback()` 暂停实时摄取（手册 Player Mode 语义）。
    mode: Arc<RuntimeMode>,
    /// 帧旁路扇出：接收循环把每帧投递给已注册的接收器（录制等）。
    fanout: FrameFanout,
    /// 回放控制器：与录制控制器同级挂在运行时，打开节目所需的分发器 / 回放模式
    /// 标志 / 运行时起点等均由运行时内部提供，命令层无需逐一拼装。
    playback: PlaybackController,
    viewed: Arc<Mutex<Vec<u16>>>,
    /// Art-Net 接收是否已启用（决定能否收到 ArtPollReply）。
    artnet_enabled: Arc<AtomicBool>,
    /// 是否有扫描正在进行。
    scanning: Arc<AtomicBool>,
    /// 录制控制器：接收循环把帧旁路给它。
    recording: RecordingController,
    /// sACN 接收任务状态（可随设置实时启停）。
    sacn: Arc<Mutex<SacnState>>,
    /// Art-Net 接收任务状态（可被播放器模式挂起并重建）。
    artnet: Arc<Mutex<ArtnetRx>>,
    /// 接收是否被播放器模式挂起：为 `true` 时设置变更不得重建 sACN 接收。
    suspended: Arc<AtomicBool>,
    /// 最近一次应用的配置，恢复接收时据此重建 sACN 方案。
    last_cfg: Arc<Mutex<Option<AppSettings>>>,
    /// 应用运行模式管理器。
    modes: Arc<ModeManager>,
    /// 发送器健康度（与分发器共享）。
    sender_health: Arc<SenderHealth>,
    /// 帧通道发送端：保留一份供重建 sACN 接收任务时使用。
    frame_tx: Arc<Mutex<Option<mpsc::Sender<DmxFrame>>>>,
    start: Instant,
    names_path: PathBuf,
    forwarding_path: PathBuf,
}

impl Runtime {
    /// 依据配置创建运行时，并从磁盘加载设备自定义名。
    ///
    /// # Arguments
    ///
    /// * `cfg` - 当前应用配置。
    /// * `names_path` - 设备自定义名持久化文件路径。
    #[must_use]
    pub fn new(cfg: &AppSettings, names_path: PathBuf, forwarding_path: PathBuf) -> Self {
        let engine = SignalEngine::new(cfg.merge.mode, u64::from(cfg.merge.source_timeout_ms));
        let mut registry = DeviceRegistry::new();
        if let Ok(text) = std::fs::read_to_string(&names_path) {
            if let Ok(names) = serde_json::from_str::<HashMap<String, String>>(&text) {
                registry.load_custom_names(names);
            }
        }
        let forwarding = std::fs::read_to_string(&forwarding_path)
            .ok()
            .and_then(|t| ForwardingTable::from_json(&t).ok())
            .unwrap_or_default();
        let forwarding = Arc::new(Mutex::new(forwarding));
        let sender = Arc::new(tokio::sync::Mutex::new(None));
        let dispatcher = Dispatcher::new(
            forwarding.clone(),
            Arc::new(Mutex::new(RateLimiter::new())),
            sender.clone(),
        );
        dispatcher.set_sacn_enabled(cfg.protocol.sacn_enabled);
        let sender_health = dispatcher.health();
        // 录制 / 回放共享同一互斥仲裁；录制控制器把自身帧接收器注册进扇出，
        // 接收循环只认扇出、不再硬编码录制。
        let mode = Arc::new(RuntimeMode::new());
        let recording = RecordingController::new(mode.clone());
        let fanout = FrameFanout::new();
        fanout.register(recording.sink());
        Self {
            engine: Arc::new(Mutex::new(engine)),
            registry: Arc::new(Mutex::new(registry)),
            forwarding,
            sender,
            dispatcher,
            mode,
            fanout,
            playback: PlaybackController::new(),
            viewed: Arc::new(Mutex::new(Vec::new())),
            artnet_enabled: Arc::new(AtomicBool::new(false)),
            scanning: Arc::new(AtomicBool::new(false)),
            recording,
            sacn: Arc::new(Mutex::new(SacnState::default())),
            artnet: Arc::new(Mutex::new(ArtnetRx::default())),
            suspended: Arc::new(AtomicBool::new(false)),
            last_cfg: Arc::new(Mutex::new(None)),
            modes: Arc::new(ModeManager::new()),
            sender_health,
            frame_tx: Arc::new(Mutex::new(None)),
            start: Instant::now(),
            names_path,
            forwarding_path,
        }
    }

    /// 录制控制器。
    #[must_use]
    pub fn recording(&self) -> &RecordingController {
        &self.recording
    }

    /// 回放控制器。
    #[must_use]
    pub fn playback(&self) -> &PlaybackController {
        &self.playback
    }

    /// 打开节目并进入回放：分发器 / 回放模式标志 / 运行时起点 / 录制状态均由运行时内部填充。
    ///
    /// # Arguments
    ///
    /// * `emit` - 事件发射回调。
    /// * `path` - 已校验的 `.artrec` 路径。
    /// * `name` - 显示名。
    /// * `target` - 输出目标。
    /// * `library_dir` - 录制目录，连播时据此查找下一个节目。
    ///
    /// # Returns
    ///
    /// 节目刚打开时的初始 [`PlaybackStatus`]。
    ///
    /// # Errors
    ///
    /// 录制进行中、路径非法或文件无法解析时返回错误码字符串。
    pub fn open_playback(
        &self,
        emit: crate::recording::Emitter,
        path: PathBuf,
        name: String,
        target: DispatchTarget,
        library_dir: PathBuf,
    ) -> Result<PlaybackStatus, String> {
        let next: crate::playback::NextProgramFn =
            Arc::new(move |current| crate::playback::next_in_library(&library_dir, current));
        // 打开节目即进入播放器模式（回放需要独占输出，实时接收必须先停）。
        // 若本次调用负责进入，节目打不开时要退回实时模式，不能把用户留在一个空的播放器模式里。
        let entered_here = self.modes.mode() == AppMode::Live;
        if entered_here {
            self.set_app_mode(AppMode::Player, &emit)?;
        }
        let opened = self.playback.open(OpenParams {
            emit: emit.clone(),
            dispatcher: self.dispatcher.clone(),
            mode: self.mode.clone(),
            started_at: self.start,
            path,
            name,
            target,
            next: Some(next),
        });
        if opened.is_err() && entered_here {
            let _ = self.set_app_mode(AppMode::Live, &emit);
        }
        opened
    }

    /// 当前应用模式状态。
    ///
    /// # Returns
    ///
    /// 当前模式、接收任务状态与发送器状态的 [`ModeStatus`]。
    #[must_use]
    pub fn app_mode_status(&self) -> ModeStatus {
        ModeStatus {
            mode: self.modes.mode(),
            receivers: self.modes.receivers(),
            sender: self.sender_health.state(),
        }
    }

    /// 切换应用模式（**须在 Tokio 上下文中调用**：重建接收套接字需要 reactor）。
    ///
    /// 目标等于当前模式时是幂等的；实时模式下若接收曾绑定失败，会再次尝试重建。
    /// 成功后推送 `app:mode` 事件。
    ///
    /// # Arguments
    ///
    /// * `target` - 目标模式。
    /// * `emit` - 事件发射回调。
    ///
    /// # Returns
    ///
    /// 切换完成后的 [`ModeStatus`]。
    ///
    /// # Errors
    ///
    /// - `transition_in_progress`：已有切换正在进行。
    /// - `recording_active`：录制进行中，不能进入播放器模式。
    pub fn set_app_mode(
        &self,
        target: AppMode,
        emit: &crate::recording::Emitter,
    ) -> Result<ModeStatus, String> {
        self.modes.set(target, self)?;
        let status = self.app_mode_status();
        emit("app:mode", serde_json::to_value(status).unwrap_or(serde_json::Value::Null));
        Ok(status)
    }

    /// 启动（或重建）Art-Net 接收任务（**须在 Tokio 上下文中调用**）。
    ///
    /// # Returns
    ///
    /// 成功绑定，或按配置本就关闭（无需绑定）时为 `true`；绑定失败或尚未 `spawn` 时为 `false`。
    fn artnet_start(&self) -> bool {
        // 启动时 `spawn` 的绑定任务与"启动即进入播放器模式"可能赛跑：
        // 若接收已被挂起，这里不能再把端口绑回来（恢复时会先清除挂起标志再调用）。
        if self.suspended.load(Ordering::Acquire) {
            return true;
        }
        let (ip, tx, reply, enabled) = {
            let st = lock(&self.artnet);
            (st.bind_ip, st.frame_tx.clone(), st.reply_tx.clone(), st.enabled)
        };
        if !enabled {
            return true;
        }
        let (Some(ip), Some(tx)) = (ip, tx) else {
            return false;
        };
        if let Some(old) = lock(&self.artnet).handle.take() {
            old.abort();
        }
        match socket::spawn_artnet_receiver(ip, tx, reply) {
            Ok(handle) => {
                lock(&self.artnet).handle = Some(handle);
                // 仅在接收套接字真正绑定成功后才允许扫描（否则收不到回复）
                self.artnet_enabled.store(true, Ordering::Relaxed);
                true
            }
            Err(e) => {
                tracing::warn!(error = %e, "Art-Net 接收绑定失败");
                self.artnet_enabled.store(false, Ordering::Relaxed);
                false
            }
        }
    }

    /// 停止 Art-Net 接收任务并释放端口。
    fn artnet_stop(&self) {
        if let Some(h) = lock(&self.artnet).handle.take() {
            h.abort();
        }
        self.artnet_enabled.store(false, Ordering::Relaxed);
    }

    /// 按源 IP 聚合的当前来源统计（供录制来源选择器）。
    #[must_use]
    pub fn source_stats(&self) -> Vec<SourceStat> {
        lock(&self.engine).source_stats()
    }

    /// 当前转发表。
    #[must_use]
    pub fn forwarding(&self) -> ForwardingTable {
        lock(&self.forwarding).clone()
    }

    /// 保存转发表（替换内存并持久化）。
    ///
    /// # Arguments
    ///
    /// * `table` - 新的转发表。
    pub fn save_forwarding(&self, table: ForwardingTable) {
        if let Ok(text) = table.to_json() {
            if let Some(parent) = self.forwarding_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&self.forwarding_path, text);
        }
        *lock(&self.forwarding) = table;
        // 目的地可能已增删，重置限速状态避免旧目的地条目残留。
        self.dispatcher.reset_rate_limits();
    }

    /// 当前全部活跃 Universe 快照。
    #[must_use]
    pub fn snapshot(&self) -> Vec<UniverseSnapshot> {
        lock(&self.engine).snapshot()
    }

    /// 当前全部已发现设备。
    #[must_use]
    pub fn devices(&self) -> Vec<Device> {
        lock(&self.registry).list()
    }

    /// 设置前端正在查看的 Universe 列表。
    pub fn set_viewed(&self, universes: Vec<u16>) {
        *lock(&self.viewed) = universes;
    }

    /// 在线应用配置：更新合并模式与源超时，并让 sACN 接收与输出实时跟随设置。
    ///
    /// Art-Net 接收的启停与端口仍只在启动时读取。
    pub fn apply_settings(&self, cfg: &AppSettings) {
        {
            let mut e = lock(&self.engine);
            e.set_mode(cfg.merge.mode);
            e.set_timeout(u64::from(cfg.merge.source_timeout_ms));
        }
        *lock(&self.last_cfg) = Some(cfg.clone());
        self.reconcile_sacn(cfg);
    }

    /// 让 sACN 接收任务与配置保持一致。
    ///
    /// - 全局开关同步给分发器与接收循环（关闭后既不发送也不摄取 sACN）；
    /// - 方案（端口 / Universe / 生效网卡）没变则什么也不做；
    /// - 变化则停掉旧任务并按新方案重建；
    /// - 接收从有到无时，清掉引擎与设备注册表里残留的 sACN 数据。
    ///
    /// 套接字必须在 Tokio 上下文中绑定，所以重建放进异步任务；`generation`
    /// 保证快速连续保存时，较早的绑定结果不会覆盖较新的方案。
    fn reconcile_sacn(&self, cfg: &AppSettings) {
        // 先于一切改开关：之后到达的 sACN 帧即被接收循环丢弃
        self.dispatcher.set_sacn_enabled(cfg.protocol.sacn_enabled);
        // 播放器模式下接收已被整体挂起：保存设置不能把 sACN 接收悄悄重建出来。
        // 恢复时会以最新配置（`last_cfg`）重新建立。
        if self.suspended.load(Ordering::Acquire) {
            return;
        }
        let plan = plan_sacn(cfg, &netif::list_interfaces());

        let (generation, had_receiver) = {
            let mut st = lock(&self.sacn);
            if st.applied == plan {
                return;
            }
            st.generation += 1;
            if let Some(handle) = st.handle.take() {
                handle.abort();
            }
            let had = st.applied.is_some();
            st.applied.clone_from(&plan);
            (st.generation, had)
        };

        let Some(plan) = plan else {
            if had_receiver {
                let engine_purged = lock(&self.engine).purge_protocol(Protocol::Sacn);
                let devices_purged = lock(&self.registry).remove_category(DeviceCategory::Sacn);
                tracing::info!(engine_purged, devices_purged, "sACN 接收已停止并清理残留数据");
            }
            return;
        };
        let Some(tx) = lock(&self.frame_tx).clone() else {
            // 尚未 spawn：spawn 存好发送端后会再调用一次，这里放弃本次并允许重试
            lock(&self.sacn).applied = None;
            return;
        };

        let state = self.sacn.clone();
        tauri::async_runtime::spawn(async move {
            match socket::spawn_sacn_receiver(plan.port, &plan.ifaces, &plan.universes, tx) {
                Ok(receiver) => {
                    tracing::info!(
                        port = receiver.local_port,
                        joined = receiver.joined,
                        failed = receiver.failed.len(),
                        "sACN 接收已启动"
                    );
                    let mut st = lock(&state);
                    if st.generation == generation {
                        st.handle = Some(receiver.handle);
                    } else {
                        // 绑定期间方案又变了：这个任务已过期
                        receiver.handle.abort();
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "sACN 接收启动失败");
                    let mut st = lock(&state);
                    if st.generation == generation {
                        // 清掉已生效标记，下一次保存设置时会重试
                        st.applied = None;
                    }
                }
            }
        });
    }

    /// 设置设备自定义名并持久化。
    ///
    /// # Arguments
    ///
    /// * `ip` - 目标设备 IP 字符串。
    /// * `name` - 自定义名（空清除）。
    pub fn set_device_name(&self, ip: &str, name: String) {
        if let Ok(addr) = ip.parse::<IpAddr>() {
            let mut r = lock(&self.registry);
            r.set_custom_name(addr, name);
            if let Ok(text) = serde_json::to_string_pretty(&r.custom_names()) {
                if let Some(parent) = self.names_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&self.names_path, text);
            }
        }
    }

    /// 移除全部离线设备并返回剩余设备列表。
    #[must_use]
    pub fn clear_offline_devices(&self) -> Vec<Device> {
        let mut r = lock(&self.registry);
        r.clear_offline();
        r.list()
    }

    /// 发起一次主动网络扫描并等待节点回复。
    ///
    /// 向每块非回环网卡的子网定向广播地址（外加 `255.255.255.255`）各发
    /// 若干轮 ArtPoll；回复由 Art-Net 接收任务写入设备注册表。结束后统计
    /// 本次扫描期间有响应的节点数。
    ///
    /// # Returns
    ///
    /// 扫描摘要。
    ///
    /// # Errors
    ///
    /// * [`SCAN_ERR_ARTNET_DISABLED`]：Art-Net 未启用，收不到回复。
    /// * [`SCAN_ERR_IN_PROGRESS`]：已有扫描在进行。
    /// * 其它：发送套接字创建失败，或所有目标均发送失败（错误详情）。
    pub async fn scan_network(&self) -> Result<ScanSummary, String> {
        if !self.artnet_enabled.load(Ordering::Relaxed) {
            return Err(SCAN_ERR_ARTNET_DISABLED.to_string());
        }
        let _guard = ScanGuard::acquire(&self.scanning)
            .ok_or_else(|| SCAN_ERR_IN_PROGRESS.to_string())?;

        let sender = DmxSender::new(APP_CID)
            .await
            .map_err(|e| format!("创建发送套接字失败: {e}"))?;
        let targets = netif::broadcast_targets();
        let since_ms = self.start.elapsed().as_millis() as u64;

        let mut sent = 0usize;
        let mut errors: Vec<String> = Vec::new();
        for round in 0..SCAN_ROUNDS {
            for target in &targets {
                match sender.send_poll_to(*target).await {
                    Ok(()) => sent += 1,
                    Err(e) => {
                        let msg = format!("{target}: {e}");
                        if !errors.contains(&msg) {
                            errors.push(msg);
                        }
                    }
                }
            }
            if round + 1 < SCAN_ROUNDS {
                tokio::time::sleep(SCAN_ROUND_GAP).await;
            }
        }
        if sent == 0 {
            return Err(errors.join("; "));
        }

        tokio::time::sleep(SCAN_SETTLE).await;

        let (responded, total_artnet) = {
            let r = lock(&self.registry);
            (r.count_artnet_seen_since(since_ms), r.count_artnet())
        };
        Ok(ScanSummary {
            targets: targets.len(),
            sent,
            responded,
            total_artnet,
            errors,
        })
    }

    /// 启动接收与事件推送后台任务。
    ///
    /// 安全提示：Art-Net/sACN 为内网明文 UDP，无鉴权；仅应在受信任网络使用。
    ///
    /// # Arguments
    ///
    /// * `app` - 用于发事件的 AppHandle。
    /// * `cfg` - 当前配置（决定协议开关、接口、刷新率）。
    pub fn spawn<R: tauri::Runtime>(&self, app: AppHandle<R>, cfg: &AppSettings) {
        let bind_ip: Ipv4Addr = cfg
            .network
            .interface
            .parse()
            .unwrap_or(Ipv4Addr::UNSPECIFIED);
        let (tx, mut rx) = mpsc::channel::<artnet_net::DmxFrame>(1024);
        let (reply_tx, mut reply_rx) = mpsc::channel::<PollReplyInfo>(64);

        // 套接字绑定（UdpSocket::from_std）必须在 Tokio 运行时上下文中执行，
        // 而 Tauri 的 setup 不处于 reactor 内，故放入 async runtime 任务中绑定。
        *lock(&self.last_cfg) = Some(cfg.clone());
        {
            // 配置只在启动时读取；句柄与通道发送端留在状态里，播放器模式退出时据此重建
            let mut st = lock(&self.artnet);
            st.bind_ip = Some(bind_ip);
            st.enabled = cfg.protocol.artnet_enabled;
            st.frame_tx = Some(tx.clone());
            st.reply_tx = Some(reply_tx);
        }
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            if !this.artnet_start() {
                this.modes.set_receivers(ReceiversState::Failed);
            }
        });
        // 保留发送端：sACN 接收任务由 reconcile_sacn 按设置实时启停，重建时需要它。
        *lock(&self.frame_tx) = Some(tx);
        self.reconcile_sacn(cfg);

        // 发送器监督：首次创建与之后的故障重建走同一条路径（连续发送失败 → 阶梯退避重建）
        let health = self.sender_health.clone();
        let slot = self.sender.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                health.wait_for_trouble().await;
                sender::recover(&health, &slot, || DmxSender::new(APP_CID), sender::rebind_delay)
                    .await;
            }
        });
        // 发送器状态变化时推送 app:mode，让界面及时显示"输出重连中 / 不可用"
        {
            let weak_health = Arc::downgrade(&self.sender_health);
            let modes = self.modes.clone();
            let app = app.clone();
            self.sender_health.set_listener(move |_| {
                if let Some(h) = weak_health.upgrade() {
                    let status = ModeStatus {
                        mode: modes.mode(),
                        receivers: modes.receivers(),
                        sender: h.state(),
                    };
                    let _ = app.emit("app:mode", status);
                }
            });
        }
        self.sender_health.request_recovery();

        // 帧摄取 + 转发任务
        let engine = self.engine.clone();
        let dispatcher = self.dispatcher.clone();
        let start = self.start;
        let fanout = self.fanout.clone();
        let mode = self.mode.clone();
        let sacn_gate = self.dispatcher.sacn_gate();
        tauri::async_runtime::spawn(async move {
            while let Some(frame) = rx.recv().await {
                // sACN 已关闭：丢弃通道里迟到的 sACN 帧，避免关闭后又被摄取、录制或转发
                if frame.protocol == Protocol::Sacn && !sacn_gate.load(Ordering::Relaxed) {
                    continue;
                }
                // 回放模式下暂停实时接收（避免回放输出被自己重新摄取形成回环）；
                // 播放器模式下接收任务已拆除，这里再丢弃通道里残留的迟到帧
                if mode.is_playback() || mode.is_player() {
                    continue;
                }
                // 旁路给已注册的帧接收器（录制等）：各自非阻塞处理，不影响下方合并与转发
                fanout.offer(&frame);
                let now_ms = start.elapsed().as_millis() as u64;
                let universe = frame.universe;

                // 摄取并取合并输出
                let merged = {
                    let mut e = lock(&engine);
                    e.ingest(&frame, now_ms);
                    e.merged_output(universe)
                };
                let Some(data) = merged else { continue };

                // 解析路由 + 限速 + 发送，与回放共用同一分发器
                let jobs = dispatcher.plan(
                    universe,
                    &data,
                    now_ms,
                    &DispatchTarget::Forwarding,
                    true,
                );
                dispatcher.send_jobs(jobs).await;
            }
        });
        // Art-Net 回复 → 设备注册表
        let registry = self.registry.clone();
        let start2 = self.start;
        tauri::async_runtime::spawn(async move {
            while let Some(info) = reply_rx.recv().await {
                let now_ms = start2.elapsed().as_millis() as u64;
                lock(&registry).upsert_artnet(&info, now_ms);
            }
        });

        // 事件推送任务（按 UI 刷新率）
        let engine = self.engine.clone();
        let registry = self.registry.clone();
        let viewed = self.viewed.clone();
        let start = self.start;
        let fps = cfg.display.ui_update_rate.max(1);
        let period = Duration::from_millis(1000 / u64::from(fps));
        tauri::async_runtime::spawn(async move {
            let mut last_packets: u64 = 0;
            let mut last_sources_emit = Instant::now();
            let mut ticker = tokio::time::interval(period);
            loop {
                ticker.tick().await;
                let now_ms = start.elapsed().as_millis() as u64;
                let uptime_sec = start.elapsed().as_secs();

                // 来源统计约 4Hz 推送一次（录制来源选择器用，无需跟随 UI 刷新率）
                let emit_sources = last_sources_emit.elapsed() >= Duration::from_millis(250);
                // 先在 engine 锁外取当前查看列表，避免在持有 engine 锁期间再嵌套 viewed 锁，
                // 缩短 engine 临界区、降低与帧摄取循环的锁竞争。
                let view = lock(&viewed).clone();
                let (snapshot, total, channels, sources) = {
                    let mut e = lock(&engine);
                    e.prune(now_ms);
                    let snap = e.snapshot();
                    let total = e.total_packets();
                    let sources = emit_sources.then(|| e.source_stats());
                    let ch: Vec<ChannelsPayload> = view
                        .iter()
                        .filter_map(|&u| {
                            e.merged_output(u).map(|data| ChannelsPayload { universe: u, data })
                        })
                        .collect();
                    (snap, total, ch, sources)
                };
                if let Some(sources) = sources {
                    last_sources_emit = Instant::now();
                    let _ = app.emit("engine:sources", &sources);
                }

                // 被动设备发现：从快照源 IP 更新注册表
                let devices = {
                    let mut r = lock(&registry);
                    for u in &snapshot {
                        let proto = u.protocol;
                        for ip_str in &u.source_ips {
                            if let (Ok(ip), Some(proto)) = (ip_str.parse::<IpAddr>(), proto) {
                                r.upsert_source(ip, proto, now_ms);
                            }
                        }
                    }
                    r.mark_stale_offline(now_ms, DEVICE_OFFLINE_MS);
                    r.list()
                };

                let packet_rate = ((total.saturating_sub(last_packets)) as f64
                    * (1000.0 / period.as_millis() as f64))
                    as u32;
                last_packets = total;

                let _ = app.emit(
                    "engine:stats",
                    StatsPayload {
                        active_universes: snapshot.len(),
                        total_packets: total,
                        packet_rate,
                        uptime_sec,
                    },
                );
                let _ = app.emit("engine:universes", &snapshot);
                let _ = app.emit("discovery:devices", &devices);
                for c in channels {
                    let _ = app.emit("engine:channels", &c);
                }
            }
        });
    }
}

impl ModeDeps for Runtime {
    fn is_recording(&self) -> bool {
        self.mode.is_recording()
    }

    fn set_player_flag(&self, on: bool) {
        self.mode.set_player(on);
    }

    fn suspend_receivers(&self) {
        self.suspended.store(true, Ordering::Release);
        self.artnet_stop();
        let mut st = lock(&self.sacn);
        st.generation += 1; // 让仍在异步绑定中的旧任务自认过期
        if let Some(handle) = st.handle.take() {
            handle.abort();
        }
        st.applied = None;
    }

    fn resume_receivers(&self) -> bool {
        self.suspended.store(false, Ordering::Release);
        let bound = self.artnet_start();
        let cfg = lock(&self.last_cfg).clone();
        if let Some(cfg) = cfg {
            self.reconcile_sacn(&cfg);
        }
        bound
    }

    fn clear_live_state(&self) {
        let universes = lock(&self.engine).clear();
        let devices = lock(&self.registry).clear();
        self.dispatcher.reset_rate_limits();
        tracing::info!(universes, devices, "已清空实时状态");
    }

    fn ensure_sender(&self) {
        // 发送槽被占用（正在发送）说明发送器存在；只有确认为空才请求创建
        if self.sender.try_lock().is_ok_and(|g| g.is_none()) {
            self.sender_health.request_recovery();
        }
    }

    fn close_program(&self) {
        self.playback.close();
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use artnet_net::{Bytes, DmxFrame, Protocol};
    use discovery::DeviceCategory;
    use settings::AppSettings;

    use super::Runtime;
    use crate::app_mode::{AppMode, ReceiversState};
    use crate::dispatch::DispatchTarget;
    use crate::recording::Emitter;
    use crate::util::lock;

    /// 造一个只收单播的 sACN 配置：端口 0 由系统分配，不订阅组播，避免依赖网络环境。
    fn sacn_cfg(enabled: bool) -> AppSettings {
        let mut c = AppSettings::default();
        c.protocol.sacn_enabled = enabled;
        c.protocol.sacn_port = 0;
        c.protocol.sacn_universes = Vec::new();
        c.network.interface = "127.0.0.1".into();
        c
    }

    fn runtime(cfg: &AppSettings) -> Runtime {
        let dir = std::env::temp_dir();
        let rt = Runtime::new(
            cfg,
            dir.join("artnet-studio-test-names.json"),
            dir.join("artnet-studio-test-forwarding.json"),
        );
        // 测试里没有 spawn：手工放入帧通道发送端（接收端丢弃即可）
        let (tx, rx) = tokio::sync::mpsc::channel::<DmxFrame>(8);
        std::mem::forget(rx);
        *lock(&rt.frame_tx) = Some(tx);
        rt
    }

    /// 等待异步绑定完成（接收任务句柄出现）。
    fn wait_for_handle(rt: &Runtime) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if lock(&rt.sacn).handle.is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn sacn_frame(universe: u16, ip: [u8; 4]) -> DmxFrame {
        DmxFrame {
            protocol: Protocol::Sacn,
            universe,
            data: Bytes::from_static(&[1, 2, 3]),
            source: Some(IpAddr::V4(Ipv4Addr::from(ip))),
            sequence: 0,
            received_at: Instant::now(),
        }
    }

    #[test]
    fn enabling_starts_receiver_and_disabling_stops_and_purges() {
        let rt = runtime(&sacn_cfg(false));
        // 关闭状态：不起接收任务
        rt.apply_settings(&sacn_cfg(false));
        assert!(lock(&rt.sacn).applied.is_none());

        // 开启：实时生效，无需重启
        rt.apply_settings(&sacn_cfg(true));
        assert!(lock(&rt.sacn).applied.is_some());
        assert!(wait_for_handle(&rt), "开启后应建立接收任务");

        // 模拟已收到 sACN 数据与设备
        lock(&rt.engine).ingest(&sacn_frame(2, [10, 0, 0, 2]), 0);
        lock(&rt.registry).upsert_source(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), Protocol::Sacn, 0);
        assert_eq!(rt.snapshot().len(), 1);

        // 关闭：任务停止，残留数据被清掉
        rt.apply_settings(&sacn_cfg(false));
        let st = lock(&rt.sacn);
        assert!(st.applied.is_none() && st.handle.is_none());
        drop(st);
        assert!(rt.snapshot().is_empty(), "关闭后引擎里不应残留 sACN Universe");
        assert!(rt.devices().iter().all(|d| d.category != DeviceCategory::Sacn));
    }

    #[test]
    fn identical_settings_do_not_rebuild_receiver() {
        let rt = runtime(&sacn_cfg(true));
        rt.apply_settings(&sacn_cfg(true));
        assert!(wait_for_handle(&rt));
        let gen_before = lock(&rt.sacn).generation;

        rt.apply_settings(&sacn_cfg(true));
        rt.apply_settings(&sacn_cfg(true));
        assert_eq!(lock(&rt.sacn).generation, gen_before, "配置未变不应重建");
    }

    #[test]
    fn changing_universes_rebuilds_receiver() {
        let rt = runtime(&sacn_cfg(true));
        rt.apply_settings(&sacn_cfg(true));
        assert!(wait_for_handle(&rt));
        let gen_before = lock(&rt.sacn).generation;

        let mut c = sacn_cfg(true);
        c.protocol.sacn_universes = vec![7];
        rt.apply_settings(&c);
        assert!(lock(&rt.sacn).generation > gen_before);
        assert_eq!(lock(&rt.sacn).applied.as_ref().unwrap().universes, vec![7]);
    }

    #[test]
    fn toggling_sacn_updates_dispatcher_gate() {
        let rt = runtime(&sacn_cfg(false));
        assert!(!rt.dispatcher.sacn_gate().load(std::sync::atomic::Ordering::Relaxed));
        rt.apply_settings(&sacn_cfg(true));
        assert!(rt.dispatcher.sacn_gate().load(std::sync::atomic::Ordering::Relaxed));
        rt.apply_settings(&sacn_cfg(false));
        assert!(!rt.dispatcher.sacn_gate().load(std::sync::atomic::Ordering::Relaxed));
    }

    // ---- 播放器模式 ----

    fn noop_emit() -> Emitter {
        Arc::new(|_, _| {})
    }

    /// 写一个最小的合法 `.artrec`（1 路 Universe、两帧）。
    fn write_program(dir: &std::path::Path, file: &str) -> std::path::PathBuf {
        use artrec_core::{ArtRecWriter, CompressAlgo, UniDesc};
        let unis = vec![UniDesc::from_universe(5, 512).unwrap()];
        let mut w = ArtRecWriter::new(std::io::Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 1, 0, 0)
            .unwrap();
        let mut cur = vec![vec![0u8; 512]];
        for (t, v) in [(0u64, 1u8), (50_000, 2)] {
            cur[0][0] = v;
            w.add_full_frame(t, &cur).unwrap();
        }
        let p = dir.join(file);
        std::fs::write(&p, w.finish(100_000).unwrap().into_inner()).unwrap();
        p
    }

    struct TmpDir(std::path::PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("artnet-studio-rt-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn player_mode_tears_down_receivers_clears_state_and_survives_settings_saves() {
        let rt = runtime(&sacn_cfg(true));
        rt.apply_settings(&sacn_cfg(true));
        assert!(wait_for_handle(&rt), "实时模式下应有 sACN 接收任务");
        lock(&rt.engine).ingest(&sacn_frame(2, [10, 0, 0, 2]), 0);
        lock(&rt.registry).upsert_source(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), Protocol::Sacn, 0);
        assert_eq!(rt.snapshot().len(), 1);

        let st = rt.set_app_mode(AppMode::Player, &noop_emit()).unwrap();
        assert_eq!((st.mode, st.receivers), (AppMode::Player, ReceiversState::Suspended));
        assert!(rt.mode.is_player(), "接收循环据此丢弃迟到帧");
        assert!(lock(&rt.sacn).handle.is_none(), "sACN 接收应已拆除");
        assert!(rt.snapshot().is_empty(), "实时信号应被清空");
        assert!(rt.devices().is_empty(), "设备表应被清空");

        // 在播放器模式下保存设置，不能把 sACN 接收悄悄重建出来
        rt.apply_settings(&sacn_cfg(true));
        std::thread::sleep(Duration::from_millis(150));
        assert!(lock(&rt.sacn).handle.is_none() && lock(&rt.sacn).applied.is_none());

        // 退出：以最新配置重建，并放开标志
        let st = rt.set_app_mode(AppMode::Live, &noop_emit()).unwrap();
        assert_eq!((st.mode, st.receivers), (AppMode::Live, ReceiversState::Bound));
        assert!(!rt.mode.is_player());
        assert!(wait_for_handle(&rt), "退出后应重建 sACN 接收");
    }

    #[test]
    fn scanning_is_refused_while_receivers_are_suspended() {
        let rt = runtime(&sacn_cfg(false));
        rt.artnet_enabled.store(true, std::sync::atomic::Ordering::Relaxed); // 模拟接收已绑定
        rt.set_app_mode(AppMode::Player, &noop_emit()).unwrap();
        let err = tauri::async_runtime::block_on(rt.scan_network()).unwrap_err();
        assert_eq!(err, super::SCAN_ERR_ARTNET_DISABLED);
    }

    #[test]
    fn recording_blocks_entering_player_mode_and_nothing_changes() {
        let rt = runtime(&sacn_cfg(false));
        rt.mode.set_recording(true);
        let err = rt.set_app_mode(AppMode::Player, &noop_emit()).unwrap_err();
        assert_eq!(err, crate::playback::ERR_RECORDING_ACTIVE);
        assert_eq!(rt.app_mode_status().mode, AppMode::Live);
        assert!(!rt.mode.is_player());
    }

    #[test]
    fn opening_a_program_enters_player_mode_and_leaving_closes_it() {
        let tmp = TmpDir::new("open");
        let file = write_program(&tmp.0, "a.artrec");
        let rt = runtime(&sacn_cfg(false));
        let events: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = events.clone();
        let emit: Emitter = Arc::new(move |n, _| sink.lock().unwrap().push(n.to_string()));

        let st = rt
            .open_playback(emit.clone(), file, "a".into(), DispatchTarget::Forwarding, tmp.0.clone())
            .unwrap();
        assert!(st.loaded);
        assert_eq!(rt.app_mode_status().mode, AppMode::Player, "打开节目应自动进入播放器模式");
        assert!(events.lock().unwrap().iter().any(|n| n == "app:mode"));

        // 只关闭节目不会退出播放器模式
        rt.playback().close();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(rt.app_mode_status().mode, AppMode::Player);

        rt.set_app_mode(AppMode::Live, &emit).unwrap();
        assert!(!rt.mode.is_player());
    }

    #[test]
    fn failing_to_open_a_program_rolls_back_to_live_mode() {
        let tmp = TmpDir::new("badopen");
        let bad = tmp.0.join("bad.artrec");
        std::fs::write(&bad, [b'X'; 100]).unwrap();
        let rt = runtime(&sacn_cfg(false));

        let err = rt
            .open_playback(noop_emit(), bad, "bad".into(), DispatchTarget::Forwarding, tmp.0.clone())
            .unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(rt.app_mode_status().mode, AppMode::Live, "打不开节目时不能把用户留在播放器模式");
        assert!(!rt.mode.is_player());
    }

    #[test]
    fn opening_while_already_in_player_mode_does_not_roll_back_on_failure() {
        let tmp = TmpDir::new("stay");
        let good = write_program(&tmp.0, "a.artrec");
        let bad = tmp.0.join("bad.artrec");
        std::fs::write(&bad, [b'X'; 100]).unwrap();
        let rt = runtime(&sacn_cfg(false));
        rt.open_playback(noop_emit(), good, "a".into(), DispatchTarget::Forwarding, tmp.0.clone())
            .unwrap();
        assert!(rt
            .open_playback(noop_emit(), bad, "bad".into(), DispatchTarget::Forwarding, tmp.0.clone())
            .is_err());
        assert_eq!(rt.app_mode_status().mode, AppMode::Player, "原本就在播放器模式，失败不应退出");
    }
}
