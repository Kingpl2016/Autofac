//! 回放控制器：在专用线程里驱动 `player::Player`，把输出交给 [`Dispatcher`]，并向前端推送状态与通道数据。
//!
//! 设计要点：
//! - **回放模式**：节目被打开期间置位 `playback_mode`，实时接收循环据此丢弃实时帧
//!   （手册 Player Mode 语义，同时避免回放输出被自己重新摄取）。
//! - **专用线程**：每个节目一个名为 `artrec-player` 的 std 线程，命令经 `std::sync::mpsc` 送达。
//!   Windows 上 tokio 计时器与 `recv_timeout` 都受系统时钟中断粒度（默认约 15.6ms）影响，
//!   44Hz 回放会明显抖动；线程在帧截止前一段时间（Windows 上约 34ms，其它平台 2ms）停止用
//!   `recv_timeout` 等命令，改用 `spin_sleep` 精确睡到截止时刻（高精度原生睡眠 + 末段自旋）。
//! - **时钟**：调度使用单调的墙钟微秒；`Player` 本身不依赖真实时钟，调度逻辑已由 `player` crate 单测覆盖。
//! - **输出**：回放线程不做网络 IO，把输出经有界队列交给打开节目时启动的 tokio 输出任务；
//!   普通到期帧队列满时丢弃并计数（随后补发完整状态），seek / 保活等完整状态保证送达。
//!   回放不经 44Hz 限速（节奏由文件时间轴决定），目标可为转发表或指定 IP。
//! - **通道数据**：被查看 Universe 的当前输出以 [`StreamKind::Playback`](crate::stream::StreamKind::Playback)
//!   帧经二进制通道流（[`DmxStream`]）推送，与实时帧共用同一订阅；节目关闭时发一帧空的全量帧。
//! - **计时统计**：每次到期 `poll` 相对截止时刻的迟到记入固定桶直方图，节目关闭时输出
//!   p50 / p99 / max 日志。

mod channels;
mod output;
mod timing;

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use artrec_core::ArtRecReader;
use player::{PlayState, Player, PlayerConfig, DEFAULT_KEEPALIVE_US};
use serde::{Deserialize, Serialize};
use spin_sleep::SpinSleeper;

use crate::dispatch::{DispatchTarget, Dispatcher};
use crate::mode::RuntimeMode;
use crate::recording::Emitter;
use crate::stream::DmxStream;
use crate::util::lock;

use self::channels::PlaybackChannels;
use self::output::{OutputQueue, OUTPUT_QUEUE};
use self::timing::LatenessHistogram;

/// 向前端推送回放状态 / 通道数据的节拍（约 30Hz）。
const UI_TICK: Duration = Duration::from_millis(33);
/// 非播放状态下，状态事件的最长重发间隔（兜底，保证前端重连后能同步）。
const IDLE_STATE_EVERY: Duration = Duration::from_millis(500);

/// 用 `recv_timeout` 等命令时，至少要在帧截止时刻之前多久醒来；余下的时间交给精确睡眠。
///
/// `recv_timeout` 的超时精度取决于系统时钟中断：Windows 默认粒度约 15.6ms，实测一次超时最多会
/// 晚约两个粒度，所以 Windows 上留 34ms；其它平台的定时器精度在 1ms 以内，留 2ms。
/// 这段时间内到达的命令要等本次截止处理完才执行（至多晚一个余量）。
const RECV_SLACK: Duration = if cfg!(windows) {
    Duration::from_millis(34)
} else {
    Duration::from_millis(2)
};

/// UI 节拍与帧截止相距不足此值时不单独睡到节拍（原生高精度睡眠最多约晚 0.7ms），
/// 而是精确睡到帧截止，帧输出之后再处理节拍。
const TICK_GUARD: Duration = Duration::from_millis(1);

/// 错误码：录制进行中，不能进入回放。
pub const ERR_RECORDING_ACTIVE: &str = "recording_active";
/// 错误码：节目编辑器正在输出灯光，不能打开回放节目。
pub const ERR_SHOW_ACTIVE: &str = "show_active";
/// 错误码：没有已打开的节目。
pub const ERR_NO_PLAYER: &str = "no_player";
/// 错误码：Direct 目标的 IP 非法。
pub const ERR_BAD_TARGET: &str = "bad_target";

/// 重复模式：节目自然播完后的行为。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepeatMode {
    /// 播完即停（停在结尾）。
    #[default]
    Off,
    /// 单个节目循环播放。
    Loop,
    /// 连播：播完后自动打开并播放节目库里的下一个，到列表末尾停止。
    Playlist,
}

impl RepeatMode {
    /// 该模式下回放器自身是否需要循环回绕。
    ///
    /// # Returns
    ///
    /// 仅 [`RepeatMode::Loop`] 为 `true`。
    #[must_use]
    pub fn loops(self) -> bool {
        self == Self::Loop
    }
}

/// 连播要打开的下一个节目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NextProgram {
    /// 节目路径（须已通过录制目录校验）。
    pub path: PathBuf,
    /// 显示名。
    pub name: String,
}

/// 查询"当前节目之后的下一个可播放节目"：参数为当前节目路径，没有下一个时返回 `None`。
///
/// 在回放线程上同步调用（节目播完之后），可以做阻塞 I/O。
pub type NextProgramFn = Arc<dyn Fn(&Path) -> Option<NextProgram> + Send + Sync>;

