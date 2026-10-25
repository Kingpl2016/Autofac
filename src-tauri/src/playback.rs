//! 回放控制器：在后台任务里驱动 `player::Player`，把输出交给 [`Dispatcher`]，并向前端推送状态。
//!
//! 设计要点：
//! - **回放模式**：节目被打开期间置位 `playback_mode`，实时接收循环据此丢弃实时帧
//!   （手册 Player Mode 语义，同时避免回放输出被自己重新摄取）。
//! - **时钟**：调度使用单调的墙钟微秒；`Player` 本身不依赖真实时钟，调度逻辑已由 `player` crate 单测覆盖。
//! - **输出**：回放不经 44Hz 限速（节奏由文件时间轴决定），目标可为转发表或指定 IP。

use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use artrec_core::ArtRecReader;
use player::{PlayState, Player, PlayerConfig, DEFAULT_KEEPALIVE_US};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::util::lock;

use crate::dispatch::{DispatchTarget, Dispatcher};
use crate::recording::Emitter;

/// 向前端推送回放状态 / 通道数据的节拍（约 30Hz）。
const UI_TICK: Duration = Duration::from_millis(33);
/// 非播放状态下，状态事件的最长重发间隔（兜底，保证前端重连后能同步）。
const IDLE_STATE_EVERY: Duration = Duration::from_millis(500);

/// 错误码：录制进行中，不能进入回放。
pub const ERR_RECORDING_ACTIVE: &str = "recording_active";
/// 错误码：没有已打开的节目。
pub const ERR_NO_PLAYER: &str = "no_player";
/// 错误码：Direct 目标的 IP 非法。
pub const ERR_BAD_TARGET: &str = "bad_target";

/// 回放状态（面向前端）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackState {
    /// 已停止。
    #[default]
    Stopped,
    /// 播放中。
    Playing,
    /// 已暂停。
    Paused,
}

impl From<PlayState> for PlaybackState {
    fn from(s: PlayState) -> Self {
        match s {
            PlayState::Stopped => Self::Stopped,
            PlayState::Playing => Self::Playing,
            PlayState::Paused => Self::Paused,
        }
    }
}

/// 回放状态快照（`player:state` 事件载荷与 `player_status` 返回值）。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    /// 是否已打开节目（即处于回放模式）。
    pub loaded: bool,
    /// 节目路径。
    pub path: String,
    /// 节目显示名。
    pub name: String,
    /// 播放状态。
    pub state: PlaybackState,
    /// 当前位置（微秒）。
    pub pos_us: u64,
    /// 总时长（微秒）。
    pub duration_us: u64,
    /// 倍速（千分之一）。
    pub speed_milli: u32,
    /// 是否循环。
    pub looping: bool,
    /// 帧总数。
    pub frames: u64,
    /// 已跳过的损坏帧数。
    pub corrupt_frames: u64,
    /// 节目内的 Universe 编号。
    pub universes: Vec<u16>,
    /// 输出目标。
    pub target: DispatchTarget,
    /// 启用的转发目的地数量（走转发表时若为 0 则不会有任何输出）。
    pub destinations: usize,
}

/// 校验 Direct 目标并补全默认端口。
///
/// # Arguments
///
/// * `target` - 待校验的输出目标；`Forwarding` 原样通过，`Direct` 校验其 IP。
///
/// # Returns
///
/// 规整后的目标：`Forwarding` 原样返回；`Direct` 的 IP 去除首尾空白，
/// 端口为 `0` 时按协议补全默认值（Art-Net 为 `6454`，sACN 为 `5568`）。
///
/// # Errors
///
/// IP 无法解析返回 [`ERR_BAD_TARGET`]。
pub fn normalize_target(target: DispatchTarget) -> Result<DispatchTarget, String> {
    match target {
        DispatchTarget::Forwarding => Ok(target),
        DispatchTarget::Direct { ip, protocol, port } => {
            if ip.trim().parse::<std::net::IpAddr>().is_err() {
                return Err(ERR_BAD_TARGET.to_string());
            }
            let port = if port == 0 {
                match protocol {
                    forwarding::ForwardProtocol::ArtNet => 6454,
                    forwarding::ForwardProtocol::Sacn => 5568,
                }
            } else {
                port
            };
            Ok(DispatchTarget::Direct {
                ip: ip.trim().to_string(),
                protocol,
                port,
            })
        }
    }
}

