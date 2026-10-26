//! 44Hz UDP 发送器：把图案或手动数据按 Art-Net / sACN 发到目标。
//!
//! [`SignalSender`] 是一个可克隆的控制句柄，真正的发送在后台 tokio 任务里进行：
//!
//! - 每个 tick（约 22.7ms，`MissedTickBehavior::Skip`）按**真实经过时间 × 速度**推进相位，
//!   所以计时抖动不会让图案变速；
//! - 运行中可随时改配置 / 模式 / 图案 / 速度 / 手动数据，下一个 tick 生效；
//! - 改目标或协议时，先向**旧目标**把已点亮的 Universe 清零（sACN 发 Stream Terminated），再切到新目标；
//!   缩小 Universe 范围时，被移除的 Universe 同样立即清零；
//! - 停止时对本次运行里**发送过的全部 Universe** 清零，而不是只清最后一次配置的范围。
//!
//! 错误（如网络不可达）计数并通过 [`EventSink`] 上报，相同文案 1 秒内只上报一次，避免刷屏。

use std::collections::{BTreeSet, HashMap};
use std::io;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use artnet_net::{artnet, sacn};
use serde::Serialize;
use thiserror::Error;
use tokio::net::UdpSocket;
use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::config::{ConfigError, SignalConfig, SignalProtocol, ValidConfig};
use crate::manual::{ManualData, ManualError};
use crate::pattern::{clamp_speed, render, Clock, PatternId, CHANNELS};

/// 目标发送频率（Hz）。
pub const SEND_RATE_HZ: u32 = 44;

/// 两个 tick 之间的间隔。
const TICK: Duration = Duration::from_nanos(1_000_000_000 / SEND_RATE_HZ as u64);
/// 每隔多少个 tick 上报一次预览（约 8.8Hz）。
const PREVIEW_EVERY: u64 = 5;
/// sACN 源名称。
const SOURCE_NAME: &str = "Art-Net Studio Signal Checker";
/// sACN 优先级。
const SACN_PRIORITY: u8 = 100;
/// 停止某个 sACN Universe 时连发的 Stream Terminated 包数（E1.31 建议 3 次）。
const TERMINATE_REPEATS: usize = 3;
/// 相同错误文案的最短上报间隔。
const ERROR_REPEAT_WINDOW: Duration = Duration::from_secs(1);
/// 全 0 数据，用于清零。
const ZEROS: [u8; CHANNELS] = [0; CHANNELS];

/// 发送模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SendMode {
    /// 自动：发送选定的测试图案。
    Auto,
    /// 手动：发送用户逐通道设置的数据。
    Manual,
}

/// 发送器向外上报的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SenderEvent {
    /// 发送出错（已按文案做 1 秒限流）。
    Error {
        /// 出错时正在发送的 Universe。
        universe: Option<u16>,
        /// 系统给出的错误描述。
        message: String,
    },
    /// 被查看 Universe 的当前输出（约 8.8Hz）。
    Preview {
        /// Universe 编号。
        universe: u16,
        /// 512 个通道值。
        data: Vec<u8>,
    },
}

/// 事件回调。由应用壳实现为"转成 Tauri 事件"；测试里收集到向量。
pub type EventSink = Arc<dyn Fn(SenderEvent) + Send + Sync>;

/// 发送器错误。序列化为 `{ "code": "...", ... }`。
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum SenderError {
    /// 无法创建 / 配置 UDP 套接字。
    #[error("无法创建发送套接字：{message}")]
    Socket {
        /// 系统给出的错误描述。
        message: String,
    },
}

/// 发送器状态快照（`camelCase` 序列化后直接给前端）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderStatus {
    /// 是否正在发送。
    pub running: bool,
    /// 当前模式。
    pub mode: SendMode,
    /// 当前图案。
    pub pattern: PatternId,
    /// 当前倍速。
    pub speed: f64,
    /// 本次运行已发送的包数。
    pub packets_sent: u64,
    /// 本次运行发送失败的次数。
    pub send_errors: u64,
    /// 实测发送频率（Hz，每秒刷新一次；未运行为 0）。
    pub measured_hz: f64,
    /// 当前配置的 Universe 数量。
    pub universe_count: usize,
    /// 当前生效的 Universe 列表（升序），界面据此列出可预览 / 可手动设值的 Universe。
    pub universes: Vec<u16>,
    /// 最近一次生效的配置（原文）。
    pub config: SignalConfig,
    /// 最近一次发送错误的描述。
    pub last_error: Option<String>,
}

/// 可变的发送参数（由控制句柄写、发送任务读）。
struct State {
    config: SignalConfig,
    valid: ValidConfig,
    mode: SendMode,
    pattern: PatternId,
    speed: f64,
    clock: Clock,
    manual: ManualData,
    preview: Option<u16>,
}

