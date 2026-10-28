//! 节目编辑器的预览播放引擎：30 FPS 把时间线渲染成 DMX 并经 Art-Net / sACN 输出。
//!
//! # 结构
//!
//! - [`Control`] 是纯状态机（传输状态、播放位置、循环、定位），不依赖 Tauri，单元测试覆盖。
//! - 一次**输出会话**对应一个名为 `artrec-show` 的线程：它按绝对时间表（`t0 + n × 1/30 s`，
//!   `spin_sleep` 精确睡眠）逐帧读取状态机、调用 `show-engine` 求值，再把完整的各 Universe 状态
//!   交给 [`ShowOutput`] 发送。后端是播放的主时钟，前端播放头只跟随 `show:state` 事件。
//! - 会话在“播放 / 暂停”或“灯具定位”期间存在；回到停止且没有定位时，线程先发两帧黑场再退出，
//!   并释放 `show` 互斥标志。暂停和定位期间每秒发一次保活，改动（跳转 / 工程变化）时立即补发。
//!
//! # 互斥
//!
//! 会话开始时由 [`ShowOutput::begin`] 仲裁：录制、回放进行中或已有会话时拒绝
//! （`recording_active` / `playback_active` / `show_active`）。会话期间实时帧被丢弃，
//! 避免实时转发与编辑器输出叠加。
//!
//! # 输出开关
//!
//! 编辑器可以关闭“输出到网络”（[`show_set_output_enabled`]，默认开启，不存进工程）。
//! 关闭时会话线程照常走播放时钟（前端预览跟随 `show:state`），但不持有 [`ShowOutput`]：
//! 不发包、不置位 `show` 标志，实时转发、录制、回放都不受影响。播放中关闭时先补发两帧黑场
//! 再释放输出；播放中打开时由命令先 [`ShowOutput::begin`]（失败则报错、开关保持关闭），
//! 再交给会话线程接管。
//!
//! # 灯光延迟补偿
//!
//! `output.latencyCompMs` 为正表示灯光相对播放头**延后**输出（用于对齐有延迟的音频设备），
//! 即求值时刻为 `位置 - latencyCompMs`。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use host_core::playback::normalize_target;
use host_core::show_output::{OutputHandle, ShowOutput};
use host_core::{ArtnetCoreExt, DispatchTarget};
use serde::Serialize;
use show_engine::{compile, CompileWarning, CompiledShow, FrameSet, ShowProject};
use spin_sleep::SpinSleeper;
use tauri::{AppHandle, Emitter, State};

/// 错误码：工程内容无法解析。
pub const ERR_INVALID_PROJECT: &str = "invalid_project";
/// 错误码：输出目标不合法。
pub const ERR_BAD_TARGET: &str = "bad_target";
/// 错误码：尚未加载工程。
pub const ERR_NO_SHOW: &str = "no_show";
/// 错误码：节目时长为 0，无法播放。
pub const ERR_EMPTY_SHOW: &str = "empty_show";
/// 错误码：定位的灯具不存在或未参与输出。
pub const ERR_UNKNOWN_FIXTURE: &str = "unknown_fixture";

/// 输出帧率。
const FPS: u64 = 30;

/// 暂停 / 定位期间的保活间隔。
const KEEPALIVE: Duration = Duration::from_secs(1);

/// 非播放状态下，状态事件的最长重发间隔。
const IDLE_EMIT: Duration = Duration::from_millis(500);

/// 第 `n` 个节拍相对会话起点的偏移。
///
/// # Arguments
///
/// * `n` - 节拍序号（从 1 起）。
///
/// # Returns
///
/// `n / 30` 秒；按乘除一次算出，避免逐帧累加取整的漂移。
fn tick_offset(n: u64) -> Duration {
    Duration::from_micros(n * 1_000_000 / FPS)
}

/// 传输状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    /// 已停止。
    Stopped,
    /// 播放中。
    Playing,
    /// 已暂停。
    Paused,
}

/// `show:state` 事件载荷与各命令的返回值。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowState {
    /// 是否已加载工程。
    pub loaded: bool,
    /// 传输状态。
    pub transport: Transport,
    /// 播放位置（毫秒）。
    pub position_ms: i64,
    /// 节目总时长（毫秒）。
    pub duration_ms: i64,
    /// 是否循环。
    pub looping: bool,
    /// 正在定位的灯具实例编号。
    pub locate: Option<String>,
    /// 参与输出的 Universe。
    pub universes: Vec<u16>,
    /// 编译警告（被跳过的灯具）。
    pub warnings: Vec<CompileWarning>,
    /// 是否有输出会话在运行（播放 / 暂停 / 定位期间；输出关闭时也为 `true`）。
    pub outputting: bool,
    /// “输出到网络”开关是否打开。
    pub output_enabled: bool,
    /// 是否真的在向网络发送（会话在运行且持有输出）。
    pub sending: bool,
    /// 输出目标为转发表时启用的目的地个数（`None` 表示目标不是转发表）。
    pub destinations: Option<usize>,
    /// 因发送队列满而丢弃的帧数（本次会话累计）。
    pub dropped: u64,
}