/// 发给回放任务的命令。
#[derive(Debug)]
enum Cmd {
    Play,
    Pause,
    Stop,
    Seek(u64),
    Speed(u32),
    Loop(bool),
    Target(DispatchTarget),
    Close,
}

struct Inner {
    /// 当前节目的代际号：重新打开节目会递增，旧任务退出时据此判断是否还该清理共享状态。
    generation: Arc<AtomicU64>,
    cmd: Mutex<Option<mpsc::UnboundedSender<Cmd>>>,
    status: Arc<Mutex<PlaybackStatus>>,
    viewed: Arc<Mutex<Vec<u16>>>,
}

/// 回放控制器（可克隆，内部共享）。
#[derive(Clone)]
pub struct PlaybackController {
    inner: Arc<Inner>,
}

impl Default for PlaybackController {
    fn default() -> Self {
        Self::new()
    }
}

/// 打开节目所需参数。
pub struct OpenParams {
    /// 事件发射回调。
    pub emit: Emitter,
    /// 输出分发器。
    pub dispatcher: Dispatcher,
    /// 运行时的回放模式标志，节目打开期间置位。
    pub mode_flag: Arc<AtomicBool>,
    /// 运行时起点（换算逻辑毫秒）。
    pub started_at: Instant,
    /// 已校验位于录制目录内的 `.artrec` 路径。
    pub path: PathBuf,
    /// 显示名。
    pub name: String,
    /// 输出目标。
    pub target: DispatchTarget,
    /// 当前是否正在录制（是则拒绝打开）。
    pub recording_active: bool,
}
/// 回放任务上下文。
struct TaskCtx {
    emit: Emitter,
    dispatcher: Dispatcher,
    status: Arc<Mutex<PlaybackStatus>>,
    viewed: Arc<Mutex<Vec<u16>>>,
    mode_flag: Arc<AtomicBool>,
    started_at: Instant,
    target: DispatchTarget,
    generation: Arc<AtomicU64>,
    my_generation: u64,
}