impl State {
    /// 当前应发送的全部 Universe 及其数据。
    fn frames(&self) -> Vec<(u16, [u8; CHANNELS])> {
        let phase = self.clock.phase_ms();
        self.valid
            .universes
            .iter()
            .enumerate()
            .map(|(index, &universe)| {
                let data = match self.mode {
                    SendMode::Auto => render(self.pattern, phase, index),
                    SendMode::Manual => self.manual.get(universe),
                };
                (universe, data)
            })
            .collect()
    }
}

/// 一个 tick 开始时从共享状态里取出的快照。
struct Snapshot {
    valid: ValidConfig,
    frames: Vec<(u16, [u8; CHANNELS])>,
    preview: Option<u16>,
}

/// 运行中任务的句柄。
struct RunHandle {
    stop: oneshot::Sender<()>,
    join: JoinHandle<()>,
}

/// 控制句柄与发送任务共享的数据。
struct Shared {
    state: Mutex<State>,
    run: Mutex<Option<RunHandle>>,
    last_error: Mutex<Option<String>>,
    packets: AtomicU64,
    errors: AtomicU64,
    /// 实测频率 × 100（用整数原子存取）。
    hz_x100: AtomicU32,
    emit: EventSink,
    cid: [u8; 16],
}

impl Shared {
    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_running(&self) -> bool {
        self.run
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    /// 推进时钟并取出本 tick 要发送的内容。
    fn advance(&self, dt_ms: f64) -> Snapshot {
        let mut st = self.lock_state();
        let speed = st.speed;
        st.clock.advance(dt_ms, speed);
        Snapshot {
            valid: st.valid.clone(),
            frames: st.frames(),
            preview: st.preview,
        }
    }

    fn record_error(&self, message: &str) {
        self.errors.fetch_add(1, Ordering::Relaxed);
        *self
            .last_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(message.to_string());
    }
}

/// 测试信号发送器的控制句柄（廉价克隆，所有克隆共享同一个发送器）。
#[derive(Clone)]
pub struct SignalSender {
    shared: Arc<Shared>,
    handle: Handle,
}

impl SignalSender {
    /// 创建发送器（尚未开始发送）。
    ///
    /// # Arguments
    ///
    /// * `handle` - 运行发送任务的 tokio 运行时句柄（应用壳传入 Tauri 的异步运行时）。
    /// * `emit` - 事件回调，会在发送任务线程里被调用，须快速返回。
    ///
    /// # Returns
    ///
    /// 使用默认配置（`127.0.0.1:6454`、Art-Net、Universe 0、正弦波、1×）的发送器。
    #[must_use]
    pub fn new(handle: Handle, emit: EventSink) -> Self {
        let state = State {
            config: SignalConfig::default(),
            valid: ValidConfig::default(),
            mode: SendMode::Auto,
            pattern: PatternId::Sine,
            speed: 1.0,
            clock: Clock::new(),
            manual: ManualData::new(),
            preview: None,
        };
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(state),
                run: Mutex::new(None),
                last_error: Mutex::new(None),
                packets: AtomicU64::new(0),
                errors: AtomicU64::new(0),
                hz_x100: AtomicU32::new(0),
                emit,
                cid: make_cid(),
            }),
            handle,
        }
    }

    /// 应用新的发送配置。运行中调用时，下一个 tick 生效（并按需向旧目标 / 被移除的 Universe 清零）。
    ///
    /// # Arguments
    ///
    /// * `config` - 用户填写的配置。
    ///
    /// # Errors
    ///
    /// 配置未通过 [`SignalConfig::validate`] 时返回对应的 [`ConfigError`]，原配置保持不变。
    pub fn configure(&self, config: SignalConfig) -> Result<(), ConfigError> {
        let valid = config.validate()?;
        let mut st = self.shared.lock_state();
        st.config = config;
        st.valid = valid;
        Ok(())
    }

    /// 切换自动 / 手动模式。
    ///
    /// # Arguments
    ///
    /// * `mode` - 目标模式。
    pub fn set_mode(&self, mode: SendMode) {
        self.shared.lock_state().mode = mode;
    }

    /// 选择测试图案。相位保持连续，不会重新开始。
    ///
    /// # Arguments
    ///
    /// * `pattern` - 目标图案。
    pub fn set_pattern(&self, pattern: PatternId) {
        self.shared.lock_state().pattern = pattern;
    }

    /// 设置倍速。
    ///
    /// # Arguments
    ///
    /// * `speed` - 请求的倍速，经 [`clamp_speed`] 夹紧到 0.25 到 4。
    pub fn set_speed(&self, speed: f64) {
        self.shared.lock_state().speed = clamp_speed(speed);
    }

    /// 手动模式：设置单个通道。
    ///
    /// # Arguments
    ///
    /// * `universe` - 目标 Universe。
    /// * `channel` - 通道号，`1..=512`。
    /// * `value` - 通道值。
    ///
    /// # Errors
    ///
    /// 通道号越界时返回 [`ManualError::ChannelOutOfRange`]。
    pub fn set_channel(&self, universe: u16, channel: u16, value: u8) -> Result<(), ManualError> {
        self.shared
            .lock_state()
            .manual
            .set_channel(universe, channel, value)
    }

    /// 手动模式：把某个 Universe 的 512 个通道设为同一个值。
    ///
    /// # Arguments
    ///
    /// * `universe` - 目标 Universe。
    /// * `value` - 通道值。
    pub fn set_all(&self, universe: u16, value: u8) {
        self.shared.lock_state().manual.set_all(universe, value);
    }

    /// 手动模式：清除某个 Universe 的手动数据。
    ///
    /// # Arguments
    ///
    /// * `universe` - 目标 Universe。
    pub fn clear_universe(&self, universe: u16) {
        self.shared.lock_state().manual.clear_universe(universe);
    }

    /// 手动模式：清除全部手动数据。
    pub fn clear_all(&self) {
        self.shared.lock_state().manual.clear_all();
    }

    /// 设置要实时预览的 Universe；`None` 关闭预览。只有处于发送范围内的 Universe 才会上报预览事件。
    ///
    /// # Arguments
    ///
    /// * `universe` - 要查看的 Universe。
    pub fn set_preview(&self, universe: Option<u16>) {
        self.shared.lock_state().preview = universe;
    }

    /// 计算某个 Universe 当前会发出的内容（停止状态下也可用，供手动模式读回与预览初始值）。
    ///
    /// # Arguments
    ///
    /// * `universe` - 要查看的 Universe；不在发送范围内时按范围内第 0 个 Universe 的相位渲染。
    ///
    /// # Returns
    ///
    /// 512 个通道值。
    #[must_use]
    pub fn frame_for(&self, universe: u16) -> [u8; CHANNELS] {
        let st = self.shared.lock_state();
        match st.mode {
            SendMode::Manual => st.manual.get(universe),
            SendMode::Auto => {
                let index = st
                    .valid
                    .universes
                    .iter()
                    .position(|&u| u == universe)
                    .unwrap_or(0);
                render(st.pattern, st.clock.phase_ms(), index)
            }
        }
    }

    /// 开始发送。已在发送时什么也不做。
    ///
    /// 计数器与相位从 0 重新开始。
    ///
    /// # Errors
    ///
    /// 无法创建或配置 UDP 套接字时返回 [`SenderError::Socket`]。
    pub async fn start(&self) -> Result<(), SenderError> {
        if self.shared.is_running() {
            return Ok(());
        }
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
            .await
            .map_err(|e| socket_error(&e))?;
        socket.set_broadcast(true).map_err(|e| socket_error(&e))?;

        let mut run = self
            .shared
            .run
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if run.is_some() {
            return Ok(()); // 并发的另一次 start 抢先了
        }
        self.shared.packets.store(0, Ordering::Relaxed);
        self.shared.errors.store(0, Ordering::Relaxed);
        self.shared.hz_x100.store(0, Ordering::Relaxed);
        *self
            .shared
            .last_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
        self.shared.lock_state().clock.reset();

        let (stop, stop_rx) = oneshot::channel();
        let join = self
            .handle
            .spawn(run_loop(self.shared.clone(), socket, stop_rx));
        *run = Some(RunHandle { stop, join });
        Ok(())
    }

    /// 停止发送并等待收尾包（清零 / Stream Terminated）发完。没有在发送时什么也不做。
    pub async fn stop(&self) {
        let run = self
            .shared
            .run
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(run) = run {
            let _ = run.stop.send(());
            let _ = run.join.await;
        }
        self.shared.lock_state().clock.reset();
        self.shared.hz_x100.store(0, Ordering::Relaxed);
    }

    /// 读取状态快照。
    ///
    /// # Returns
    ///
    /// 当前 [`SenderStatus`]。
    #[must_use]
    pub fn status(&self) -> SenderStatus {
        let running = self.shared.is_running();
        let last_error = self
            .shared
            .last_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let st = self.shared.lock_state();
        SenderStatus {
            running,
            mode: st.mode,
            pattern: st.pattern,
            speed: st.speed,
            packets_sent: self.shared.packets.load(Ordering::Relaxed),
            send_errors: self.shared.errors.load(Ordering::Relaxed),
            measured_hz: f64::from(self.shared.hz_x100.load(Ordering::Relaxed)) / 100.0,
            universe_count: st.valid.universes.len(),
            universes: st.valid.universes.clone(),
            config: st.config.clone(),
            last_error,
        }
    }
}