/// 传输状态机与工程快照。
struct Control {
    show: Option<Arc<CompiledShow>>,
    target: Arc<DispatchTarget>,
    looping: bool,
    latency_comp_ms: i64,
    transport: Transport,
    /// 播放中：`base_ms` 对应的时刻；其它状态为 `None`。
    origin: Option<Instant>,
    /// 播放位置：播放中是 `origin` 时刻的位置，其它状态就是当前位置。
    base_ms: i64,
    locate: Option<String>,
    /// 有变化需要立即输出 / 通知。
    dirty: bool,
    /// 当前输出会话的代号。
    session: Option<u64>,
    next_session: u64,
    /// A-B 循环区间 `(起点, 终点)`（毫秒，终点大于起点且在节目内）。
    loop_range: Option<(i64, i64)>,
    /// “输出到网络”开关（默认开启）。
    send_enabled: bool,
    /// 会话持有（或即将接管）输出；会话线程释放输出时清除。
    sending: bool,
    /// 播放中重新打开输出时，命令开好的输出会话，等会话线程接管。
    pending_out: Option<ShowOutput>,
}

impl Control {
    fn new() -> Self {
        Self {
            show: None,
            target: Arc::new(DispatchTarget::default()),
            looping: false,
            latency_comp_ms: 0,
            transport: Transport::Stopped,
            origin: None,
            base_ms: 0,
            locate: None,
            dirty: false,
            session: None,
            next_session: 1,
            loop_range: None,
            send_enabled: true,
            sending: false,
            pending_out: None,
        }
    }

    fn duration(&self) -> i64 {
        self.show.as_ref().map_or(0, |s| s.duration_ms())
    }

    /// 当前播放位置（不推进状态机）。
    fn position(&self, now: Instant) -> i64 {
        let pos = match (self.transport, self.origin) {
            (Transport::Playing, Some(origin)) => {
                self.base_ms + now.saturating_duration_since(origin).as_millis() as i64
            }
            _ => self.base_ms,
        };
        pos.clamp(0, self.duration().max(0))
    }

    /// 能否开始播放。
    fn check_playable(&self) -> Result<(), &'static str> {
        match &self.show {
            None => Err(ERR_NO_SHOW),
            Some(s) if s.duration_ms() <= 0 => Err(ERR_EMPTY_SHOW),
            Some(_) => Ok(()),
        }
    }

    /// 播放 / 继续；已在结尾时从头开始。调用前须通过 [`Control::check_playable`]。
    fn play(&mut self, now: Instant) {
        if self.base_ms >= self.duration() {
            self.base_ms = 0;
        }
        self.transport = Transport::Playing;
        self.origin = Some(now);
        self.dirty = true;
    }

    fn pause(&mut self, now: Instant) {
        if self.transport == Transport::Playing {
            self.base_ms = self.position(now);
            self.origin = None;
            self.transport = Transport::Paused;
            self.dirty = true;
        }
    }

    fn stop(&mut self) {
        self.transport = Transport::Stopped;
        self.origin = None;
        self.base_ms = 0;
        self.dirty = true;
    }

    fn seek(&mut self, now: Instant, ms: i64) {
        self.base_ms = ms.clamp(0, self.duration().max(0));
        if self.transport == Transport::Playing {
            self.origin = Some(now);
        }
        self.dirty = true;
    }

    /// 推进状态机：处理循环回绕与播完停止。
    ///
    /// # Returns
    ///
    /// 推进后的播放位置。
    fn advance(&mut self, now: Instant) -> i64 {
        if self.transport != Transport::Playing {
            return self.position(now);
        }
        let duration = self.duration();
        let raw = match self.origin {
            Some(origin) => self.base_ms + now.saturating_duration_since(origin).as_millis() as i64,
            None => self.base_ms,
        };
        // A-B 循环：从区间终点之前开始播放时，到终点后回到起点（从终点之后开始则照常播完）
        if let Some((a, b)) = self.loop_range {
            if self.base_ms < b && raw >= b {
                let wrapped = a + (raw - b) % (b - a);
                self.base_ms = wrapped;
                self.origin = Some(now);
                self.dirty = true;
                return wrapped;
            }
        }
        if raw < duration {
            return raw.max(0);
        }
        self.dirty = true;
        if self.looping && duration > 0 {
            let wrapped = raw % duration;
            self.base_ms = wrapped;
            self.origin = Some(now);
            wrapped
        } else {
            self.transport = Transport::Stopped;
            self.origin = None;
            self.base_ms = duration;
            duration
        }
    }

    /// 没有任何需要输出的东西：已停止且没有定位。
    fn is_idle(&self) -> bool {
        self.transport == Transport::Stopped && (self.locate.is_none() || self.show.is_none())
    }

    fn snapshot(&self, now: Instant, destinations: Option<usize>, dropped: u64) -> ShowState {
        ShowState {
            loaded: self.show.is_some(),
            transport: self.transport,
            position_ms: self.position(now),
            duration_ms: self.duration(),
            looping: self.looping,
            locate: self.locate.clone(),
            universes: self.show.as_ref().map(|s| s.universes().to_vec()).unwrap_or_default(),
            warnings: self.show.as_ref().map(|s| s.warnings().to_vec()).unwrap_or_default(),
            outputting: self.session.is_some(),
            output_enabled: self.send_enabled,
            sending: self.session.is_some() && self.sending,
            destinations,
            dropped,
        }
    }

    /// 打开 / 关闭“输出到网络”。
    ///
    /// 没有会话时只记下开关；会话运行中关闭时由会话线程补发黑场并释放输出，
    /// 打开时先开好输出会话交给线程接管。
    ///
    /// # Arguments
    ///
    /// * `enabled` - 是否向网络发送。
    /// * `begin` - 开始输出会话（生产环境是 [`ShowOutput::begin`]）。
    ///
    /// # Errors
    ///
    /// 会话运行中打开、而 `begin` 失败（录制 / 回放进行中等）时返回其错误码，开关保持关闭。
    fn set_send_enabled(
        &mut self,
        enabled: bool,
        begin: impl FnOnce() -> Result<ShowOutput, String>,
    ) -> Result<(), String> {
        if enabled == self.send_enabled {
            return Ok(());
        }
        if enabled {
            // 线程还没来得及释放上一次的输出时（`sending` 仍为真）直接沿用
            if self.session.is_some() && !self.sending {
                self.pending_out = Some(begin()?);
                self.sending = true;
            }
        } else if self.pending_out.take().is_some() {
            // 线程尚未接管：在这里直接释放
            self.sending = false;
        }
        self.send_enabled = enabled;
        self.dirty = true;
        Ok(())
    }
}

