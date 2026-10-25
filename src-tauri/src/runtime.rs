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
use discovery::{Device, DeviceRegistry};
use forwarding::{ForwardingTable, RateLimiter};
use settings::AppSettings;
use signal_engine::{SignalEngine, SourceStat, UniverseSnapshot};

use crate::dispatch::{DispatchTarget, Dispatcher};
use crate::netif;
use crate::playback::{OpenParams, PlaybackController, PlaybackStatus};
use crate::recording::RecordingController;
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

/// 应用运行时句柄：共享引擎、设备注册表与被查看集合。
#[derive(Clone)]
pub struct Runtime {
    engine: Arc<Mutex<SignalEngine>>,
    registry: Arc<Mutex<DeviceRegistry>>,
    forwarding: Arc<Mutex<ForwardingTable>>,
    sender: Arc<tokio::sync::Mutex<Option<DmxSender>>>,
    /// 输出分发器：实时转发与录制回放共用。
    dispatcher: Dispatcher,
    /// 回放模式：为 true 时暂停实时接收（手册 Player Mode 语义）。
    playback_mode: Arc<AtomicBool>,
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
        Self {
            engine: Arc::new(Mutex::new(engine)),
            registry: Arc::new(Mutex::new(registry)),
            forwarding,
            sender,
            dispatcher,
            playback_mode: Arc::new(AtomicBool::new(false)),
            playback: PlaybackController::new(),
            viewed: Arc::new(Mutex::new(Vec::new())),
            artnet_enabled: Arc::new(AtomicBool::new(false)),
            scanning: Arc::new(AtomicBool::new(false)),
            recording: RecordingController::new(),
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
            mode_flag: self.playback_mode.clone(),
            started_at: self.start,
            path,
            name,
            target,
            recording_active: self.recording.is_recording(),
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

    /// 更新合并模式与源超时。
    pub fn apply_settings(&self, cfg: &AppSettings) {
        {
            let mut e = lock(&self.engine);
            e.set_mode(cfg.merge.mode);
            e.set_timeout(u64::from(cfg.merge.source_timeout_ms));
        }
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
    pub fn spawn(&self, app: AppHandle, cfg: &AppSettings) {
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
        let sacn_enabled = cfg.protocol.sacn_enabled;
        let sacn_universes = cfg.protocol.sacn_universes.clone();
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
            if sacn_enabled {
                if let Err(e) =
                    socket::spawn_sacn_receiver(bind_ip, sacn_universes, recv_tx.clone())
                {
                    tracing::warn!(error = %e, "sACN 接收绑定失败");
                }
            }
        });
        drop(tx);

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
        let recording = self.recording.clone();
        let playback_mode = self.playback_mode.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(frame) = rx.recv().await {
                // 回放模式下暂停实时接收（避免回放输出被自己重新摄取形成回环）
                if playback_mode.load(Ordering::Relaxed) {
                    continue;
                }
                // 旁路给录制线程：仅一次原子读取 + 非阻塞 try_send，不影响下方合并与转发
                recording.offer(&frame);
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