fn socket_error(e: &io::Error) -> SenderError {
    SenderError::Socket {
        message: e.to_string(),
    }
}

/// 生成本进程的 sACN CID：`SIGCHK` 前缀加上由时间和进程号混合出的 10 字节。
fn make_cid() -> [u8; 16] {
    let mut cid = [0u8; 16];
    cid[..6].copy_from_slice(b"SIGCHK");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let mixed = nanos ^ (u128::from(std::process::id()) << 64);
    cid[6..].copy_from_slice(&mixed.to_le_bytes()[..10]);
    cid
}

/// 取下一个序列号：每个 Universe 独立计数，`255` 之后回到 `1`，**永远不产生 0**
/// （Art-Net 中 0 表示"不使用序列号"，接收端会据此关闭乱序检测）。
fn next_seq(seqs: &mut HashMap<u16, u8>, universe: u16) -> u8 {
    let slot = seqs.entry(universe).or_insert(0);
    *slot = if *slot == u8::MAX { 1 } else { *slot + 1 };
    *slot
}

/// 这类错误只说明"上一个包被对端的 ICMP 端口不可达拒绝了"（Windows 上表现为 `ConnectionReset`），
/// 目标没在监听时每个 tick 都会出现，不算发送故障，也不上报。
fn is_soft_error(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionRefused
    )
}