/// 应用壳托管的节目预览引擎。
pub struct ShowRuntime {
    ctl: Arc<Mutex<Control>>,
    /// 编辑器里的工程有未保存的修改（由前端同步；关闭窗口时据此拦下并确认）。
    dirty: AtomicBool,
}

impl Default for ShowRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl ShowRuntime {
    /// 创建空闲的引擎（尚未加载工程）。
    ///
    /// # Returns
    ///
    /// 未加载工程、未输出的 [`ShowRuntime`]。
    #[must_use]
    pub fn new() -> Self {
        Self {
            ctl: Arc::new(Mutex::new(Control::new())),
            dirty: AtomicBool::new(false),
        }
    }

    /// 编辑器里的工程是否有未保存的修改。
    ///
    /// # Returns
    ///
    /// 前端最近一次报告的状态。
    #[must_use]
    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::Relaxed)
    }

    /// 停止一切灯光输出并等待输出会话收尾（先发黑场），用于退出应用前。
    ///
    /// # Arguments
    ///
    /// * `timeout` - 最长等待时间；超时就返回（进程随后退出）。
    pub fn shutdown_blocking(&self, timeout: Duration) {
        {
            let mut ctl = self.lock();
            ctl.stop();
            ctl.locate = None;
        }
        let deadline = Instant::now() + timeout;
        while self.lock().session.is_some() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn lock(&self) -> MutexGuard<'_, Control> {
        lock(&self.ctl)
    }
}

fn lock(ctl: &Mutex<Control>) -> MutexGuard<'_, Control> {
    ctl.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 目标为转发表时返回启用的目的地个数；为路由表时返回启用的端口总数。
fn destinations_of(target: &DispatchTarget, handle: &OutputHandle) -> Option<usize> {
    match target {
        DispatchTarget::Forwarding => Some(handle.enabled_destinations()),
        DispatchTarget::Routed { .. } => target.routed_ports(),
        DispatchTarget::Direct { .. } => None,
    }
}

/// 状态推送回调：生产环境发 `show:state` 事件，测试里收集到内存。
type Publisher = Arc<dyn Fn(&ShowState) + Send + Sync>;

/// 推送 `show:state` 事件。
fn publish(app: &AppHandle, state: &ShowState) {
    let _ = app.emit("show:state", state);
}

/// 把应用句柄包成 [`Publisher`]。
fn app_publisher(app: &AppHandle) -> Publisher {
    let app = app.clone();
    Arc::new(move |state| publish(&app, state))
}

/// 若没有输出会话，则开始一个并启动计时线程；输出关闭时线程只走时钟、不持有输出。
///
/// # Arguments
///
/// * `rt` - 引擎。
/// * `ctl` - 已持有的状态锁。
/// * `publisher` - 状态推送回调（线程里调用）。
/// * `handle` - 运行时输出句柄。
///
/// # Errors
///
/// 输出打开且录制 / 回放进行中，或线程创建失败时返回错误码 / 描述。
fn ensure_session(
    rt: &ShowRuntime,
    ctl: &mut Control,
    publisher: &Publisher,
    handle: &OutputHandle,
) -> Result<(), String> {
    if ctl.session.is_some() {
        return Ok(());
    }
    let out = if ctl.send_enabled { Some(ShowOutput::begin(handle)?) } else { None };
    ctl.sending = out.is_some();
    let generation = ctl.next_session;
    ctl.next_session += 1;
    ctl.session = Some(generation);
    let shared = rt.ctl.clone();
    let publisher = publisher.clone();
    let handle = handle.clone();
    std::thread::Builder::new()
        .name("artrec-show".into())
        .spawn(move || run_session(&shared, &publisher, &handle, out, generation))
        .map(|_| ())
        .map_err(|e| {
            ctl.session = None;
            ctl.sending = false;
            e.to_string()
        })
}

/// 退出（含 panic 展开）时清除会话代号的守卫，保证之后还能重新开始会话。
struct SessionGuard {
    ctl: Arc<Mutex<Control>>,
    generation: u64,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        let mut c = lock(&self.ctl);
        if c.session == Some(self.generation) {
            c.session = None;
            c.transport = Transport::Stopped;
            c.origin = None;
            c.sending = false;
            c.pending_out = None;
        }
    }
}

