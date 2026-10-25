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

use crate::dispatch::{DispatchTarget, Dispatcher};
use crate::mode::{FrameFanout, RuntimeMode};
use crate::playback::{OpenParams, PlaybackController, PlaybackStatus};
use crate::recording::RecordingController;
use crate::sacn::{plan_sacn, SacnPlan};
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
    ) -> Result<PlaybackStatus, String> {
        self.playback.open(OpenParams {
            emit,
            dispatcher: self.dispatcher.clone(),
            mode: self.mode.clone(),
            started_at: self.start,
            path,
            name,
            target,
        })
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
        let artnet_enabled = cfg.protocol.artnet_enabled;
        let artnet_bound = self.artnet_enabled.clone();
        let recv_tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            if artnet_enabled {
                match socket::spawn_artnet_receiver(bind_ip, recv_tx.clone(), Some(reply_tx))
                {
                    // 仅在接收套接字真正绑定成功后才允许扫描（否则收不到回复）
                    Ok(_) => artnet_bound.store(true, Ordering::Relaxed),
                    Err(e) => tracing::warn!(error = %e, "Art-Net 接收绑定失败"),
                }
            } else {
                drop(reply_tx);
            }
        });
        // 保留发送端：sACN 接收任务由 reconcile_sacn 按设置实时启停，重建时需要它。
        *lock(&self.frame_tx) = Some(tx);
        self.reconcile_sacn(cfg);

        // 创建发送器（供转发使用）
        let sender = self.sender.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(s) = DmxSender::new(APP_CID).await {
                *sender.lock().await = Some(s);
            }
        });

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
                // 回放模式下暂停实时接收（避免回放输出被自己重新摄取形成回环）
                if mode.is_playback() {
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

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::{Duration, Instant};

    use artnet_net::{Bytes, DmxFrame, Protocol};
    use discovery::DeviceCategory;
    use settings::AppSettings;

    use super::Runtime;
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
}