impl PlaybackController {
    /// 创建空闲的控制器。
    ///
    /// # Returns
    ///
    /// 未打开任何节目的 [`PlaybackController`]。
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                generation: Arc::new(AtomicU64::new(0)),
                cmd: Mutex::new(None),
                status: Arc::new(Mutex::new(PlaybackStatus::default())),
                viewed: Arc::new(Mutex::new(Vec::new())),
            }),
        }
    }

    /// 是否已打开节目（处于回放模式）。
    ///
    /// # Returns
    ///
    /// 已打开节目返回 `true`，否则返回 `false`。
    #[must_use]
    pub fn is_loaded(&self) -> bool {
        lock(&self.inner.status).loaded
    }

    /// 状态快照。
    ///
    /// # Returns
    ///
    /// 最近一次由回放任务更新的 [`PlaybackStatus`] 副本；未打开节目时为默认值。
    #[must_use]
    pub fn status(&self) -> PlaybackStatus {
        lock(&self.inner.status).clone()
    }

    /// 设置前端正在查看的 Universe（决定推送哪些 `player:channels`）。
    ///
    /// # Arguments
    ///
    /// * `universes` - 前端正在查看的 Universe 编号列表，会覆盖此前的设置。
    pub fn set_viewed(&self, universes: Vec<u16>) {
        *lock(&self.inner.viewed) = universes;
    }

    fn send(&self, cmd: Cmd) -> Result<(), String> {
        let guard = lock(&self.inner.cmd);
        let tx = guard.as_ref().ok_or_else(|| ERR_NO_PLAYER.to_string())?;
        tx.send(cmd).map_err(|_| ERR_NO_PLAYER.to_string())
    }

    /// 打开节目并进入回放模式（已有节目则先关闭）。
    ///
    /// # Arguments
    ///
    /// * `params` - 打开参数，见 [`OpenParams`]。
    ///
    /// # Returns
    ///
    /// 节目刚打开时的初始 [`PlaybackStatus`]（`loaded` 为 `true`）。
    ///
    /// # Errors
    ///
    /// - [`ERR_RECORDING_ACTIVE`]：录制进行中。
    /// - [`ERR_BAD_TARGET`]：目标 IP 非法。
    /// - 文件无法解析时返回描述。
    pub fn open(&self, params: OpenParams) -> Result<PlaybackStatus, String> {
        let OpenParams {
            emit,
            dispatcher,
            mode_flag,
            started_at,
            path,
            name,
            target,
            recording_active,
        } = params;
        if recording_active {
            return Err(ERR_RECORDING_ACTIVE.to_string());
        }
        let target = normalize_target(target)?;
        let reader = ArtRecReader::open_file(&path).map_err(|e| e.to_string())?;
        let looping = reader.header().loop_play();
        let player = Player::new(
            reader,
            PlayerConfig {
                keepalive_us: DEFAULT_KEEPALIVE_US,
                looping,
                ..PlayerConfig::default()
            },
        );

        // 关掉旧节目（若有）；新任务启动后才置位回放模式
        self.close();

        let (tx, rx) = mpsc::unbounded_channel::<Cmd>();
        let my_generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let ctx = TaskCtx {
            emit,
            dispatcher,
            status: self.inner.status.clone(),
            viewed: self.inner.viewed.clone(),
            mode_flag,
            started_at,
            target,
            generation: self.inner.generation.clone(),
            my_generation,
        };
        ctx.mode_flag.store(true, Ordering::Relaxed);
        let base = PlaybackStatus {
            loaded: true,
            path: path.to_string_lossy().into_owned(),
            name,
            ..PlaybackStatus::default()
        };
        let initial = build_status(&base, &player, 0, &ctx);
        *lock(&self.inner.status) = initial.clone();
        *lock(&self.inner.cmd) = Some(tx);
        ctx.emit_state(&initial);
        tauri::async_runtime::spawn(run_player(ctx, player, rx, base));
        Ok(initial)
    }

    /// 播放 / 继续。
    ///
    /// # Errors
    ///
    /// 没有已打开的节目时返回 [`ERR_NO_PLAYER`]。
    pub fn play(&self) -> Result<(), String> {
        self.send(Cmd::Play)
    }

    /// 暂停。
    ///
    /// # Errors
    ///
    /// 没有已打开的节目时返回 [`ERR_NO_PLAYER`]。
    pub fn pause(&self) -> Result<(), String> {
        self.send(Cmd::Pause)
    }

    /// 停止并回到开头。
    ///
    /// # Errors
    ///
    /// 没有已打开的节目时返回 [`ERR_NO_PLAYER`]。
    pub fn stop(&self) -> Result<(), String> {
        self.send(Cmd::Stop)
    }

    /// 跳转。
    ///
    /// # Arguments
    ///
    /// * `pos_us` - 目标位置（微秒）；超过节目时长时由回放器钳制。
    ///
    /// # Errors
    ///
    /// 没有已打开的节目时返回 [`ERR_NO_PLAYER`]。
    pub fn seek(&self, pos_us: u64) -> Result<(), String> {
        self.send(Cmd::Seek(pos_us))
    }

    /// 设置倍速（千分之一）。
    ///
    /// # Arguments
    ///
    /// * `milli` - 倍速（千分之一为单位，`1000` 即 1.0x）；由回放器钳制到允许范围。
    ///
    /// # Errors
    ///
    /// 没有已打开的节目时返回 [`ERR_NO_PLAYER`]。
    pub fn set_speed(&self, milli: u32) -> Result<(), String> {
        self.send(Cmd::Speed(milli))
    }

    /// 设置循环。
    ///
    /// # Arguments
    ///
    /// * `looping` - `true` 表示播放到结尾后回绕循环。
    ///
    /// # Errors
    ///
    /// 没有已打开的节目时返回 [`ERR_NO_PLAYER`]。
    pub fn set_loop(&self, looping: bool) -> Result<(), String> {
        self.send(Cmd::Loop(looping))
    }

    /// 切换输出目标。
    ///
    /// # Arguments
    ///
    /// * `target` - 新的输出目标；`Direct` 目标会先经 [`normalize_target`] 校验并补全端口。
    ///
    /// # Errors
    ///
    /// 目标非法返回 [`ERR_BAD_TARGET`]；没有已打开的节目返回 [`ERR_NO_PLAYER`]。
    pub fn set_target(&self, target: DispatchTarget) -> Result<(), String> {
        let target = normalize_target(target)?;
        self.send(Cmd::Target(target))
    }

    /// 关闭节目并退出回放模式（恢复实时接收）。没有节目时什么也不做。
    pub fn close(&self) {
        if let Some(tx) = lock(&self.inner.cmd).take() {
            let _ = tx.send(Cmd::Close);
        }
    }
}