/// 输出会话线程主体。
///
/// # Arguments
///
/// * `shared` - 共享的状态机。
/// * `publisher` - 状态推送回调。
/// * `handle` - 运行时输出句柄（统计目的地个数）。
/// * `out` - 输出会话；输出关闭时为 `None`（只走时钟、推送状态）。
/// * `generation` - 本会话的代号。
fn run_session(
    shared: &Arc<Mutex<Control>>,
    publisher: &Publisher,
    handle: &OutputHandle,
    out: Option<ShowOutput>,
    generation: u64,
) {
    let _guard = SessionGuard {
        ctl: shared.clone(),
        generation,
    };
    let sleeper = SpinSleeper::default();
    let t0 = Instant::now();
    let mut out = out;
    let mut frames: Option<(Arc<CompiledShow>, FrameSet)> = None;
    let mut last_sent: Option<Instant> = None;
    let mut last_emit: Option<Instant> = None;
    let mut n: u64 = 0;

    loop {
        n += 1;
        sleeper.sleep_until(t0 + tick_offset(n));
        let now = Instant::now();
        let mut ctl = lock(shared);
        let position = ctl.advance(now);

        if ctl.is_idle() {
            // 收尾：先在锁外发两帧黑场，再确认状态没变就退出。
            let show = ctl.show.clone();
            let target = ctl.target.clone();
            drop(ctl);
            if let (Some(show), Some(o)) = (show, out.as_ref()) {
                send_blackout(o, &target, &show, &sleeper);
            }
            let mut ctl = lock(shared);
            if ctl.is_idle() {
                // 在锁内释放输出会话，保证新会话看到的 `show` 标志已复位。
                drop(out.take());
                drop(ctl.pending_out.take());
                ctl.session = None;
                ctl.sending = false;
                let state = ctl.snapshot(Instant::now(), None, 0);
                drop(ctl);
                publisher(&state);
                return;
            }
            continue;
        }

        if !ctl.send_enabled && out.is_some() {
            // 输出被关闭：先在锁外补发两帧黑场，再在锁内释放输出（之后命令能重新开始输出）。
            let show = ctl.show.clone();
            let target = ctl.target.clone();
            drop(ctl);
            if let (Some(show), Some(o)) = (show, out.as_ref()) {
                send_blackout(o, &target, &show, &sleeper);
            }
            let mut ctl = lock(shared);
            if !ctl.send_enabled {
                drop(out.take());
                ctl.sending = false;
            }
            ctl.dirty = true;
            continue;
        }
        if let Some(o) = ctl.pending_out.take() {
            // 输出被重新打开：接管命令开好的输出会话，立即补发当前画面。
            out = Some(o);
            last_sent = None;
        }

        let Some(show) = ctl.show.clone() else {
            continue;
        };
        // 工程被替换后重建帧缓冲（形状可能变化）。
        let reuse = matches!(&frames, Some((cached, _)) if Arc::ptr_eq(cached, &show));
        if !reuse {
            frames = Some((show.clone(), show.new_frames()));
        }
        let Some((_, fs)) = frames.as_mut() else {
            continue;
        };

        if let Some(id) = ctl.locate.clone() {
            if !show.locate_into(&id, fs) {
                ctl.locate = None;
                ctl.dirty = true;
            }
        } else {
            show.evaluate_into(position - ctl.latency_comp_ms, fs);
        }

        let playing = ctl.transport == Transport::Playing;
        let due_keepalive = last_sent.is_none_or(|t| now.saturating_duration_since(t) >= KEEPALIVE);
        let send = playing || ctl.dirty || due_keepalive;
        if let (true, Some(o)) = (send, out.as_ref()) {
            o.submit(&ctl.target, fs.frames().iter().map(|f| (f.universe, &f.data[..])));
            last_sent = Some(now);
        }
        let emit = playing
            || ctl.dirty
            || last_emit.is_none_or(|t| now.saturating_duration_since(t) >= IDLE_EMIT);
        ctl.dirty = false;
        let dropped = out.as_ref().map_or(0, ShowOutput::dropped);
        let state = emit.then(|| ctl.snapshot(now, destinations_of(&ctl.target, handle), dropped));
        drop(ctl);
        if let Some(state) = state {
            last_emit = Some(now);
            publisher(&state);
        }
    }
}

/// 发两帧黑场（间隔一个节拍），降低 UDP 丢包导致灯具残留的概率。
fn send_blackout(out: &ShowOutput, target: &Arc<DispatchTarget>, show: &CompiledShow, sleeper: &SpinSleeper) {
    let mut fs = show.new_frames();
    show.blackout_into(&mut fs);
    for i in 0..2 {
        out.submit(target, fs.frames().iter().map(|f| (f.universe, &f.data[..])));
        if i == 0 {
            sleeper.sleep(tick_offset(1));
        }
    }
}

/// 由前端工程 JSON 解析输出目标。
///
/// # Arguments
///
/// * `value` - `output.target` 的 JSON；缺省 / `null` 时使用转发表。
///
/// # Errors
///
/// 结构不合法或 IP 无法解析时返回 [`ERR_BAD_TARGET`]。
#[cfg(test)]
fn parse_target(value: &serde_json::Value) -> Result<DispatchTarget, String> {
    parse_output_target(value, &serde_json::Value::Null, &serde_json::Value::Null)
}

/// 由工程的输出设置解析输出目标；`routed` 目标的路由表与同步设置分别取自
/// `output.universes` 与 `output.sync`。
///
/// # Arguments
///
/// * `target` - `output.target` 的 JSON；缺省 / `null` 时使用转发表。
/// * `universes` - `output.universes` 的 JSON（路由表）。
/// * `sync` - `output.sync` 的 JSON（帧同步设置）。
///
/// # Returns
///
/// 规整后的输出目标。
///
/// # Errors
///
/// 结构不合法、IP 无法解析或远端 Universe 越界时返回 [`ERR_BAD_TARGET`]。
fn parse_output_target(
    target: &serde_json::Value,
    universes: &serde_json::Value,
    sync: &serde_json::Value,
) -> Result<DispatchTarget, String> {
    if target.is_null() {
        return Ok(DispatchTarget::default());
    }
    let mut value = target.clone();
    if value.get("kind").and_then(serde_json::Value::as_str) == Some("routed") {
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "universes".into(),
                if universes.is_null() { serde_json::json!([]) } else { universes.clone() },
            );
            if !sync.is_null() {
                obj.insert("sync".into(), sync.clone());
            }
        }
    }
    let target: DispatchTarget =
        serde_json::from_value(value).map_err(|_| ERR_BAD_TARGET.to_string())?;
    normalize_target(target)
}