/// 相同文案在窗口期内只放行一次。
#[derive(Default)]
struct ErrorLimiter {
    last: Option<(String, Instant)>,
}

impl ErrorLimiter {
    fn allow(&mut self, message: &str, now: Instant) -> bool {
        if let Some((last_message, at)) = &self.last {
            if last_message == message && now.duration_since(*at) < ERROR_REPEAT_WINDOW {
                return false;
            }
        }
        self.last = Some((message.to_string(), now));
        true
    }
}

/// 统计实测发送频率：每满 1 秒结算一次。
struct RateMeter {
    started: Instant,
    ticks: u32,
}

impl RateMeter {
    fn new(now: Instant) -> Self {
        Self {
            started: now,
            ticks: 0,
        }
    }

    #[allow(clippy::cast_sign_loss)] // 频率非负
    fn tick(&mut self, now: Instant, out: &AtomicU32) {
        self.ticks += 1;
        let elapsed = now.duration_since(self.started);
        if elapsed >= Duration::from_secs(1) {
            let hz = f64::from(self.ticks) / elapsed.as_secs_f64();
            out.store((hz * 100.0).round() as u32, Ordering::Relaxed);
            self.started = now;
            self.ticks = 0;
        }
    }
}

/// 发送任务独占的网络状态：套接字、序列号与错误限流。
struct Wire {
    socket: UdpSocket,
    seqs: HashMap<u16, u8>,
    limiter: ErrorLimiter,
    shared: Arc<Shared>,
}

impl Wire {
    /// 发一个 Universe 的一帧。`terminated` 仅对 sACN 有效。
    async fn send(&mut self, cfg: &ValidConfig, universe: u16, data: &[u8], terminated: bool) {
        let seq = next_seq(&mut self.seqs, universe);
        let packet = match cfg.protocol {
            SignalProtocol::ArtNet => artnet::build_dmx(universe, seq, data),
            SignalProtocol::Sacn if terminated => sacn::build_terminated(
                universe,
                data,
                &self.shared.cid,
                SOURCE_NAME,
                SACN_PRIORITY,
                seq,
            ),
            SignalProtocol::Sacn => sacn::build(
                universe,
                data,
                &self.shared.cid,
                SOURCE_NAME,
                SACN_PRIORITY,
                seq,
            ),
        };
        if packet.is_empty() {
            return; // Universe 超出协议范围；配置校验已排除，这里只是兜底
        }
        match self.socket.send_to(&packet, cfg.target).await {
            Ok(_) => {
                self.shared.packets.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) if is_soft_error(e.kind()) => {}
            Err(e) => self.report(universe, &e),
        }
    }

    fn report(&mut self, universe: u16, error: &io::Error) {
        let message = error.to_string();
        self.shared.record_error(&message);
        if self.limiter.allow(&message, Instant::now()) {
            (self.shared.emit)(SenderEvent::Error {
                universe: Some(universe),
                message,
            });
        }
    }