impl TaskCtx {
    fn emit_state(&self, status: &PlaybackStatus) {
        (self.emit)(
            "player:state",
            serde_json::to_value(status).unwrap_or(serde_json::Value::Null),
        );
    }
}

/// 由 `Player` 当前情况和不变部分合成对外状态。
fn build_status(
    base: &PlaybackStatus,
    player: &Player<File>,
    now: u64,
    ctx: &TaskCtx,
) -> PlaybackStatus {
    let s = player.status(now);
    PlaybackStatus {
        loaded: true,
        path: base.path.clone(),
        name: base.name.clone(),
        state: s.state.into(),
        pos_us: s.pos_us,
        duration_us: s.duration_us,
        speed_milli: s.speed_milli,
        looping: s.looping,
        frames: s.frames as u64,
        corrupt_frames: s.corrupt_frames,
        universes: player.universe_ids(),
        target: ctx.target.clone(),
        destinations: ctx.dispatcher.enabled_destinations(),
    }
}

/// 把回放输出交给分发器（不限速）。
async fn output(ctx: &TaskCtx, emissions: Vec<player::Emission>) {
    let now_ms = ctx.started_at.elapsed().as_millis() as u64;
    for em in emissions {
        for u in em.universes {
            let jobs = ctx
                .dispatcher
                .plan(u.universe, &u.data, now_ms, &ctx.target, false);
            ctx.dispatcher.send_jobs(jobs).await;
        }
    }
}