/// 加载 / 替换当前工程。
///
/// 重新编译并替换；若已有输出会话，下一帧立即生效。播放位置和传输状态保持不变
/// （位置会被夹取到新时长内）。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `state` - 引擎状态。
/// * `project` - 前端的工程 JSON。
///
/// # Returns
///
/// 加载后的 [`ShowState`]。
///
/// # Errors
///
/// 工程无法解析（`invalid_project`）或输出目标不合法（`bad_target`）。
#[tauri::command]
pub fn show_load(
    app: AppHandle,
    state: State<'_, ShowRuntime>,
    project: serde_json::Value,
) -> Result<ShowState, String> {
    let parsed: ShowProject =
        serde_json::from_value(project).map_err(|_| ERR_INVALID_PROJECT.to_string())?;
    let target = Arc::new(parse_output_target(
        &parsed.output.target,
        &parsed.output.universes,
        &parsed.output.sync,
    )?);
    let compiled = Arc::new(compile(&parsed));
    let handle = app.artnet_core().show_output_handle();
    let snapshot = {
        let mut ctl = state.lock();
        ctl.show = Some(compiled);
        ctl.looping = parsed.output.looping;
        ctl.latency_comp_ms = parsed.output.latency_comp_ms;
        ctl.loop_range = parsed.valid_loop_range();
        ctl.target = target.clone();
        let now = Instant::now();
        ctl.base_ms = ctl.base_ms.clamp(0, ctl.duration());
        if ctl.transport == Transport::Playing {
            // 时长缩短后位置可能已越界：以夹取后的位置重新起算。
            ctl.base_ms = ctl.position(now);
            ctl.origin = Some(now);
        }
        // 定位的灯具可能已被删除，交给会话线程发现并清除。
        ctl.dirty = true;
        ctl.snapshot(now, destinations_of(&target, &handle), 0)
    };
    publish(&app, &snapshot);
    Ok(snapshot)
}

/// 播放 / 继续；位置在结尾时从头开始。
///
/// # Errors
///
/// 未加载工程（`no_show`）、时长为 0（`empty_show`），或录制 / 回放进行中
/// （`recording_active` / `playback_active`）、已有其它输出会话（`show_active`）。
#[tauri::command]
pub fn show_play(app: AppHandle, state: State<'_, ShowRuntime>) -> Result<ShowState, String> {
    let handle = app.artnet_core().show_output_handle();
    let snapshot = {
        let mut ctl = state.lock();
        ctl.check_playable().map_err(str::to_owned)?;
        ensure_session(&state, &mut ctl, &app_publisher(&app), &handle)?;
        let now = Instant::now();
        ctl.play(now);
        ctl.snapshot(now, destinations_of(&ctl.target, &handle), 0)
    };
    publish(&app, &snapshot);
    Ok(snapshot)
}

/// 暂停（保持当前画面并每秒保活）。
#[tauri::command]
pub fn show_pause(app: AppHandle, state: State<'_, ShowRuntime>) -> ShowState {
    let handle = app.artnet_core().show_output_handle();
    let snapshot = {
        let mut ctl = state.lock();
        let now = Instant::now();
        ctl.pause(now);
        ctl.snapshot(now, destinations_of(&ctl.target, &handle), 0)
    };
    publish(&app, &snapshot);
    snapshot
}

/// 停止：位置回到 0，输出黑场并结束会话（定位仍在时保留）。
#[tauri::command]
pub fn show_stop(app: AppHandle, state: State<'_, ShowRuntime>) -> ShowState {
    let handle = app.artnet_core().show_output_handle();
    let snapshot = {
        let mut ctl = state.lock();
        ctl.stop();
        ctl.snapshot(Instant::now(), destinations_of(&ctl.target, &handle), 0)
    };
    publish(&app, &snapshot);
    snapshot
}

/// 跳转到指定位置。
///
/// 未在输出时只记录位置（下次播放从这里开始）；暂停 / 播放中立即生效。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `state` - 引擎状态。
/// * `position_ms` - 目标位置（毫秒），会被夹取到 `0..=时长`。
#[tauri::command]
pub fn show_seek(app: AppHandle, state: State<'_, ShowRuntime>, position_ms: i64) -> ShowState {
    let handle = app.artnet_core().show_output_handle();
    let snapshot = {
        let mut ctl = state.lock();
        let now = Instant::now();
        ctl.seek(now, position_ms);
        ctl.snapshot(now, destinations_of(&ctl.target, &handle), 0)
    };
    publish(&app, &snapshot);
    snapshot
}