/// 在节目库里查找 `current` 之后的下一个可播放节目。
///
/// 顺序与节目库列表一致（修改时间从新到旧），因此"下一个"是列表里紧随其后的那一项；
/// 文件头无法解析的条目会被跳过。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `current` - 当前节目路径；只比较文件名，因为节目都位于录制目录的直接子级。
///
/// # Returns
///
/// 下一个有效节目；`current` 不在库里或已是最后一个有效节目时返回 `None`。
#[must_use]
pub fn next_in_library(dir: &Path, current: &Path) -> Option<NextProgram> {
    let name = current.file_name()?;
    let list = recorder::list_library(dir);
    let pos = list
        .iter()
        .position(|e| std::ffi::OsStr::new(&e.file_name) == name)?;
    list[pos + 1..]
        .iter()
        .find(|e| e.valid)
        .map(|e| NextProgram {
            path: PathBuf::from(&e.path),
            name: e.name.clone(),
        })
}

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
    /// 重复模式。
    pub repeat: RepeatMode,
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
/// IP 无法解析或为未指定地址（`0.0.0.0`）时返回 [`ERR_BAD_TARGET`]。
pub fn normalize_target(target: DispatchTarget) -> Result<DispatchTarget, String> {
    match target {
        DispatchTarget::Forwarding => Ok(target),
        DispatchTarget::Routed { .. } => target.normalized().map_err(|_| ERR_BAD_TARGET.to_string()),
        DispatchTarget::Direct { ip, protocol, port } => {
            // 未指定地址（`0.0.0.0`）不能作为发送目标
            if ip.trim().parse::<std::net::IpAddr>().map_or(true, |a| a.is_unspecified()) {
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

/// 发给回放线程的命令。
#[derive(Debug)]
enum Cmd {
    Play,
    Pause,
    Stop,
    Seek(u64),
    Speed(u32),
    Repeat(RepeatMode),
    Target(DispatchTarget),
    Close,
}

struct Inner {
    /// 当前节目的代际号：重新打开节目会递增，旧线程退出时据此判断是否还该清理共享状态。
    generation: Arc<AtomicU64>,
    cmd: Mutex<Option<Sender<Cmd>>>,
    /// 共享状态快照；"代际号判断 + 写状态 + 推送"都在这把锁内完成，新旧节目的发布不会交错。
    status: Arc<Mutex<PlaybackStatus>>,
    viewed: Arc<Mutex<Vec<u16>>>,
    /// 用户选择的重复模式：跨节目保留，新打开的节目沿用它。
    repeat: Mutex<RepeatMode>,
    /// 最近一次打开节目所用的通道流：查看集合变化时据此请求全量帧。
    stream: Mutex<Option<Arc<DmxStream>>>,
    /// 最近一个退出的回放线程的计时统计（测试读取）。
    #[cfg(test)]
    timing: Arc<Mutex<Option<timing::TimingSummary>>>,
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
    /// 二进制 DMX 通道流：被查看 Universe 的回放输出以回放帧推送（与实时帧共用订阅）。
    pub stream: Arc<DmxStream>,
    /// 录制 / 回放互斥仲裁，节目打开期间置位回放、录制进行时拒绝打开。
    pub mode: Arc<RuntimeMode>,
    /// 运行时起点（换算逻辑毫秒）。
    pub started_at: Instant,
    /// 已校验位于录制目录内的 `.artrec` 路径。
    pub path: PathBuf,
    /// 显示名。
    pub name: String,
    /// 输出目标。
    pub target: DispatchTarget,
    /// 连播时用于查找下一个节目；为 `None` 时连播模式播完即视为列表结束。
    pub next: Option<NextProgramFn>,
}

/// 回放线程的上下文（打开节目时确定的参数与共享句柄）。
struct TaskCtx {
    emit: Emitter,
    dispatcher: Dispatcher,
    stream: Arc<DmxStream>,
    status: Arc<Mutex<PlaybackStatus>>,
    viewed: Arc<Mutex<Vec<u16>>>,
    mode: Arc<RuntimeMode>,
    started_at: Instant,
    /// 当前输出目标（随每条输出消息携带，切换时整体替换）。
    target: Arc<DispatchTarget>,
    generation: Arc<AtomicU64>,
    my_generation: u64,
    /// 本节目当前生效的重复模式。
    repeat: RepeatMode,
    next: Option<NextProgramFn>,
    /// 回到控制器（弱引用，避免线程与控制器互相拖住）：连播时据此打开下一个节目。
    controller: Weak<Inner>,
    #[cfg(test)]
    timing: Arc<Mutex<Option<timing::TimingSummary>>>,
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
                repeat: Mutex::new(RepeatMode::Off),
                stream: Mutex::new(None),
                #[cfg(test)]
                timing: Arc::default(),
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
    /// 最近一次由回放线程更新的 [`PlaybackStatus`] 副本；未打开节目时为默认值。
    #[must_use]
    pub fn status(&self) -> PlaybackStatus {
        lock(&self.inner.status).clone()
    }

    /// 设置前端正在查看的 Universe（决定回放通道流推送哪些 Universe）。
    ///
    /// 集合确有变化时要求通道流的下一帧为全量（前端据此整体替换回放通道表）；相同列表不做任何事。
    ///
    /// # Arguments
    ///
    /// * `universes` - 前端正在查看的 Universe 编号列表，会覆盖此前的设置。
    pub fn set_viewed(&self, universes: Vec<u16>) {
        let changed = {
            let mut viewed = lock(&self.inner.viewed);
            let changed = *viewed != universes;
            if changed {
                *viewed = universes;
            }
            changed
        };
        if changed {
            if let Some(stream) = lock(&self.inner.stream).as_ref() {
                stream.request_full();
            }
        }
    }

    fn send(&self, cmd: Cmd) -> Result<(), String> {
        let guard = lock(&self.inner.cmd);
        let tx = guard.as_ref().ok_or_else(|| ERR_NO_PLAYER.to_string())?;
        tx.send(cmd).map_err(|_| ERR_NO_PLAYER.to_string())
    }

    /// 打开节目并进入回放模式（已有节目则先关闭）。
    ///
    /// 启动该节目的回放线程（`artrec-player`）与输出任务；可在 tokio 运行时之外调用
    /// （输出任务交给 Tauri 的全局异步运行时）。
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
    /// - [`ERR_SHOW_ACTIVE`]：节目编辑器正在输出灯光。
    /// - [`ERR_BAD_TARGET`]：目标 IP 非法。
    /// - 文件无法解析时返回描述；此时已打开的节目不受影响。
    /// - 回放线程无法创建时返回描述；此时已退出回放模式。
    pub fn open(&self, params: OpenParams) -> Result<PlaybackStatus, String> {
        let OpenParams {
            emit,
            dispatcher,
            stream,
            mode,
            started_at,
            path,
            name,
            target,
            next,
        } = params;
        if mode.is_recording() {
            return Err(ERR_RECORDING_ACTIVE.to_string());
        }
        if mode.is_show() {
            return Err(ERR_SHOW_ACTIVE.to_string());
        }
        let target = Arc::new(normalize_target(target)?);
        let reader = ArtRecReader::open_file(&path).map_err(|e| e.to_string())?;
        // 用户显式选择的模式优先；仍为"关闭"时，文件头自带的循环标志代表作者意图
        let stored = *lock(&self.inner.repeat);
        let repeat = if stored == RepeatMode::Off && reader.header().loop_play() {
            RepeatMode::Loop
        } else {
            stored
        };
        let player = Player::new(
            reader,
            PlayerConfig {
                keepalive_us: DEFAULT_KEEPALIVE_US,
                looping: repeat.loops(),
                ..PlayerConfig::default()
            },
        );
        let mut status = PlaybackStatus {
            loaded: true,
            path: path.to_string_lossy().into_owned(),
            name,
            // Universe 表在节目内不变：打开时取一次，之后每个节拍复用
            universes: player.universe_ids(),
            ..PlaybackStatus::default()
        };
        fill_status(
            &mut status,
            &player,
            0,
            repeat,
            &target,
            dispatcher.enabled_destinations(),
        );

        let (tx, rx) = mpsc::channel::<Cmd>();
        let (out, out_rx) = output::queue(OUTPUT_QUEUE);
        *lock(&self.inner.stream) = Some(stream.clone());

        // 在状态锁内完成"递增代际号 → 关闭旧节目 → 置位回放模式 → 发布初始状态"：
        // 旧线程收尾时也在这把锁内判断代际号，因此不会清掉新节目的回放模式与状态。
        let my_generation = {
            let mut shared = lock(&self.inner.status);
            let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(old) = lock(&self.inner.cmd).replace(tx) {
                let _ = old.send(Cmd::Close);
            }
            mode.set_playback(true);
            shared.clone_from(&status);
            emit_state(&emit, &status);
            generation
        };

        let ctx = TaskCtx {
            emit: emit.clone(),
            dispatcher: dispatcher.clone(),
            stream,
            status: self.inner.status.clone(),
            viewed: self.inner.viewed.clone(),
            mode: mode.clone(),
            started_at,
            target,
            generation: self.inner.generation.clone(),
            my_generation,
            repeat,
            next,
            controller: Arc::downgrade(&self.inner),
            #[cfg(test)]
            timing: self.inner.timing.clone(),
        };
        let initial = status.clone();
        let worker = PlayerThread::new(ctx, player, rx, out, status);
        let spawned = std::thread::Builder::new()
            .name("artrec-player".into())
            .spawn(move || worker.run());
        if let Err(e) = spawned {
            // 线程没起来：撤销本次打开（仍是当前节目时才清理共享状态）
            let mut shared = lock(&self.inner.status);
            if self.inner.generation.load(Ordering::SeqCst) == my_generation {
                lock(&self.inner.cmd).take();
                mode.set_playback(false);
                *shared = PlaybackStatus::default();
                emit_state(&emit, &shared);
            }
            return Err(format!("无法启动回放线程: {e}"));
        }
        tauri::async_runtime::spawn(output::run_output(dispatcher, started_at, out_rx));
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

    /// 设置重复模式。
    ///
    /// 模式会被记住并沿用到之后打开的节目；已有节目时立即生效。没有节目时只记录，不报错。
    ///
    /// # Arguments
    ///
    /// * `mode` - 新的重复模式。
    pub fn set_repeat(&self, mode: RepeatMode) {
        *lock(&self.inner.repeat) = mode;
        // 没有节目时 `send` 返回 ERR_NO_PLAYER：此时只需记录，下次打开节目时生效
        let _ = self.send(Cmd::Repeat(mode));
    }

    /// 当前记住的重复模式。
    ///
    /// # Returns
    ///
    /// 用户最近一次通过 [`PlaybackController::set_repeat`] 设置的模式；从未设置时为 [`RepeatMode::Off`]。
    #[must_use]
    pub fn repeat(&self) -> RepeatMode {
        *lock(&self.inner.repeat)
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

    /// 关闭节目（卸载输出）。没有节目时什么也不做。
    ///
    /// 只卸载节目、清除"已打开节目"标志；**不会**退出播放器模式，
    /// 退出播放器模式、恢复实时接收由应用模式切换负责。
    pub fn close(&self) {
        if let Some(tx) = lock(&self.inner.cmd).take() {
            let _ = tx.send(Cmd::Close);
        }
    }
}

/// 推送 `player:state` 事件。
fn emit_state(emit: &Emitter, status: &PlaybackStatus) {
    emit(
        "player:state",
        serde_json::to_value(status).unwrap_or(serde_json::Value::Null),
    );
}

/// 赋值并报告是否有变化。
fn set<T: PartialEq>(slot: &mut T, value: T) -> bool {
    if *slot == value {
        false
    } else {
        *slot = value;
        true
    }
}

/// 用回放器当前情况原地更新状态的动态字段（路径、名称、Universe 表等不变部分保持原样）。
///
/// 只有字段确有变化才写入，稳态下不分配。
///
/// # Arguments
///
/// * `st` - 待更新的状态。
/// * `player` - 回放器。
/// * `now` - 当前墙钟（微秒，与传给 `player` 的时钟一致）。
/// * `repeat` - 当前重复模式。
/// * `target` - 当前输出目标。
/// * `destinations` - 启用的转发目的地数量。
///
/// # Returns
///
/// 是否有任何字段发生变化。
fn fill_status(
    st: &mut PlaybackStatus,
    player: &Player<File>,
    now: u64,
    repeat: RepeatMode,
    target: &DispatchTarget,
    destinations: usize,
) -> bool {
    let s = player.status(now);
    let mut changed = false;
    changed |= set(&mut st.state, s.state.into());
    changed |= set(&mut st.pos_us, s.pos_us);
    changed |= set(&mut st.duration_us, s.duration_us);
    changed |= set(&mut st.speed_milli, s.speed_milli);
    changed |= set(&mut st.repeat, repeat);
    changed |= set(&mut st.frames, s.frames as u64);
    changed |= set(&mut st.corrupt_frames, s.corrupt_frames);
    changed |= set(&mut st.destinations, destinations);
    if st.target != *target {
        st.target = target.clone();
        changed = true;
    }
    changed
}

impl TaskCtx {
    /// 本线程是否仍是当前节目的线程（重新打开节目后旧线程不再拥有共享状态）。
    fn is_current(&self) -> bool {
        self.generation.load(Ordering::SeqCst) == self.my_generation
    }

    /// 发布状态：在状态锁内确认仍是当前线程才写共享状态并推送，避免旧线程的陈旧状态覆盖新节目。
    fn publish(&self, status: &PlaybackStatus) {
        let mut shared = lock(&self.status);
        if self.is_current() {
            shared.clone_from(status);
            emit_state(&self.emit, status);
        }
    }
}

/// 节目自然播完后的处理：连播模式下打开并播放下一个，其余模式什么也不做。
///
/// 在回放线程上同步执行（查找下一个节目需要列目录、读 sidecar）。打开下一个节目会递增代际号并
/// 向本线程发 `Close`，本线程随后不再发布任何状态、不再输出，处理完 `Close` 即退出。
/// 结果通过 `player:playlist` 事件通知前端（`advanced` / `listFinished` / `advanceFailed`）。
fn on_program_end(ctx: &TaskCtx, current: &str) {
    if ctx.repeat != RepeatMode::Playlist || !ctx.is_current() {
        return;
    }
    let emit = |payload: serde_json::Value| (ctx.emit)("player:playlist", payload);
    let Some(next_fn) = ctx.next.as_ref() else {
        emit(serde_json::json!({ "kind": "listFinished" }));
        return;
    };
    let Some(next) = next_fn(Path::new(current)) else {
        emit(serde_json::json!({ "kind": "listFinished" }));
        return;
    };
    let Some(inner) = ctx.controller.upgrade() else {
        return;
    };
    let controller = PlaybackController { inner };
    let name = next.name.clone();
    let result = controller.open(OpenParams {
        emit: ctx.emit.clone(),
        dispatcher: ctx.dispatcher.clone(),
        stream: ctx.stream.clone(),
        mode: ctx.mode.clone(),
        started_at: ctx.started_at,
        path: next.path,
        name: next.name,
        target: (*ctx.target).clone(),
        next: ctx.next.clone(),
    });
    match result {
        Ok(_) => {
            let _ = controller.play();
            emit(serde_json::json!({ "kind": "advanced", "name": name }));
        }
        // 下一个文件缺失或损坏：保持当前节目停在结尾，由前端提示
        Err(reason) => emit(serde_json::json!({
            "kind": "advanceFailed",
            "name": name,
            "reason": reason,
        })),
    }
}

/// 回放线程：命令、按帧截止时刻的精确调度、约 30Hz 的状态 / 通道流推送。
struct PlayerThread {
    ctx: TaskCtx,
    player: Player<File>,
    rx: Receiver<Cmd>,
    out: OutputQueue,
    /// 当前对外状态：不变部分打开时填好，动态字段每次原地更新。
    status: PlaybackStatus,
    /// 墙钟起点：传给 `Player` 的时刻都是相对它的微秒数。
    t0: Instant,
    /// 下一个 UI 节拍。
    next_ui: Instant,
    /// 上次推送状态事件的时刻。
    last_state_at: Instant,
    channels: PlaybackChannels,
    /// 查看集合的本地副本（复用缓冲）。
    viewed: Vec<u16>,
    lateness: LatenessHistogram,
}

impl PlayerThread {
    fn new(
        ctx: TaskCtx,
        player: Player<File>,
        rx: Receiver<Cmd>,
        out: OutputQueue,
        status: PlaybackStatus,
    ) -> Self {
        let now = Instant::now();
        Self {
            ctx,
            player,
            rx,
            out,
            status,
            t0: now,
            next_ui: now + UI_TICK,
            last_state_at: now,
            channels: PlaybackChannels::new(),
            viewed: Vec::new(),
            lateness: LatenessHistogram::new(),
        }
    }

    /// 时刻 `at` 对应的墙钟微秒。
    fn wall(&self, at: Instant) -> u64 {
        at.saturating_duration_since(self.t0).as_micros() as u64
    }

    /// 墙钟微秒 `us` 对应的时刻；超出 `Instant` 可表示范围时为 `None`（视为没有截止）。
    fn instant_of(&self, us: u64) -> Option<Instant> {
        self.t0.checked_add(Duration::from_micros(us))
    }

    /// 主循环：每轮先处理到期的帧与 UI 节拍，再等待命令或下一个截止时刻。
    ///
    /// 离帧截止还远时用 `recv_timeout` 等命令（收到即处理）；进入截止前 [`RECV_SLACK`] 之内后
    /// 只非阻塞地取命令，然后用 `spin_sleep` 精确睡到截止时刻再 `poll`。
    fn run(mut self) {
        // 在回放线程上创建：Windows 上它探测的是本线程的高精度可等待计时器
        let sleeper = SpinSleeper::default();
        loop {
            let now = Instant::now();
            // 传 0 取未钳制的截止时刻：落后时据此统计真实的迟到
            let due = self
                .player
                .next_deadline(0)
                .and_then(|us| self.instant_of(us));
            if let Some(at) = due.filter(|&at| at <= now) {
                self.lateness.record(now.saturating_duration_since(at));
                self.poll_output(now);
                continue;
            }
            if self.next_ui <= now {
                self.ui_tick(now);
                self.next_ui += UI_TICK;
                if self.next_ui <= now {
                    // 处理不过来时跳过错过的节拍，而不是连发补齐
                    self.next_ui = now + UI_TICK;
                }
                continue;
            }

            let coarse_until = due.map_or(self.next_ui, |at| {
                self.next_ui.min(at.checked_sub(RECV_SLACK).unwrap_or(now))
            });
            let cmd = if coarse_until > now {
                match self.rx.recv_timeout(coarse_until - now) {
                    Ok(cmd) => cmd,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match self.rx.try_recv() {
                    Ok(cmd) => cmd,
                    Err(TryRecvError::Empty) => {
                        self.precise_wait(sleeper, due, now);
                        continue;
                    }
                    Err(TryRecvError::Disconnected) => break,
                }
            };
            if !self.handle(cmd) {
                break;
            }
        }
        self.finish();
    }

    /// 截止前的精确等待：UI 节拍明显更早时只用原生高精度睡眠睡到节拍（节拍不需要自旋的精度），
    /// 否则精确睡到帧截止。
    fn precise_wait(&self, sleeper: SpinSleeper, due: Option<Instant>, now: Instant) {
        match due {
            Some(at) if self.next_ui + TICK_GUARD >= at => sleeper.sleep_until(at),
            _ => spin_sleep::native_sleep(self.next_ui.saturating_duration_since(now)),
        }
    }

    /// 推进到 `now` 并输出到期内容；自然播完时处理连播。
    fn poll_output(&mut self, now: Instant) {
        let emissions = self.player.poll(self.wall(now));
        let player = &self.player;
        self.out
            .submit(&self.ctx.target, emissions, || player.full_state());
        if self.player.take_ended() {
            on_program_end(&self.ctx, &self.status.path);
        }
    }

    /// 处理一条命令。
    ///
    /// # Returns
    ///
    /// 收到 `Close` 时为 `false`（线程应退出），否则为 `true`。
    fn handle(&mut self, cmd: Cmd) -> bool {
        let now = Instant::now();
        let wall = self.wall(now);
        match cmd {
            Cmd::Play => self.player.play(wall),
            Cmd::Pause => self.player.pause(wall),
            Cmd::Stop => self.player.stop(),
            Cmd::Seek(pos) => {
                let emissions = self.player.seek(wall, pos);
                let player = &self.player;
                self.out
                    .submit(&self.ctx.target, emissions, || player.full_state());
            }
            Cmd::Speed(m) => self.player.set_speed(wall, m),
            Cmd::Repeat(m) => {
                self.ctx.repeat = m;
                self.player.set_loop(m.loops());
            }
            Cmd::Target(t) => self.ctx.target = Arc::new(t),
            Cmd::Close => return false,
        }
        // 命令生效后立即输出到期内容并刷新状态，界面不必等下一个节拍
        let now = Instant::now();
        self.poll_output(now);
        self.refresh_status(now);
        self.ctx.publish(&self.status);
        self.last_state_at = now;
        true
    }

    /// 刷新对外状态。
    ///
    /// # Returns
    ///
    /// 是否有字段发生变化。
    fn refresh_status(&mut self, now: Instant) -> bool {
        let wall = self.wall(now);
        fill_status(
            &mut self.status,
            &self.player,
            wall,
            self.ctx.repeat,
            &self.ctx.target,
            self.ctx.dispatcher.enabled_destinations(),
        )
    }

    /// UI 节拍：状态有变化才推送（另有空闲心跳），并推送被查看 Universe 的回放通道帧。
    fn ui_tick(&mut self, now: Instant) {
        let changed = self.refresh_status(now);
        if !self.ctx.is_current() {
            return;
        }
        if changed || now.saturating_duration_since(self.last_state_at) >= IDLE_STATE_EVERY {
            self.ctx.publish(&self.status);
            self.last_state_at = now;
        }
        let stream = &self.ctx.stream;
        if !stream.has_subscriber() {
            return;
        }
        self.viewed.clone_from(&lock(&self.ctx.viewed));
        let frame = self.channels.encode(
            &self.viewed,
            &self.status.universes,
            self.player.buffers(),
            stream.epoch(),
            now,
        );
        if let Some(frame) = frame {
            stream.send(frame);
        }
    }

    /// 线程收尾：输出计时统计；仍是当前节目时退出回放模式、推送关闭状态并清空前端回放通道表。
    fn finish(self) {
        let timing = self.lateness.summary();
        if timing.samples > 0 {
            tracing::info!(
                program = %self.status.name,
                samples = timing.samples,
                p50_us = timing.p50_us,
                p99_us = timing.p99_us,
                max_us = timing.max_us,
                dropped = self.out.dropped(),
                "回放计时统计（到期 poll 相对截止时刻的迟到）"
            );
        }
        #[cfg(test)]
        {
            *lock(&self.ctx.timing) = Some(timing);
        }
        // 若期间已有新节目接管（代际号变了），共享状态属于新线程，不能清理
        let ctx = &self.ctx;
        let mut shared = lock(&ctx.status);
        if ctx.is_current() {
            ctx.mode.set_playback(false);
            *shared = PlaybackStatus::default();
            emit_state(&ctx.emit, &shared);
            ctx.stream.send(PlaybackChannels::empty_full_frame());
        }
        // 返回后 `self.out` 被丢弃：输出队列关闭，输出任务取空后结束
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use arc_swap::ArcSwapOption;
    use artnet_net::artnet::{self, ArtNetPacket};
    use artnet_net::socket::DmxSender;
    use artrec_core::{ArtRecWriter, CompressAlgo, UniDesc};
    use forwarding::{ForwardDestination, ForwardMode, ForwardProtocol, ForwardingTable};
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tokio::net::UdpSocket;

    use super::{
        next_in_library, normalize_target, NextProgram, OpenParams, PlaybackController,
        PlaybackState, PlaybackStatus, RepeatMode, ERR_BAD_TARGET, ERR_NO_PLAYER,
        ERR_RECORDING_ACTIVE,
    };
    use crate::dispatch::{DispatchTarget, Dispatcher};
    use crate::mode::RuntimeMode;
    use crate::recording::Emitter;
    use crate::sender::SenderSlot;
    use crate::stream::{DmxStream, FLAG_FULL, HEADER_LEN};

    type EventLog = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    /// 写一个 2 路 Universe（5、6）的节目：0ms / 60ms / 120ms 三帧，总长 200ms。
    fn make_file(dir: &Path) -> PathBuf {
        make_file_named(dir, "p.artrec")
    }

    /// 与 [`make_file`] 相同，但可指定文件名（连播测试需要多个节目）。
    fn make_file_named(dir: &Path, file_name: &str) -> PathBuf {
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
        let p = dir.join(file_name);
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
        let sender: SenderSlot = Arc::new(ArcSwapOption::new(Some(Arc::new(
            DmxSender::new([0u8; 16]).await.unwrap(),
        ))));
        Dispatcher::with_table(ForwardingTable { destinations }, sender)
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
        mode: &Arc<RuntimeMode>,
        path: PathBuf,
        target: DispatchTarget,
    ) -> OpenParams {
        OpenParams {
            emit,
            dispatcher,
            stream: Arc::new(DmxStream::new()),
            mode: mode.clone(),
            started_at: Instant::now(),
            path,
            name: "demo".into(),
            target,
            next: None,
        }
    }

    /// 等待某个 `player:playlist` 事件（按 `kind`），返回其载荷。
    async fn wait_playlist_event(log: &EventLog, kind: &str) -> serde_json::Value {
        for _ in 0..200 {
            let hit = log
                .lock()
                .unwrap()
                .iter()
                .find(|(n, v)| n == "player:playlist" && v["kind"] == kind)
                .map(|(_, v)| v.clone());
            if let Some(v) = hit {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!(
            "等待 player:playlist/{kind} 超时: {:?}",
            log.lock().unwrap()
        );
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

    /// 解析后的通道流帧：（类别, 标志位, `[(Universe, 首字节或 None)]`）。
    type Frame = (u8, u8, Vec<(u16, Option<u8>)>);

    /// 测试用通道流帧解码（只取每条的首字节，帧格式见 `crate::stream`）。
    fn parse_frame(buf: &[u8]) -> Frame {
        let count = u16::from_le_bytes([buf[4], buf[5]]);
        let mut at = HEADER_LEN;
        let mut entries = Vec::new();
        for _ in 0..count {
            let universe = u16::from_le_bytes([buf[at], buf[at + 1]]);
            let len = usize::from(u16::from_le_bytes([buf[at + 2], buf[at + 3]]));
            at += 4;
            entries.push((universe, buf[at..at + len].first().copied()));
            at += len;
        }
        assert_eq!(at, buf.len());
        (buf[2], buf[3], entries)
    }

    /// 订阅 `stream`，收到的帧（已解码）记进返回的列表。
    fn record_stream(stream: &DmxStream) -> Arc<Mutex<Vec<Frame>>> {
        let frames: Arc<Mutex<Vec<Frame>>> = Arc::default();
        let sink = frames.clone();
        stream.subscribe(Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().push(parse_frame(&bytes));
            }
            Ok(())
        }));
        frames
    }

    /// 等待满足条件的通道流帧。
    async fn wait_frame(frames: &Mutex<Vec<Frame>>, pred: impl Fn(&Frame) -> bool) -> Frame {
        for _ in 0..150 {
            if let Some(f) = frames.lock().unwrap().iter().find(|f| pred(f)) {
                return f.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("等待通道流帧超时: {:?}", frames.lock().unwrap());
    }

    /// 等待节目关闭（回放线程退出并清理完共享状态）。
    async fn wait_closed(c: &PlaybackController, mode: &RuntimeMode) {
        for _ in 0..150 {
            if !mode.is_playback() && !c.is_loaded() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("等待节目关闭超时: {:?}", c.status());
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
        // 未指定地址（0.0.0.0）不能作为发送目标
        assert_eq!(
            normalize_target(DispatchTarget::Direct {
                ip: " 0.0.0.0 ".into(),
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
        c.set_viewed(vec![1]); // 无节目时设置查看集合也不报错
    }

    #[test]
    fn repeat_mode_is_remembered_without_a_player() {
        let c = PlaybackController::new();
        assert_eq!(c.repeat(), RepeatMode::Off);
        c.set_repeat(RepeatMode::Playlist); // 没有节目时不报错，只记录
        assert_eq!(c.repeat(), RepeatMode::Playlist);
    }

    #[tokio::test]
    async fn remembered_repeat_mode_applies_to_the_next_opened_program() {
        let tmp = Tmp::new();
        let mode = Arc::new(RuntimeMode::new());
        let (emit, _) = event_log();
        let c = PlaybackController::new();
        c.set_repeat(RepeatMode::Loop);
        let st = c
            .open(params(
                emit,
                dispatcher(vec![]).await,
                &mode,
                make_file(&tmp.0),
                DispatchTarget::Forwarding,
            ))
            .unwrap();
        assert_eq!(st.repeat, RepeatMode::Loop);
        // 已打开时切换立即反映到状态
        c.set_repeat(RepeatMode::Off);
        let s = wait_status(&c, |s| s.repeat == RepeatMode::Off).await;
        assert!(s.loaded);
        c.close();
    }

    /// 连播：播完第一个后自动打开并播放第二个；第二个播完（列表末尾）后停止并报告列表结束。
    #[tokio::test]
    async fn playlist_advances_then_stops_at_end_of_list() {
        let tmp = Tmp::new();
        let first = make_file_named(&tmp.0, "a.artrec");
        let second = make_file_named(&tmp.0, "b.artrec");
        let mode = Arc::new(RuntimeMode::new());
        let (emit, log) = event_log();
        let c = PlaybackController::new();
        c.set_repeat(RepeatMode::Playlist);

        let second_path = second.clone();
        let first_name = first.file_name().unwrap().to_owned();
        let mut p = params(
            emit,
            dispatcher(vec![]).await,
            &mode,
            first,
            DispatchTarget::Forwarding,
        );
        // 查找下一个节目在回放线程上同步执行
        let on_player_thread = Arc::new(AtomicBool::new(false));
        let seen = on_player_thread.clone();
        p.next = Some(Arc::new(move |cur: &Path| {
            if std::thread::current().name() == Some("artrec-player") {
                seen.store(true, Ordering::SeqCst);
            }
            (cur.file_name() == Some(first_name.as_os_str())).then(|| NextProgram {
                path: second_path.clone(),
                name: "second".into(),
            })
        }));
        c.open(p).unwrap();
        c.play().unwrap();

        let advanced = wait_playlist_event(&log, "advanced").await;
        assert_eq!(advanced["name"], "second");
        assert!(
            on_player_thread.load(Ordering::SeqCst),
            "应在回放线程上查找下一个节目"
        );
        let s = wait_status(&c, |s| {
            s.path == second.to_string_lossy() && s.state == PlaybackState::Playing
        })
        .await;
        assert_eq!(s.repeat, RepeatMode::Playlist, "连播模式应沿用到下一个节目");
        assert!(mode.is_playback(), "切换节目过程中始终处于回放模式");

        wait_playlist_event(&log, "listFinished").await;
        let end = wait_status(&c, |s| {
            s.state == PlaybackState::Stopped && s.pos_us == s.duration_us
        })
        .await;
        assert!(
            end.loaded && end.path == second.to_string_lossy(),
            "列表末尾应停在最后一个节目的结尾"
        );
        // 第一个节目的线程退出时没有清掉第二个节目的状态（任何时候都没有推送过关闭状态）
        assert!(
            log.lock()
                .unwrap()
                .iter()
                .all(|(n, v)| n != "player:state" || v["loaded"] == true),
            "连播切换期间不应出现关闭状态"
        );
        c.close();
        wait_closed(&c, &mode).await;
    }

    #[tokio::test]
    async fn playlist_reports_failure_and_keeps_current_program_when_next_is_broken() {
        let tmp = Tmp::new();
        let a = make_file_named(&tmp.0, "a.artrec");
        let bad = tmp.0.join("bad.artrec");
        std::fs::write(&bad, [b'X'; 100]).unwrap();
        let mode = Arc::new(RuntimeMode::new());
        let (emit, log) = event_log();
        let c = PlaybackController::new();
        c.set_repeat(RepeatMode::Playlist);

        let mut p = params(
            emit,
            dispatcher(vec![]).await,
            &mode,
            a.clone(),
            DispatchTarget::Forwarding,
        );
        p.next = Some(Arc::new(move |_| {
            Some(NextProgram {
                path: bad.clone(),
                name: "broken".into(),
            })
        }));
        c.open(p).unwrap();
        c.play().unwrap();

        let failed = wait_playlist_event(&log, "advanceFailed").await;
        assert_eq!(failed["name"], "broken");
        let s = wait_status(&c, |s| {
            s.state == PlaybackState::Stopped && s.pos_us == s.duration_us
        })
        .await;
        assert_eq!(
            s.path,
            a.to_string_lossy(),
            "下一个损坏时应停在当前节目的结尾"
        );
        assert!(mode.is_playback());
        c.close();
    }

    #[tokio::test]
    async fn off_mode_stops_at_end_without_playlist_events() {
        let tmp = Tmp::new();
        let mode = Arc::new(RuntimeMode::new());
        let (emit, log) = event_log();
        let c = PlaybackController::new();
        let mut p = params(
            emit,
            dispatcher(vec![]).await,
            &mode,
            make_file(&tmp.0),
            DispatchTarget::Forwarding,
        );
        p.next = Some(Arc::new(|_| panic!("关闭模式不应查找下一个节目")));
        c.open(p).unwrap();
        c.play().unwrap();
        wait_status(&c, |s| {
            s.state == PlaybackState::Stopped && s.pos_us == s.duration_us
        })
        .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(log
            .lock()
            .unwrap()
            .iter()
            .all(|(n, _)| n != "player:playlist"));
        c.close();
    }

    #[test]
    fn next_in_library_follows_list_order_and_skips_invalid() {
        let tmp = Tmp::new();
        let newest = make_file_named(&tmp.0, "newest.artrec");
        let middle = make_file_named(&tmp.0, "middle.artrec");
        let broken = tmp.0.join("broken.artrec");
        std::fs::write(&broken, [b'X'; 100]).unwrap();
        let oldest = make_file_named(&tmp.0, "oldest.artrec");
        // 显式设置修改时间，避免同一毫秒内创建导致顺序不确定：新 → 旧
        let base = std::time::SystemTime::now();
        for (f, secs) in [(&newest, 0u64), (&middle, 10), (&broken, 20), (&oldest, 30)] {
            let file = std::fs::File::options().write(true).open(f).unwrap();
            file.set_modified(base - Duration::from_secs(secs)).unwrap();
        }

        let n1 = next_in_library(&tmp.0, &newest).unwrap();
        assert!(n1.path.ends_with("middle.artrec"));
        let n2 = next_in_library(&tmp.0, &middle).unwrap();
        assert!(n2.path.ends_with("oldest.artrec"), "应跳过损坏文件: {n2:?}");
        assert!(
            next_in_library(&tmp.0, &oldest).is_none(),
            "最后一个之后没有下一个"
        );
        assert!(next_in_library(&tmp.0, &tmp.0.join("nope.artrec")).is_none());
    }

    #[tokio::test]
    async fn refuses_to_open_while_recording() {
        let tmp = Tmp::new();
        let mode = Arc::new(RuntimeMode::new());
        mode.set_recording(true); // 模拟录制进行中
        let (emit, _) = event_log();
        let err = PlaybackController::new()
            .open(params(
                emit,
                dispatcher(vec![]).await,
                &mode,
                make_file(&tmp.0),
                DispatchTarget::Forwarding,
            ))
            .unwrap_err();
        assert_eq!(err, ERR_RECORDING_ACTIVE);
        assert!(!mode.is_playback());
    }

    #[tokio::test]
    async fn rejects_unparsable_files_without_entering_playback_mode() {
        let tmp = Tmp::new();
        let bad = tmp.0.join("bad.artrec");
        std::fs::write(&bad, [b'X'; 100]).unwrap();
        let mode = Arc::new(RuntimeMode::new());
        let (emit, _) = event_log();
        let c = PlaybackController::new();
        assert!(c
            .open(params(
                emit,
                dispatcher(vec![]).await,
                &mode,
                bad,
                DispatchTarget::Forwarding,
            ))
            .is_err());
        assert!(!mode.is_playback());
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
        let mode = Arc::new(RuntimeMode::new());
        let (emit, log) = event_log();
        let c = PlaybackController::new();

        let st = c
            .open(params(
                emit,
                dispatcher(vec![dest(port)]).await,
                &mode,
                file,
                DispatchTarget::Forwarding,
            ))
            .unwrap();
        assert!(st.loaded && mode.is_playback(), "打开节目后应进入回放模式");
        assert_eq!(
            (st.duration_us, st.universes.clone(), st.destinations),
            (200_000, vec![5, 6], 1)
        );

        c.play().unwrap();
        let start = Instant::now();
        // 首帧两路 → 60ms 时 U6 变化 → 120ms 时 U5 变化
        let mut got = Vec::new();
        for _ in 0..4 {
            got.push((recv_dmx(&rx).await, start.elapsed()));
        }
        let seq: Vec<(u16, u8)> = got.iter().map(|g| g.0).collect();
        assert_eq!(seq, vec![(5, 11), (6, 0), (6, 22), (5, 33)], "{got:?}");
        assert!(
            got[2].1 >= Duration::from_millis(40),
            "U6 的变化不应早于约 60ms: {:?}",
            got[2].1
        );
        assert!(got[3].1 > got[2].1);
        assert!(log.lock().unwrap().iter().any(|(n, _)| n == "player:state"));

        c.stop().unwrap();
        let s = wait_status(&c, |s| s.state == PlaybackState::Stopped && s.pos_us == 0).await;
        assert!(s.loaded && mode.is_playback(), "停止后节目仍保持打开");

        c.close();
        wait_closed(&c, &mode).await;
    }

    /// 重新打开另一个节目时，旧线程的收尾不能清掉新节目的回放模式与状态。
    #[tokio::test]
    async fn reopening_does_not_let_the_old_task_clobber_the_new_state() {
        let tmp = Tmp::new();
        let first = make_file(&tmp.0);
        let second = tmp.0.join("second.artrec");
        std::fs::copy(&first, &second).unwrap();
        let mode = Arc::new(RuntimeMode::new());
        let (emit, _) = event_log();
        let c = PlaybackController::new();
        let d = dispatcher(vec![]).await;

        c.open(params(
            emit.clone(),
            d.clone(),
            &mode,
            first,
            DispatchTarget::Forwarding,
        ))
        .unwrap();
        c.open(params(
            emit,
            d,
            &mode,
            second.clone(),
            DispatchTarget::Forwarding,
        ))
        .unwrap();
        // 给旧线程足够时间处理 Close 并退出
        tokio::time::sleep(Duration::from_millis(150)).await;

        assert!(mode.is_playback(), "新节目仍应处于回放模式");
        let s = c.status();
        assert!(s.loaded);
        assert_eq!(s.path, second.to_string_lossy());

        c.close();
        wait_closed(&c, &mode).await;
    }

    /// seek 立即补发该位置的完整状态；切换到指定 IP 后输出改发到新目标。
    #[tokio::test]
    async fn seek_resends_full_state_and_target_can_be_switched() {
        let tmp = Tmp::new();
        let file = make_file(&tmp.0);
        let via_table = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let direct = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mode = Arc::new(RuntimeMode::new());
        let (emit, _) = event_log();
        let c = PlaybackController::new();
        c.open(params(
            emit,
            dispatcher(vec![dest(via_table.local_addr().unwrap().port())]).await,
            &mode,
            file,
            DispatchTarget::Forwarding,
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

    /// 被查看 Universe 的回放输出走二进制通道流（回放帧），不再有 `player:channels` 事件；
    /// 查看集合变化请求全量帧；关闭节目时发空的回放全量帧。
    #[tokio::test]
    async fn viewed_universes_stream_as_playback_frames_and_close_clears_them() {
        let tmp = Tmp::new();
        let mode = Arc::new(RuntimeMode::new());
        let (emit, log) = event_log();
        let stream = Arc::new(DmxStream::new());
        let frames = record_stream(&stream);
        let c = PlaybackController::new();
        c.set_viewed(vec![6, 9]);
        let mut p = params(
            emit,
            dispatcher(vec![]).await,
            &mode,
            make_file(&tmp.0),
            DispatchTarget::Forwarding,
        );
        p.stream = stream.clone();
        c.open(p).unwrap();

        // 尚未输出：全量帧为空（不在节目里的 Universe 9 始终被忽略）
        wait_frame(&frames, |f| *f == (2, FLAG_FULL, vec![])).await;
        // 暂停态 seek 到 130ms：U6 = 22
        c.pause().unwrap();
        c.seek(130_000).unwrap();
        wait_frame(&frames, |f| f.0 == 2 && f.2 == vec![(6, Some(22))]).await;

        // 查看集合变化：请求全量（代次改变），下一帧是含新集合的全量帧
        let epoch = stream.epoch();
        c.set_viewed(vec![5, 6]);
        assert_ne!(stream.epoch(), epoch);
        c.set_viewed(vec![5, 6]);
        let e2 = stream.epoch();
        c.set_viewed(vec![5, 6]);
        assert_eq!(stream.epoch(), e2, "相同集合不应请求全量");
        wait_frame(&frames, |f| {
            *f == (2, FLAG_FULL, vec![(5, Some(33)), (6, Some(22))])
        })
        .await;

        c.close();
        wait_closed(&c, &mode).await;
        let last = frames.lock().unwrap().last().cloned().unwrap();
        assert_eq!(
            last,
            (2, FLAG_FULL, vec![]),
            "关闭节目后最后一帧应清空回放通道表"
        );
        assert!(log
            .lock()
            .unwrap()
            .iter()
            .all(|(n, _)| n != "player:channels"));
    }

    /// 计时：64 Universe × 44Hz × 3 秒的节目以真实时钟播放到 UDP 回环，统计每次到期 `poll`
    /// 相对截止时刻的迟到并打印 p50 / p99 / max。
    ///
    /// 运行：`cargo test -p host-core playback_timing_44hz -- --ignored --nocapture`
    ///
    /// 请在空闲的机器上运行：刚编译完、杀毒软件扫描新文件等系统繁忙时，原生睡眠的唤醒偶尔会晚
    /// 数毫秒（普通优先级线程抢不到 CPU），132 个样本里出现两次就会让 p99 超标。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "真实时钟计时测试（约 4 秒），手动运行"]
    async fn playback_timing_44hz() {
        const UNIVERSES: u16 = 64;
        const FPS: u64 = 44;
        const FRAMES: u64 = FPS * 3;
        let tmp = Tmp::new();
        let unis: Vec<UniDesc> = (0..UNIVERSES)
            .map(|u| UniDesc::from_universe(u, 512).unwrap())
            .collect();
        let mut w =
            ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 1, 0, 0).unwrap();
        let frame_us = |f: u64| f * 1_000_000 / FPS;
        for f in 0..FRAMES {
            // 每帧每路都变化：每次到期都输出 64 路
            let bufs: Vec<Vec<u8>> = (0..UNIVERSES)
                .map(|u| {
                    let mut b = vec![0u8; 512];
                    b[..8].fill((f as u8).wrapping_add(u as u8));
                    b
                })
                .collect();
            w.add_full_frame(frame_us(f), &bufs).unwrap();
        }
        let file = tmp.0.join("timing.artrec");
        std::fs::write(&file, w.finish(frame_us(FRAMES)).unwrap().into_inner()).unwrap();

        // 回环接收端：只计数，保证发送不会因接收缓冲满而受影响
        let sink = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        sink.set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        let port = sink.local_addr().unwrap().port();
        let received = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let counter = {
            let (received, stop) = (received.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut buf = [0u8; 2048];
                while !stop.load(Ordering::Relaxed) {
                    if sink.recv_from(&mut buf).is_ok() {
                        received.fetch_add(1, Ordering::Relaxed);
                    }
                }
            })
        };

        let mode = Arc::new(RuntimeMode::new());
        let (emit, _) = event_log();
        let c = PlaybackController::new();
        c.open(params(
            emit,
            dispatcher(vec![dest(port)]).await,
            &mode,
            file,
            DispatchTarget::Forwarding,
        ))
        .unwrap();
        let started = Instant::now();
        c.play().unwrap();
        for _ in 0..500 {
            let s = c.status();
            if s.state == PlaybackState::Stopped && s.pos_us == s.duration_us {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let elapsed = started.elapsed();
        c.close();
        wait_closed(&c, &mode).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        stop.store(true, Ordering::Relaxed);
        counter.join().unwrap();

        let t = c
            .inner
            .timing
            .lock()
            .unwrap()
            .take()
            .expect("回放线程退出时应记录计时统计");
        println!(
            "playback_timing_44hz: {UNIVERSES} Universe × {FPS}Hz × 3s，用时 {elapsed:?}；\
             迟到 samples={} p50={}µs p99={}µs max={}µs；收到 {} 个包（期望 {}）",
            t.samples,
            t.p50_us,
            t.p99_us,
            t.max_us,
            received.load(Ordering::Relaxed),
            u64::from(UNIVERSES) * FRAMES,
        );
        assert!(
            t.samples >= FRAMES - 2,
            "每帧（首帧除外）都应是一次到期 poll: {t:?}"
        );
        assert!(t.p99_us < 2_000, "p99 迟到应小于 2ms: {t:?}");
    }
}