    /// 向目标把指定 Universe 清零：Art-Net 发一包全 0，sACN 连发 3 个带终止标志的全 0 包。
    async fn goodbye(&mut self, cfg: &ValidConfig, universes: &BTreeSet<u16>) {
        for &universe in universes {
            match cfg.protocol {
                SignalProtocol::ArtNet => self.send(cfg, universe, &ZEROS, false).await,
                SignalProtocol::Sacn => {
                    for _ in 0..TERMINATE_REPEATS {
                        self.send(cfg, universe, &ZEROS, true).await;
                    }
                }
            }
        }
    }
}

/// 发送任务正在使用的目标和已点亮的 Universe，用来在配置变化时做收尾。
#[derive(Default)]
struct Live {
    active: Option<ValidConfig>,
    touched: BTreeSet<u16>,
}

impl Live {
    /// 配置变化时的收尾：换目标 / 协议则对旧目标全部清零，缩小范围则只清被移除的 Universe。
    async fn reconcile(&mut self, wire: &mut Wire, next: &ValidConfig) {
        let Some(active) = self.active.clone() else {
            self.active = Some(next.clone());
            return;
        };
        if active.target != next.target || active.protocol != next.protocol {
            wire.goodbye(&active, &self.touched).await;
            self.touched.clear();
            wire.seqs.clear();
        } else if active.universes != next.universes {
            let removed: BTreeSet<u16> = self
                .touched
                .iter()
                .copied()
                .filter(|u| !next.universes.contains(u))
                .collect();
            wire.goodbye(&active, &removed).await;
            self.touched.retain(|u| next.universes.contains(u));
        }
        self.active = Some(next.clone());
    }
}

/// 发送任务主循环；收到停止信号（或句柄被丢弃）后做收尾并退出。
async fn run_loop(shared: Arc<Shared>, socket: UdpSocket, mut stop: oneshot::Receiver<()>) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut wire = Wire {
        socket,
        seqs: HashMap::new(),
        limiter: ErrorLimiter::default(),
        shared: shared.clone(),
    };
    let mut live = Live::default();
    let mut last = Instant::now();
    let mut meter = RateMeter::new(last);
    let mut tick_no: u64 = 0;

    loop {
        tokio::select! {
            biased;
            _ = &mut stop => break,
            _ = interval.tick() => {}
        }
        let now = Instant::now();
        let dt_ms = now.duration_since(last).as_secs_f64() * 1000.0;
        last = now;

        let snap = shared.advance(dt_ms);
        live.reconcile(&mut wire, &snap.valid).await;
        for (universe, data) in &snap.frames {
            wire.send(&snap.valid, *universe, data, false).await;
            live.touched.insert(*universe);
        }
        if tick_no.is_multiple_of(PREVIEW_EVERY) {
            emit_preview(&shared, &snap);
        }
        tick_no += 1;
        meter.tick(now, &shared.hz_x100);
    }

    if let Some(active) = live.active.take() {
        wire.goodbye(&active, &live.touched).await;
    }
}

/// 上报被查看 Universe 的当前输出（不在发送范围内则不报）。
fn emit_preview(shared: &Shared, snap: &Snapshot) {
    let Some(universe) = snap.preview else {
        return;
    };
    if let Some((_, data)) = snap.frames.iter().find(|(u, _)| *u == universe) {
        (shared.emit)(SenderEvent::Preview {
            universe,
            data: data.to_vec(),
        });
    }
}

#[cfg(test)]
mod tests {
    use artnet_net::artnet::ArtNetPacket;

    use super::*;

    type Events = Arc<Mutex<Vec<SenderEvent>>>;

    fn sender() -> (SignalSender, Events) {
        let events: Events = Arc::default();
        let sink = events.clone();
        let emit: EventSink = Arc::new(move |e| sink.lock().unwrap().push(e));
        (SignalSender::new(Handle::current(), emit), events)
    }

    async fn rx() -> (UdpSocket, u16) {
        let sock = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = sock.local_addr().unwrap().port();
        (sock, port)
    }

    fn cfg(port: u16, protocol: SignalProtocol, universes: &str) -> SignalConfig {
        SignalConfig {
            target_ip: "127.0.0.1".into(),
            port,
            protocol,
            universes: universes.into(),
        }
    }