/// 开始 / 结束灯具定位：只点亮指定灯具（满亮白光），其余黑场。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `state` - 引擎状态。
/// * `fixture_id` - 要定位的灯具实例编号；`None` 结束定位。
///
/// # Errors
///
/// 未加载工程（`no_show`）、灯具不存在或被跳过（`unknown_fixture`），或录制 / 回放进行中。
#[tauri::command]
pub fn show_locate(
    app: AppHandle,
    state: State<'_, ShowRuntime>,
    fixture_id: Option<String>,
) -> Result<ShowState, String> {
    let handle = app.artnet_core().show_output_handle();
    let snapshot = {
        let mut ctl = state.lock();
        if let Some(id) = &fixture_id {
            let show = ctl.show.clone().ok_or_else(|| ERR_NO_SHOW.to_string())?;
            if !show.has_fixture(id) {
                return Err(ERR_UNKNOWN_FIXTURE.to_string());
            }
            ensure_session(&state, &mut ctl, &app_publisher(&app), &handle)?;
        }
        ctl.locate = fixture_id;
        ctl.dirty = true;
        ctl.snapshot(Instant::now(), destinations_of(&ctl.target, &handle), 0)
    };
    publish(&app, &snapshot);
    Ok(snapshot)
}

/// 打开 / 关闭“输出到网络”（默认开启）。关闭时编辑器照常播放、只在本机预览，
/// 不向网络发包，也不占用输出（实时转发、录制、回放不受影响）。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `state` - 引擎状态。
/// * `enabled` - 是否向网络发送。
///
/// # Returns
///
/// 切换后的状态。
///
/// # Errors
///
/// 播放 / 暂停 / 定位期间打开输出、而录制或回放进行中时返回
/// `recording_active` / `playback_active`（开关保持关闭）。
#[tauri::command]
pub fn show_set_output_enabled(
    app: AppHandle,
    state: State<'_, ShowRuntime>,
    enabled: bool,
) -> Result<ShowState, String> {
    let handle = app.artnet_core().show_output_handle();
    let snapshot = {
        let mut ctl = state.lock();
        ctl.set_send_enabled(enabled, || ShowOutput::begin(&handle))?;
        ctl.snapshot(Instant::now(), destinations_of(&ctl.target, &handle), 0)
    };
    publish(&app, &snapshot);
    Ok(snapshot)
}

/// 报告编辑器里的工程是否有未保存的修改（关闭窗口时的退出守卫据此确认）。
///
/// # Arguments
///
/// * `state` - 引擎状态。
/// * `dirty` - 是否有未保存的修改。
#[tauri::command]
pub fn show_set_dirty(state: State<'_, ShowRuntime>, dirty: bool) {
    state.dirty.store(dirty, Ordering::Relaxed);
}