/// 回放任务主循环：命令、按 `next_deadline` 的帧调度、30Hz 的 UI 推送三路复用。
async fn run_player(
    mut ctx: TaskCtx,
    mut player: Player<File>,
    mut rx: mpsc::UnboundedReceiver<Cmd>,
    base: PlaybackStatus,
) {
    let t0 = Instant::now();
    let wall = move || t0.elapsed().as_micros() as u64;
    let mut ui = tokio::time::interval(UI_TICK);
    ui.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_state: Option<PlaybackStatus> = None;
    let mut last_state_at = Instant::now();
    let mut sent_channels: HashMap<u16, Vec<u8>> = HashMap::new();

    loop {
        let now = wall();
        let sleep_for = player
            .next_deadline(now)
            .map_or(Duration::from_secs(3600), |d| {
                Duration::from_micros(d.saturating_sub(now))
            });

        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                let now = wall();
                match cmd {
                    Cmd::Play => player.play(now),
                    Cmd::Pause => player.pause(now),
                    Cmd::Stop => { player.stop(); sent_channels.clear(); }
                    Cmd::Seek(pos) => {
                        let ems = player.seek(now, pos);
                        output(&ctx, ems).await;
                    }
                    Cmd::Speed(m) => player.set_speed(now, m),
                    Cmd::Loop(l) => player.set_loop(l),
                    Cmd::Target(t) => ctx.target = t,
                    Cmd::Close => break,
                }
                // 命令生效后立即输出到期内容并刷新状态，界面不必等下一个节拍
                let ems = player.poll(wall());
                output(&ctx, ems).await;
                let st = build_status(&base, &player, wall(), &ctx);
                *lock(&ctx.status) = st.clone();
                ctx.emit_state(&st);
                last_state = Some(st);
                last_state_at = Instant::now();
            }
            () = tokio::time::sleep(sleep_for) => {
                let ems = player.poll(wall());
                output(&ctx, ems).await;
            }
            _ = ui.tick() => {
                let st = build_status(&base, &player, wall(), &ctx);
                *lock(&ctx.status) = st.clone();
                let changed = last_state.as_ref() != Some(&st);
                if changed || last_state_at.elapsed() >= IDLE_STATE_EVERY {
                    ctx.emit_state(&st);
                    last_state_at = Instant::now();
                }
                last_state = Some(st);

                // 被查看 Universe 的当前输出（有变化才推送）
                let viewed = lock(&ctx.viewed).clone();
                if let Some(buffers) = player.buffers() {
                    let ids = player.universe_ids();
                    for u in viewed {
                        let Some(idx) = ids.iter().position(|&x| x == u) else { continue };
                        let data = &buffers[idx];
                        if sent_channels.get(&u) != Some(data) {
                            sent_channels.insert(u, data.clone());
                            (ctx.emit)(
                                "player:channels",
                                serde_json::json!({ "universe": u, "data": data }),
                            );
                        }
                    }
                }
            }
        }
    }

    // 退出回放模式：恢复实时接收，并通知前端。
    // 若期间已有新节目接管（代际号变了），共享状态属于新任务，不能清理。
    if ctx.generation.load(Ordering::SeqCst) == ctx.my_generation {
        ctx.mode_flag.store(false, Ordering::Relaxed);
        let closed = PlaybackStatus::default();
        *lock(&ctx.status) = closed.clone();
        ctx.emit_state(&closed);
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use artnet_net::artnet::{self, ArtNetPacket};
    use artnet_net::socket::DmxSender;
    use artrec_core::{ArtRecWriter, CompressAlgo, UniDesc};
    use forwarding::{
        ForwardDestination, ForwardMode, ForwardProtocol, ForwardingTable, RateLimiter,
    };
    use tokio::net::UdpSocket;

    use super::{
        normalize_target, OpenParams, PlaybackController, PlaybackState, PlaybackStatus,
        ERR_BAD_TARGET, ERR_NO_PLAYER, ERR_RECORDING_ACTIVE,
    };
    use crate::dispatch::{DispatchTarget, Dispatcher};
    use crate::recording::Emitter;

    type EventLog = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    /// 写一个 2 路 Universe（5、6）的节目：0ms / 60ms / 120ms 三帧，总长 200ms。
    fn make_file(dir: &Path) -> PathBuf {
        let unis = vec![
            UniDesc::from_universe(5, 512).unwrap(),
            UniDesc::from_universe(6, 512).unwrap(),
        ];
        let mut w =
            ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 1, 0, 0).unwrap();
        let mut cur = vec![vec![0u8; 512]; 2];
        for (t, u, v) in [(0u64, 0usize, 11u8), (60_000, 1, 22), (120_000, 0, 33)] {
            cur[u][0] = v;
            w.add_full_frame(t, &cur).unwrap();
        }
        let p = dir.join("p.artrec");
        std::fs::write(&p, w.finish(200_000).unwrap().into_inner()).unwrap();
        p
    }

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!(
                "artnet-studio-play-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
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

    /// 指向本机 `port` 的转发目的地。
    fn dest(port: u16) -> ForwardDestination {
        ForwardDestination {
            id: "t".into(),
            name: "t".into(),
            target_ip: "127.0.0.1".into(),
            protocol: ForwardProtocol::ArtNet,
            port,
            mode: ForwardMode::All,
            universe_offset: 0,
            default_delay_ms: 0,
            description: String::new(),
            enabled: true,
            overrides: Vec::new(),
        }
    }

    /// 带真实 UDP 发送器的分发器。
    async fn dispatcher(destinations: Vec<ForwardDestination>) -> Dispatcher {
        Dispatcher::new(
            Arc::new(Mutex::new(ForwardingTable { destinations })),
            Arc::new(Mutex::new(RateLimiter::new())),
            Arc::new(tokio::sync::Mutex::new(Some(
                DmxSender::new([0u8; 16]).await.unwrap(),
            ))),
        )
    }

    fn event_log() -> (Emitter, EventLog) {
        let log: EventLog = Arc::new(Mutex::new(Vec::new()));
        let l2 = log.clone();
        (
            Arc::new(move |name, v| l2.lock().unwrap().push((name.to_string(), v))),
            log,
        )
    }

    fn params(
        emit: Emitter,
        dispatcher: Dispatcher,
        flag: &Arc<AtomicBool>,
        path: PathBuf,
        target: DispatchTarget,
        recording_active: bool,
    ) -> OpenParams {
        OpenParams {
            emit,
            dispatcher,
            mode_flag: flag.clone(),
            started_at: Instant::now(),
            path,
            name: "demo".into(),
            target,
            recording_active,
        }
    }

    async fn wait_status(
        c: &PlaybackController,
        pred: impl Fn(&PlaybackStatus) -> bool,
    ) -> PlaybackStatus {
        for _ in 0..150 {
            let s = c.status();
            if pred(&s) {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("等待状态超时: {:?}", c.status());
    }

    async fn recv_dmx(rx: &UdpSocket) -> (u16, u8) {
        let mut buf = [0u8; 2048];
        loop {
            let (n, _) = tokio::time::timeout(Duration::from_secs(3), rx.recv_from(&mut buf))
                .await
                .expect("应在 3 秒内收到回放包")
                .unwrap();
            if let Some(ArtNetPacket::Dmx {
                port_address, data, ..
            }) = artnet::parse(&buf[..n])
            {
                return (port_address, data[0]);
            }
        }
    }

    #[test]
    fn normalize_target_validates_and_fills_default_port() {
        assert_eq!(
            normalize_target(DispatchTarget::Forwarding).unwrap(),
            DispatchTarget::Forwarding
        );
        let t = normalize_target(DispatchTarget::Direct {
            ip: " 10.0.0.9 ".into(),
            protocol: ForwardProtocol::Sacn,
            port: 0,
        })
        .unwrap();
        assert_eq!(
            t,
            DispatchTarget::Direct {
                ip: "10.0.0.9".into(),
                protocol: ForwardProtocol::Sacn,
                port: 5568
            }
        );
        assert_eq!(
            normalize_target(DispatchTarget::Direct {
                ip: "not-an-ip".into(),
                protocol: ForwardProtocol::ArtNet,
                port: 6454
            })
            .unwrap_err(),
            ERR_BAD_TARGET
        );
    }

    #[test]
    fn commands_without_a_player_report_no_player() {
        let c = PlaybackController::new();
        assert_eq!(c.play().unwrap_err(), ERR_NO_PLAYER);
        assert_eq!(c.seek(1).unwrap_err(), ERR_NO_PLAYER);
        assert!(!c.is_loaded());
        c.close(); // 无节目时关闭是空操作
    }

    #[tokio::test]
    async fn refuses_to_open_while_recording() {
        let tmp = Tmp::new();
        let flag = Arc::new(AtomicBool::new(false));
        let (emit, _) = event_log();
        let err = PlaybackController::new()
            .open(params(
                emit,
                dispatcher(vec![]).await,
                &flag,
                make_file(&tmp.0),
                DispatchTarget::Forwarding,
                true,
            ))
            .unwrap_err();
        assert_eq!(err, ERR_RECORDING_ACTIVE);
        assert!(!flag.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn rejects_unparsable_files_without_entering_playback_mode() {
        let tmp = Tmp::new();
        let bad = tmp.0.join("bad.artrec");
        std::fs::write(&bad, [b'X'; 100]).unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let (emit, _) = event_log();
        let c = PlaybackController::new();
        assert!(c
            .open(params(
                emit,
                dispatcher(vec![]).await,
                &flag,
                bad,
                DispatchTarget::Forwarding,
                false,
            ))
            .is_err());
        assert!(!flag.load(Ordering::Relaxed));
        assert!(!c.is_loaded());
    }

    /// 端到端：打开真实文件 → 播放 → 本机 UDP 套接字按文件时间轴收到 Art-Net 包 →
    /// 停止保持节目打开 → 关闭后回放模式标志复位。
    #[tokio::test]
    async fn plays_a_real_file_over_udp_and_toggles_playback_mode() {
        let tmp = Tmp::new();
        let file = make_file(&tmp.0);
        let rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx.local_addr().unwrap().port();
        let flag = Arc::new(AtomicBool::new(false));
        let (emit, log) = event_log();
        let c = PlaybackController::new();

        let st = c
            .open(params(
                emit,
                dispatcher(vec![dest(port)]).await,
                &flag,
                file,
                DispatchTarget::Forwarding,
                false,
            ))
            .unwrap();
        assert!(st.loaded && flag.load(Ordering::Relaxed), "打开节目后应进入回放模式");
        assert_eq!((st.duration_us, st.universes.clone(), st.destinations), (200_000, vec![5, 6], 1));

        c.play().unwrap();
        let start = Instant::now();
        // 首帧两路 → 60ms 时 U6 变化 → 120ms 时 U5 变化
        let mut got = Vec::new();
        for _ in 0..4 {
            got.push((recv_dmx(&rx).await, start.elapsed()));
        }
        let seq: Vec<(u16, u8)> = got.iter().map(|g| g.0).collect();
        assert_eq!(seq, vec![(5, 11), (6, 0), (6, 22), (5, 33)], "{got:?}");
        assert!(got[2].1 >= Duration::from_millis(40), "U6 的变化不应早于约 60ms: {:?}", got[2].1);
        assert!(got[3].1 > got[2].1);
        assert!(log.lock().unwrap().iter().any(|(n, _)| n == "player:state"));

        c.stop().unwrap();
        let s = wait_status(&c, |s| s.state == PlaybackState::Stopped && s.pos_us == 0).await;
        assert!(s.loaded && flag.load(Ordering::Relaxed), "停止后节目仍保持打开");

        c.close();
        for _ in 0..100 {
            if !flag.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!flag.load(Ordering::Relaxed), "关闭节目后应恢复实时接收");
        assert!(!c.is_loaded());
    }

    /// 重新打开另一个节目时，旧任务的收尾不能清掉新节目的回放模式与状态。
    #[tokio::test]
    async fn reopening_does_not_let_the_old_task_clobber_the_new_state() {
        let tmp = Tmp::new();
        let first = make_file(&tmp.0);
        let second = tmp.0.join("second.artrec");
        std::fs::copy(&first, &second).unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let (emit, _) = event_log();
        let c = PlaybackController::new();
        let d = dispatcher(vec![]).await;

        c.open(params(emit.clone(), d.clone(), &flag, first, DispatchTarget::Forwarding, false))
            .unwrap();
        c.open(params(emit, d, &flag, second.clone(), DispatchTarget::Forwarding, false))
            .unwrap();
        // 给旧任务足够时间处理 Close 并退出
        tokio::time::sleep(Duration::from_millis(150)).await;

        assert!(flag.load(Ordering::Relaxed), "新节目仍应处于回放模式");
        let s = c.status();
        assert!(s.loaded);
        assert_eq!(s.path, second.to_string_lossy());

        c.close();
        for _ in 0..100 {
            if !flag.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!flag.load(Ordering::Relaxed));
    }

    /// seek 立即补发该位置的完整状态；切换到指定 IP 后输出改发到新目标。
    #[tokio::test]
    async fn seek_resends_full_state_and_target_can_be_switched() {
        let tmp = Tmp::new();
        let file = make_file(&tmp.0);
        let via_table = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let direct = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let (emit, _) = event_log();
        let c = PlaybackController::new();
        c.open(params(
            emit,
            dispatcher(vec![dest(via_table.local_addr().unwrap().port())]).await,
            &flag,
            file,
            DispatchTarget::Forwarding,
            false,
        ))
        .unwrap();

        // 暂停态 seek 到 130ms：U5=33、U6=22 两路完整状态都应被发出
        c.pause().unwrap();
        c.seek(130_000).unwrap();
        let mut seen = vec![recv_dmx(&via_table).await, recv_dmx(&via_table).await];
        seen.sort_unstable();
        assert_eq!(seen, vec![(5, 33), (6, 22)]);

        // 切到 Direct：之后的 seek 只会发到新目标
        c.set_target(DispatchTarget::Direct {
            ip: "127.0.0.1".into(),
            protocol: ForwardProtocol::ArtNet,
            port: direct.local_addr().unwrap().port(),
        })
        .unwrap();
        c.seek(10_000).unwrap();
        let mut seen = vec![recv_dmx(&direct).await, recv_dmx(&direct).await];
        seen.sort_unstable();
        assert_eq!(seen, vec![(5, 11), (6, 0)]);
        assert!(matches!(c.status().target, DispatchTarget::Direct { .. }));
        c.close();
    }
}