    async fn recv_n(sock: &UdpSocket, n: usize) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        while out.len() < n {
            let (len, _) = tokio::time::timeout(Duration::from_secs(3), sock.recv_from(&mut buf))
                .await
                .expect("等待数据包超时")
                .unwrap();
            out.push(buf[..len].to_vec());
        }
        out
    }

    /// 读空接收缓冲：已到达的包立即读出，缓冲为空后再等 5ms 就结束。
    ///
    /// 发送器仍在运行时每 22.7ms 才来一个包，所以不会无限读下去；
    /// 发送器已停止时，收尾包早已在缓冲里。
    async fn drain(sock: &UdpSocket) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        while let Ok(Ok((len, _))) =
            tokio::time::timeout(Duration::from_millis(5), sock.recv_from(&mut buf)).await
        {
            out.push(buf[..len].to_vec());
        }
        out
    }

    /// 解出 Art-Net 包的 (Universe, 序列号, 数据)。
    fn art(packet: &[u8]) -> (u16, u8, Vec<u8>) {
        match artnet::parse(packet) {
            Some(ArtNetPacket::Dmx {
                port_address,
                sequence,
                data,
            }) => (port_address, sequence, data),
            other => panic!("不是 ArtDmx：{other:?}"),
        }
    }

    fn all(data: &[u8], v: u8) -> bool {
        data.len() == CHANNELS && data.iter().all(|&b| b == v)
    }

    #[test]
    fn sequence_numbers_wrap_to_one_and_never_hit_zero() {
        let mut seqs = HashMap::new();
        let got: Vec<u8> = (0..600).map(|_| next_seq(&mut seqs, 7)).collect();
        assert_eq!(&got[..3], &[1, 2, 3]);
        assert_eq!(got[254], 255);
        assert_eq!(got[255], 1, "255 之后回到 1，而不是 0");
        assert!(got.iter().all(|&s| s != 0));
        // 各 Universe 独立计数
        assert_eq!(next_seq(&mut seqs, 8), 1);
    }

    #[test]
    fn error_limiter_suppresses_repeats_inside_the_window() {
        let t0 = Instant::now();
        let mut l = ErrorLimiter::default();
        assert!(l.allow("网络不可达", t0));
        assert!(!l.allow("网络不可达", t0 + Duration::from_millis(500)));
        assert!(
            l.allow("另一种错误", t0 + Duration::from_millis(600)),
            "不同文案不受限"
        );
        assert!(
            l.allow("另一种错误", t0 + Duration::from_millis(1700)),
            "窗口过后可再次上报"
        );
    }

    #[test]
    fn only_connection_reset_and_refused_are_soft() {
        assert!(is_soft_error(io::ErrorKind::ConnectionReset));
        assert!(is_soft_error(io::ErrorKind::ConnectionRefused));
        assert!(!is_soft_error(io::ErrorKind::NetworkUnreachable));
        assert!(!is_soft_error(io::ErrorKind::PermissionDenied));
    }

    #[test]
    fn cid_carries_the_signal_checker_prefix() {
        let cid = make_cid();
        assert_eq!(&cid[..6], b"SIGCHK");
        assert_ne!(&cid[6..], &[0u8; 10]);
    }

    #[tokio::test]
    async fn artnet_packets_are_valid_artdmx_for_every_universe() {
        let (sock, port) = rx().await;
        let (s, _) = sender();
        s.configure(cfg(port, SignalProtocol::ArtNet, "0-2"))
            .unwrap();
        s.set_pattern(PatternId::FullOn);
        s.start().await.unwrap();
        let packets = recv_n(&sock, 9).await;
        s.stop().await;

        let mut seen = BTreeSet::new();
        for p in &packets {
            assert_eq!(p.len(), 18 + CHANNELS);
            let (universe, seq, data) = art(p);
            assert!(universe <= 2);
            assert_ne!(seq, 0);
            assert!(all(&data, 255));
            seen.insert(universe);
        }
        assert_eq!(seen, BTreeSet::from([0, 1, 2]));
    }

    #[tokio::test]
    async fn sacn_packets_parse_with_our_cid_name_and_priority() {
        let (sock, port) = rx().await;
        let (s, _) = sender();
        s.configure(cfg(port, SignalProtocol::Sacn, "1-2")).unwrap();
        s.set_pattern(PatternId::FullOn);
        s.start().await.unwrap();
        let packets = recv_n(&sock, 4).await;
        s.stop().await;

        for p in &packets {
            let d = sacn::parse(p).expect("应是合法 sACN 包");
            assert!((1..=2).contains(&d.universe));
            assert_eq!(d.priority, 100);
            assert_eq!(d.source_name(), "Art-Net Studio Signal Checker");
            assert_eq!(&d.cid[..6], b"SIGCHK");
            assert!(all(&d.data, 255));
            assert_eq!(p[112], 0x00, "正常数据包不带终止标志");
        }
    }

    #[tokio::test]
    async fn stopping_blackouts_every_universe_it_touched() {
        let (sock, port) = rx().await;
        let (s, _) = sender();
        s.configure(cfg(port, SignalProtocol::ArtNet, "0-1"))
            .unwrap();
        s.set_pattern(PatternId::FullOn);
        s.start().await.unwrap();
        recv_n(&sock, 6).await;
        s.stop().await;

        let rest: Vec<_> = drain(&sock).await.iter().map(|p| art(p)).collect();
        for universe in [0u16, 1] {
            let last = rest
                .iter()
                .rev()
                .find(|(u, _, _)| *u == universe)
                .expect("应收到收尾包");
            assert!(all(&last.2, 0), "Universe {universe} 停止后应被清零");
        }
    }

    #[tokio::test]
    async fn sacn_stop_sends_three_terminated_packets_per_universe() {
        let (sock, port) = rx().await;
        let (s, _) = sender();
        s.configure(cfg(port, SignalProtocol::Sacn, "1-2")).unwrap();
        s.set_pattern(PatternId::FullOn);
        s.start().await.unwrap();
        recv_n(&sock, 4).await;
        s.stop().await;

        let rest = drain(&sock).await;
        for universe in [1u16, 2] {
            let terminated: Vec<_> = rest
                .iter()
                .filter(|p| p[112] == 0x40 && sacn::parse(p).unwrap().universe == universe)
                .collect();
            assert_eq!(terminated.len(), 3, "Universe {universe}");
            assert!(terminated
                .iter()
                .all(|p| all(&sacn::parse(p).unwrap().data, 0)));
        }
    }

    #[tokio::test]
    async fn shrinking_the_range_blackouts_only_the_removed_universe() {
        let (sock, port) = rx().await;
        let (s, _) = sender();
        s.configure(cfg(port, SignalProtocol::ArtNet, "0-1"))
            .unwrap();
        s.set_pattern(PatternId::FullOn);
        s.start().await.unwrap();
        recv_n(&sock, 6).await;

        s.configure(cfg(port, SignalProtocol::ArtNet, "0")).unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        let after: Vec<_> = drain(&sock).await.iter().map(|p| art(p)).collect();
        s.stop().await;

        let u1: Vec<_> = after.iter().filter(|(u, _, _)| *u == 1).collect();
        let zeros = u1.iter().filter(|(_, _, d)| all(d, 0)).count();
        assert_eq!(zeros, 1, "被移除的 Universe 恰好收到一次清零");
        assert!(
            all(&u1.last().unwrap().2, 0),
            "清零之后不再有该 Universe 的数据"
        );

        let u0_last = after.iter().rev().find(|(u, _, _)| *u == 0).unwrap();
        assert!(all(&u0_last.2, 255), "保留的 Universe 继续正常发送");
    }

    #[tokio::test]
    async fn changing_the_target_blackouts_the_old_one_and_moves_on() {
        let (old, old_port) = rx().await;
        let (new, new_port) = rx().await;
        let (s, _) = sender();
        s.configure(cfg(old_port, SignalProtocol::ArtNet, "0"))
            .unwrap();
        s.set_pattern(PatternId::FullOn);
        s.start().await.unwrap();
        recv_n(&old, 3).await;

        s.configure(cfg(new_port, SignalProtocol::ArtNet, "0"))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        let old_rest = drain(&old).await;
        let new_got = drain(&new).await;
        s.stop().await;

        assert!(
            all(&art(old_rest.last().unwrap()).2, 0),
            "旧目标最后收到的是清零"
        );
        assert!(
            new_got.iter().any(|p| all(&art(p).2, 255)),
            "新目标收到正常数据"
        );
        // 换目标后序列号重新从 1 开始
        assert_eq!(art(&new_got[0]).1, 1);
    }

    #[tokio::test]
    async fn manual_mode_sends_the_manual_data_and_follows_edits() {
        let (sock, port) = rx().await;
        let (s, _) = sender();
        s.configure(cfg(port, SignalProtocol::ArtNet, "0")).unwrap();
        s.set_mode(SendMode::Manual);
        s.set_channel(0, 10, 200).unwrap();
        s.start().await.unwrap();

        let first = art(&recv_n(&sock, 2).await[1]).2;
        assert_eq!(first[9], 200);
        assert_eq!(first.iter().filter(|&&v| v != 0).count(), 1);

        s.set_all(0, 77);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let later = drain(&sock).await;
        assert!(all(&art(later.last().unwrap()).2, 77));

        s.clear_universe(0);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let cleared = drain(&sock).await;
        s.stop().await;
        assert!(all(&art(cleared.last().unwrap()).2, 0));
    }

    #[tokio::test]
    async fn pattern_can_change_while_running() {
        let (sock, port) = rx().await;
        let (s, _) = sender();
        s.configure(cfg(port, SignalProtocol::ArtNet, "0")).unwrap();
        s.set_pattern(PatternId::FullOn);
        s.start().await.unwrap();
        recv_n(&sock, 3).await;
        s.set_pattern(PatternId::Blackout);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let after = drain(&sock).await;
        s.stop().await;
        assert!(all(&art(after.last().unwrap()).2, 0));
        assert_eq!(s.status().pattern, PatternId::Blackout);
    }

    #[tokio::test]
    async fn preview_events_are_throttled_and_only_for_universes_in_range() {
        let (sock, port) = rx().await;
        let (s, events) = sender();
        s.configure(cfg(port, SignalProtocol::ArtNet, "0-1"))
            .unwrap();
        s.set_pattern(PatternId::FullOn);
        s.set_preview(Some(1));
        s.start().await.unwrap();
        recv_n(&sock, 4).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        s.set_preview(Some(50)); // 不在发送范围内
        let before = events.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let after = events.lock().unwrap().len();
        s.stop().await;

        let previews: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                SenderEvent::Preview { universe, data } => Some((*universe, data.clone())),
                SenderEvent::Error { .. } => None,
            })
            .collect();
        assert!(
            previews.len() >= 2,
            "至少应有几次预览，实际 {}",
            previews.len()
        );
        assert!(
            previews.len() <= 10,
            "约 8.8Hz 节流，实际 {}",
            previews.len()
        );
        assert!(previews.iter().all(|(u, d)| *u == 1 && all(d, 255)));
        assert_eq!(before, after, "范围外的 Universe 不再上报预览");
    }

    #[tokio::test]
    async fn status_reports_progress_and_measured_rate() {
        let (sock, port) = rx().await;
        let (s, _) = sender();
        s.configure(cfg(port, SignalProtocol::ArtNet, "0-1"))
            .unwrap();
        assert!(!s.status().running);
        s.start().await.unwrap();
        tokio::time::sleep(Duration::from_millis(1300)).await;

        let st = s.status();
        assert!(st.running);
        assert_eq!(st.universe_count, 2);
        assert_eq!(st.universes, vec![0, 1]);
        assert_eq!(st.send_errors, 0);
        assert!(st.packets_sent >= 20, "已发送 {}", st.packets_sent);
        assert!(
            (10.0..=60.0).contains(&st.measured_hz),
            "实测频率 {}",
            st.measured_hz
        );

        s.stop().await;
        let st = s.status();
        assert!(!st.running);
        assert!(st.measured_hz.abs() < f64::EPSILON);
        drop(sock);
    }

    #[tokio::test]
    async fn start_and_stop_are_idempotent_and_restart_resets_counters() {
        let (sock, port) = rx().await;
        let (s, _) = sender();
        s.stop().await; // 没有在发送时停止：无操作
        s.configure(cfg(port, SignalProtocol::ArtNet, "0")).unwrap();
        s.start().await.unwrap();
        s.start().await.unwrap(); // 重复启动：仍只有一个发送任务
        recv_n(&sock, 3).await;
        s.stop().await;
        s.stop().await;
        assert!(s.status().packets_sent >= 3);

        s.start().await.unwrap();
        assert!(s.status().packets_sent < 3, "重新开始后计数清零");
        s.stop().await;
    }

    #[tokio::test]
    async fn invalid_config_is_rejected_and_the_old_one_stays() {
        let (s, _) = sender();
        let good = cfg(6454, SignalProtocol::Sacn, "1-4");
        s.configure(good.clone()).unwrap();
        let err = s
            .configure(cfg(6454, SignalProtocol::Sacn, "0"))
            .unwrap_err();
        assert!(matches!(err, ConfigError::OutOfRange { universe: 0, .. }));
        assert_eq!(s.status().config, good);
        assert_eq!(s.status().universe_count, 4);
    }

    #[tokio::test]
    async fn speed_is_clamped_and_frame_for_reads_back_manual_data() {
        let (s, _) = sender();
        s.set_speed(100.0);
        assert!((s.status().speed - 4.0).abs() < f64::EPSILON);
        s.set_speed(f64::NAN);
        assert!((s.status().speed - 1.0).abs() < f64::EPSILON);

        s.set_pattern(PatternId::FullOn);
        assert!(all(&s.frame_for(0), 255));
        s.set_mode(SendMode::Manual);
        assert!(all(&s.frame_for(0), 0));
        s.set_channel(0, 5, 99).unwrap();
        assert_eq!(s.frame_for(0)[4], 99);
        assert!(s.set_channel(0, 513, 1).is_err());
        s.clear_all();
        assert!(all(&s.frame_for(0), 0));
    }
}