/// 当前状态。
#[tauri::command]
pub fn show_status(app: AppHandle, state: State<'_, ShowRuntime>) -> ShowState {
    let handle = app.artnet_core().show_output_handle();
    let ctl = state.lock();
    ctl.snapshot(Instant::now(), destinations_of(&ctl.target, &handle), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(duration_ms: i64) -> Arc<CompiledShow> {
        let p: ShowProject =
            serde_json::from_value(serde_json::json!({ "durationMs": duration_ms })).unwrap();
        Arc::new(compile(&p))
    }

    fn control(duration_ms: i64) -> Control {
        let mut c = Control::new();
        c.show = Some(project(duration_ms));
        c
    }

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn 节拍偏移按乘除计算而不累加取整() {
        assert_eq!(tick_offset(30), Duration::from_secs(1));
        assert_eq!(tick_offset(1), Duration::from_micros(33_333));
        assert_eq!(tick_offset(3), Duration::from_micros(100_000));
    }

    #[test]
    fn 未加载或时长为零不能播放() {
        let c = Control::new();
        assert_eq!(c.check_playable(), Err(ERR_NO_SHOW));
        assert_eq!(control(0).check_playable(), Err(ERR_EMPTY_SHOW));
        assert_eq!(control(1000).check_playable(), Ok(()));
    }

    #[test]
    fn 播放位置随时间推进_暂停后冻结() {
        let t0 = Instant::now();
        let mut c = control(10_000);
        c.play(t0);
        assert_eq!(c.advance(at(t0, 1500)), 1500);
        c.pause(at(t0, 2000));
        assert_eq!(c.transport, Transport::Paused);
        assert_eq!(c.advance(at(t0, 9000)), 2000);
        c.play(at(t0, 9000));
        assert_eq!(c.advance(at(t0, 9500)), 2500);
    }

    #[test]
    fn 跳转在播放中重新起算_夹取到范围内() {
        let t0 = Instant::now();
        let mut c = control(10_000);
        c.play(t0);
        c.seek(at(t0, 1000), 5000);
        assert_eq!(c.advance(at(t0, 1200)), 5200);
        c.seek(at(t0, 1200), 99_999);
        assert_eq!(c.position(at(t0, 1200)), 10_000);
        c.seek(at(t0, 1200), -5);
        assert_eq!(c.position(at(t0, 1200)), 0);
    }

    #[test]
    fn 播完后停在结尾_再播放从头开始() {
        let t0 = Instant::now();
        let mut c = control(1000);
        c.play(t0);
        assert_eq!(c.advance(at(t0, 1200)), 1000);
        assert_eq!(c.transport, Transport::Stopped);
        assert!(c.is_idle());
        c.play(at(t0, 1300));
        assert_eq!(c.advance(at(t0, 1400)), 100);
    }

    #[test]
    fn 循环时回绕并保持播放() {
        let t0 = Instant::now();
        let mut c = control(1000);
        c.looping = true;
        c.play(t0);
        assert_eq!(c.advance(at(t0, 2300)), 300);
        assert_eq!(c.transport, Transport::Playing);
        assert_eq!(c.advance(at(t0, 2400)), 400);
    }

    #[test]
    fn ab_循环_从终点之前开始播放时回到起点() {
        let t0 = Instant::now();
        let mut c = control(10_000);
        c.loop_range = Some((2000, 3000));
        c.seek(t0, 2500);
        c.play(t0);
        assert_eq!(c.advance(at(t0, 400)), 2900);
        assert_eq!(c.advance(at(t0, 700)), 2200);
        assert_eq!(c.transport, Transport::Playing);
        // 从终点之后开始：照常播放
        c.seek(at(t0, 700), 5000);
        assert_eq!(c.advance(at(t0, 1700)), 6000);
    }

    #[test]
    fn 工程里的循环区间被夹取到节目内() {
        let p: ShowProject = serde_json::from_value(serde_json::json!({
            "durationMs": 5000, "loopRange": { "startMs": 4000, "endMs": 9000 }
        }))
        .unwrap();
        assert_eq!(p.valid_loop_range(), Some((4000, 5000)));
        let bad: ShowProject = serde_json::from_value(serde_json::json!({
            "durationMs": 5000, "loopRange": { "startMs": 3000, "endMs": 3000 }
        }))
        .unwrap();
        assert_eq!(bad.valid_loop_range(), None);
    }

    #[test]
    fn 停止回到零位且空闲_定位期间不空闲() {
        let t0 = Instant::now();
        let mut c = control(1000);
        c.play(t0);
        c.stop();
        assert_eq!(c.position(at(t0, 500)), 0);
        assert!(c.is_idle());
        c.locate = Some("f1".into());
        assert!(!c.is_idle(), "定位期间会话必须保持");
    }

    #[test]
    fn 路由目标取自工程的_universe_表_并校验() {
        let universes = serde_json::json!([
            { "universe": 1, "label": "舞台左", "ports": [
                { "id": "a", "protocol": "artNet", "mode": "unicast", "ip": "10.0.0.5", "port": 6454, "remoteUniverse": 17, "enabled": true },
                { "id": "b", "protocol": "sacn", "mode": "multicast", "ip": "", "port": 5568, "remoteUniverse": 2, "priority": 250, "enabled": true },
                { "id": "c", "protocol": "artNet", "mode": "unicast", "ip": "坏地址", "port": 6454, "remoteUniverse": 0, "enabled": false }
            ]},
            { "universe": 0, "label": "", "ports": [] }
        ]);
        let sync = serde_json::json!({ "artSync": true, "sacnSyncUniverse": 7 });
        let t = parse_output_target(&serde_json::json!({ "kind": "routed" }), &universes, &sync).unwrap();
        let DispatchTarget::Routed { universes, sync } = &t else { panic!("应为路由目标") };
        assert_eq!(universes.len(), 1, "空端口的 Universe 不进路由表");
        assert_eq!(universes[0].ports.len(), 2, "停用的端口被丢弃（不校验）");
        assert_eq!(universes[0].ports[1].priority, Some(200), "优先级夹到 200");
        assert!(sync.art_sync);
        assert_eq!(t.routed_ports(), Some(2));

        let bad = serde_json::json!([{ "universe": 0, "ports": [
            { "protocol": "sacn", "mode": "unicast", "ip": "10.0.0.1", "port": 5568, "remoteUniverse": 0, "enabled": true }
        ]}]);
        assert_eq!(
            parse_output_target(&serde_json::json!({ "kind": "routed" }), &bad, &serde_json::Value::Null),
            Err(ERR_BAD_TARGET.to_string()),
            "sACN 远端 Universe 0 非法"
        );
    }

    #[test]
    fn 目标缺省为转发表_非法目标报错() {
        assert_eq!(parse_target(&serde_json::Value::Null).unwrap(), DispatchTarget::Forwarding);
        let direct = serde_json::json!({"kind":"direct","ip":" 192.168.1.9 ","protocol":"artNet","port":0});
        let DispatchTarget::Direct { ip, port, .. } = parse_target(&direct).unwrap() else {
            panic!("应为直接目标");
        };
        assert_eq!((ip.as_str(), port), ("192.168.1.9", 6454));
        let bad = serde_json::json!({"kind":"direct","ip":"nope","protocol":"artNet","port":6454});
        assert_eq!(parse_target(&bad).unwrap_err(), "bad_target");
        assert_eq!(parse_target(&serde_json::json!({"kind":"x"})).unwrap_err(), ERR_BAD_TARGET);
    }

    #[test]
    fn 会话线程按节拍推送状态_停止后释放互斥标志() {
        use host_core::mode::RuntimeMode;
        use host_core::{Dispatcher, SenderSlot};

        let mode = Arc::new(RuntimeMode::new());
        let handle = OutputHandle::new(
            Dispatcher::with_table(Default::default(), SenderSlot::default()),
            mode.clone(),
            Instant::now(),
        );
        let states = Arc::new(Mutex::new(Vec::<ShowState>::new()));
        let publisher: Publisher = {
            let states = states.clone();
            Arc::new(move |s| states.lock().unwrap().push(s.clone()))
        };
        let rt = ShowRuntime::new();
        {
            let mut ctl = rt.lock();
            ctl.show = Some(project(1_000_000));
            ensure_session(&rt, &mut ctl, &publisher, &handle).expect("空闲时应能开始会话");
            ctl.play(Instant::now());
        }
        assert!(mode.is_show(), "会话期间 show 标志置位");
        // 会话期间不允许第二个会话。
        assert!(ShowOutput::begin(&handle).is_err());

        std::thread::sleep(Duration::from_millis(400));
        let playing: Vec<i64> = states
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.transport == Transport::Playing)
            .map(|s| s.position_ms)
            .collect();
        assert!(playing.len() >= 6, "400ms 内应至少推送 6 次状态，实际 {}", playing.len());
        assert!(playing.windows(2).all(|w| w[0] <= w[1]), "位置单调不减: {playing:?}");
        assert!(*playing.last().unwrap() >= 200, "位置应随时间推进: {playing:?}");

        rt.lock().stop();
        let deadline = Instant::now() + Duration::from_secs(3);
        while mode.is_show() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!mode.is_show(), "停止后会话线程应收尾并释放标志");
        assert!(rt.lock().session.is_none());
        let last = states.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.transport, Transport::Stopped);
        assert!(!last.outputting);

        // 收尾之后可以重新开始会话。
        let mut ctl = rt.lock();
        assert!(ensure_session(&rt, &mut ctl, &publisher, &handle).is_ok());
        ctl.locate = Some("ghost".into());
        drop(ctl);
        // 定位的灯具不存在：线程发现后清除定位并收尾。
        let deadline = Instant::now() + Duration::from_secs(3);
        while mode.is_show() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!mode.is_show());
    }

    /// 测试用的输出句柄与运行模式。
    fn test_handle() -> (OutputHandle, Arc<host_core::mode::RuntimeMode>) {
        use host_core::mode::RuntimeMode;
        use host_core::{Dispatcher, SenderSlot};

        let mode = Arc::new(RuntimeMode::new());
        let handle = OutputHandle::new(
            Dispatcher::with_table(Default::default(), SenderSlot::default()),
            mode.clone(),
            Instant::now(),
        );
        (handle, mode)
    }

    /// 等到 `cond` 成立（最多 3 秒）。
    fn wait_until(cond: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !cond() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        cond()
    }

    #[test]
    fn 没有会话时切换输出开关只记下状态() {
        let mut c = control(1000);
        assert!(c.send_enabled, "默认开启");
        c.set_send_enabled(false, || panic!("关闭不需要开始输出")).unwrap();
        let s = c.snapshot(Instant::now(), None, 0);
        assert!(!s.output_enabled && !s.sending);
        c.set_send_enabled(true, || panic!("没有会话时不开始输出")).unwrap();
        assert!(c.send_enabled && c.pending_out.is_none());
    }

    #[test]
    fn 输出关闭时播放不占用输出_录制中也能播放() {
        let (handle, mode) = test_handle();
        let states = Arc::new(Mutex::new(Vec::<ShowState>::new()));
        let publisher: Publisher = {
            let states = states.clone();
            Arc::new(move |s| states.lock().unwrap().push(s.clone()))
        };
        let rt = ShowRuntime::new();
        mode.set_recording(true);
        {
            let mut ctl = rt.lock();
            ctl.show = Some(project(1_000_000));
            ctl.set_send_enabled(false, || unreachable!()).unwrap();
            ensure_session(&rt, &mut ctl, &publisher, &handle).expect("输出关闭时录制中也能播放");
            ctl.play(Instant::now());
        }
        assert!(wait_until(|| states.lock().unwrap().iter().any(|s| s.transport == Transport::Playing)));
        assert!(!mode.is_show(), "输出关闭时不置位 show 标志");
        let last = states.lock().unwrap().last().cloned().unwrap();
        assert!(last.outputting && !last.sending && !last.output_enabled);

        // 录制中打开输出：失败，开关保持关闭
        let err = rt.lock().set_send_enabled(true, || ShowOutput::begin(&handle)).unwrap_err();
        assert_eq!(err, "recording_active");
        assert!(!rt.lock().send_enabled);

        // 录制结束后打开：会话线程接管输出
        mode.set_recording(false);
        rt.lock().set_send_enabled(true, || ShowOutput::begin(&handle)).unwrap();
        assert!(mode.is_show());
        assert!(wait_until(|| rt.lock().pending_out.is_none()), "线程应接管输出");
        assert!(rt.lock().snapshot(Instant::now(), None, 0).sending);

        // 播放中关闭：线程补发黑场后释放输出，播放继续
        rt.lock().set_send_enabled(false, || unreachable!()).unwrap();
        assert!(wait_until(|| !mode.is_show()), "关闭后应释放 show 标志");
        let ctl = rt.lock();
        assert_eq!(ctl.transport, Transport::Playing);
        assert!(ctl.session.is_some() && !ctl.sending);
        drop(ctl);

        rt.lock().stop();
        assert!(wait_until(|| rt.lock().session.is_none()));
    }

    #[test]
    fn 脏标记读写() {
        let rt = ShowRuntime::new();
        assert!(!rt.is_dirty());
        rt.dirty.store(true, Ordering::Relaxed);
        assert!(rt.is_dirty());
    }

    #[test]
    fn 没有会话时_shutdown_立即返回并复位状态() {
        let rt = ShowRuntime::new();
        {
            let mut ctl = rt.lock();
            ctl.show = Some(project(1000));
            ctl.play(Instant::now());
            ctl.locate = Some("f".into());
        }
        let started = Instant::now();
        rt.shutdown_blocking(Duration::from_millis(500));
        assert!(started.elapsed() < Duration::from_millis(200), "没有会话不应等待");
        let ctl = rt.lock();
        assert_eq!(ctl.transport, Transport::Stopped);
        assert!(ctl.locate.is_none());
    }

    #[test]
    fn 快照反映状态() {
        let t0 = Instant::now();
        let mut c = control(2000);
        c.play(t0);
        let s = c.snapshot(at(t0, 500), Some(2), 7);
        assert!(s.loaded && s.position_ms == 500 && s.duration_ms == 2000);
        assert_eq!((s.destinations, s.dropped), (Some(2), 7));
        assert!(!s.outputting, "尚未启动会话");
    }
}
