//! Tauri 命令：信号检测器（测试信号发生器）的独立窗口与发送控制。
//!
//! 发送逻辑全部在 `signal-gen` crate 里；本模块只做三件事：
//!
//! 1. **窗口**：单例的独立窗口（`signal-checker`），与主窗口生命周期联动——主窗口销毁时一并关掉，
//!    检测器窗口销毁时停止发送并清零，保证不会留下"没人管的"测试信号；
//! 2. **命令**：把 [`SignalSender`] 的控制方法包成 Tauri 命令；
//! 3. **事件**：状态每 200ms、错误与预览按发生时，只发给检测器窗口（不打扰主窗口）。

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use host_core::app_mode::AppMode;
use host_core::{ArtnetCoreExt, SettingsExt};
use netif::NetworkInterfaceDto;
use serde::Serialize;
use signal_gen::{
    ConfigError, EventSink, ManualError, PatternId, PatternInfo, SendMode, SenderError,
    SenderEvent, SenderStatus, SignalConfig, SignalSender,
};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// 检测器窗口的标签（单例判定与事件定向都靠它）。
pub const WINDOW_LABEL: &str = "signal-checker";
/// 检测器窗口加载的页面（Vite 多页面入口）。
const WINDOW_PAGE: &str = "signal-checker.html";
/// 状态事件的推送间隔。
const STATUS_INTERVAL: Duration = Duration::from_millis(200);

/// 应用壳托管的检测器状态。
pub struct SignalCheckerState {
    sender: SignalSender,
    /// 状态推送循环是否在运行（避免窗口快速关闭再打开时出现两个循环）。
    status_loop: AtomicBool,
}

impl SignalCheckerState {
    /// 创建检测器状态：发送器的错误与预览事件会定向转发给检测器窗口。
    ///
    /// # Arguments
    ///
    /// * `app` - Tauri 应用句柄，用于发事件和取异步运行时。
    ///
    /// # Returns
    ///
    /// 尚未开始发送的 [`SignalCheckerState`]。
    #[must_use]
    pub fn new(app: &AppHandle) -> Self {
        let emitter = app.clone();
        let sink: EventSink = Arc::new(move |event| forward_event(&emitter, event));
        let handle = tauri::async_runtime::handle().inner().clone();
        Self {
            sender: SignalSender::new(handle, sink),
            status_loop: AtomicBool::new(false),
        }
    }
}

/// `signal-checker:error` 事件载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    /// 出错时正在发送的 Universe。
    universe: Option<u16>,
    /// 系统给出的错误描述。
    message: String,
}

/// `signal-checker:preview` 事件载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewPayload {
    /// 被查看的 Universe。
    universe: u16,
    /// 512 个通道值。
    data: Vec<u8>,
}

/// 把发送器事件转成 Tauri 事件，只发给检测器窗口。
fn forward_event(app: &AppHandle, event: SenderEvent) {
    let _ = match event {
        SenderEvent::Error { universe, message } => app.emit_to(
            WINDOW_LABEL,
            "signal-checker:error",
            ErrorPayload { universe, message },
        ),
        SenderEvent::Preview { universe, data } => app.emit_to(
            WINDOW_LABEL,
            "signal-checker:preview",
            PreviewPayload { universe, data },
        ),
    };
}

/// 启动状态推送循环（已有循环在运行则什么也不做）；检测器窗口消失后循环自行退出。
fn spawn_status_loop(app: &AppHandle) {
    let state = app.state::<SignalCheckerState>();
    if state.status_loop.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(STATUS_INTERVAL);
        loop {
            tick.tick().await;
            if app.get_webview_window(WINDOW_LABEL).is_none() {
                break;
            }
            let status = app.state::<SignalCheckerState>().sender.status();
            let _ = app.emit_to(WINDOW_LABEL, "signal-checker:status", status);
        }
        app.state::<SignalCheckerState>()
            .status_loop
            .store(false, Ordering::Release);
    });
}

/// 检测器窗口的默认内部宽度（逻辑像素）。
const WINDOW_WIDTH: f64 = 900.0;
/// 检测器窗口的默认内部高度（逻辑像素）。
const WINDOW_HEIGHT: f64 = 700.0;

/// 一个矩形区域（逻辑像素）：左上角坐标与宽高。
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rect {
    /// 左上角 x。
    x: f64,
    /// 左上角 y。
    y: f64,
    /// 宽度。
    w: f64,
    /// 高度。
    h: f64,
}

/// 计算让检测器窗口在主窗口正中的左上角坐标；若会超出所在显示器则收回到显示器内。
///
/// # Arguments
///
/// * `main` - 主窗口的外框（逻辑像素）。
/// * `win_w` - 检测器窗口宽度（逻辑像素）。
/// * `win_h` - 检测器窗口高度（逻辑像素）。
/// * `screen` - 主窗口所在显示器的区域；未知传 `None`（不做收回）。
///
/// # Returns
///
/// 检测器窗口左上角的 `(x, y)`（逻辑像素）。显示器比窗口还小时贴齐显示器左上角。
fn centered_over(main: Rect, win_w: f64, win_h: f64, screen: Option<Rect>) -> (f64, f64) {
    let mut x = main.x + (main.w - win_w) / 2.0;
    let mut y = main.y + (main.h - win_h) / 2.0;
    if let Some(s) = screen {
        x = x.min(s.x + s.w - win_w).max(s.x);
        y = y.min(s.y + s.h - win_h).max(s.y);
    }
    (x, y)
}

/// 读取主窗口的当前位置，换算出让检测器窗口居中其上的坐标。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 检测器窗口左上角的 `(x, y)`（逻辑像素）。主窗口不存在、已最小化或读不到位置时返回 `None`。
fn position_over_main_window(app: &AppHandle) -> Option<(f64, f64)> {
    let main = app.get_webview_window("main")?;
    if main.is_minimized().unwrap_or(false) {
        return None;
    }
    let scale = main.scale_factor().ok()?;
    let pos = main.outer_position().ok()?.to_logical::<f64>(scale);
    let size = main.outer_size().ok()?.to_logical::<f64>(scale);
    let screen = main.current_monitor().ok().flatten().map(|m| {
        let s = m.scale_factor();
        let p = m.position().to_logical::<f64>(s);
        let z = m.size().to_logical::<f64>(s);
        Rect { x: p.x, y: p.y, w: z.width, h: z.height }
    });
    let main_rect = Rect { x: pos.x, y: pos.y, w: size.width, h: size.height };
    Some(centered_over(main_rect, WINDOW_WIDTH, WINDOW_HEIGHT, screen))
}

/// 打开信号检测器窗口；已打开则还原并聚焦（单例）。
///
/// 新建的窗口出现在主窗口正中（超出显示器时收回到显示器内）。
///
/// 定义为 `async` 命令：在 Windows 上同步命令里创建窗口可能死锁。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Errors
///
/// 窗口创建或聚焦失败时返回描述。
#[tauri::command]
pub async fn signal_checker_open(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        return window.set_focus().map_err(|e| e.to_string());
    }
    let builder = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::App(WINDOW_PAGE.into()))
        .title("Signal Checker")
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(800.0, 600.0);
    // 跟随主窗口：出现在主窗口正中；取不到主窗口位置（已最小化等）时退回屏幕居中
    let builder = match position_over_main_window(&app) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    builder
        // 与深色主题的页面底色一致，避免加载期间闪一下白屏
        .background_color(Color(9, 9, 11, 255))
        .build()
        .map_err(|e| e.to_string())?;
    spawn_status_loop(&app);
    Ok(())
}

/// 关闭检测器窗口（不存在则什么也不做）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
pub fn close_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

/// 窗口被销毁时的联动：主窗口销毁则关掉检测器窗口；检测器窗口销毁则停止发送（清零收尾）。
///
/// # Arguments
///
/// * `window` - 被销毁的窗口。
pub fn on_window_destroyed(window: &tauri::Window) {
    let app = window.app_handle();
    match window.label() {
        "main" => close_window(app),
        WINDOW_LABEL => {
            if let Some(state) = app.try_state::<SignalCheckerState>() {
                let sender = state.sender.clone();
                sender.set_preview(None);
                tauri::async_runtime::spawn(async move { sender.stop().await });
            }
        }
        _ => {}
    }
}

/// 读取发送器状态快照。
///
/// # Arguments
///
/// * `state` - 检测器状态。
///
/// # Returns
///
/// 当前 [`SenderStatus`]。
#[tauri::command]
pub fn signal_checker_status(state: State<'_, SignalCheckerState>) -> SenderStatus {
    state.sender.status()
}

/// 校验一份配置但不应用（供界面边输入边提示）。
///
/// # Arguments
///
/// * `config` - 用户填写的配置。
///
/// # Returns
///
/// 通过校验时返回将要发送的 Universe 数量。
///
/// # Errors
///
/// 配置不合法时返回 [`ConfigError`]。
#[tauri::command]
pub fn signal_checker_validate(config: SignalConfig) -> Result<usize, ConfigError> {
    config.validate().map(|valid| valid.universes.len())
}

/// 应用配置；发送中调用则下一个 tick 生效。
///
/// # Arguments
///
/// * `state` - 检测器状态。
/// * `config` - 用户填写的配置。
///
/// # Errors
///
/// 配置不合法时返回 [`ConfigError`]，原配置保持不变。
#[tauri::command]
pub fn signal_checker_configure(
    state: State<'_, SignalCheckerState>,
    config: SignalConfig,
) -> Result<(), ConfigError> {
    state.sender.configure(config)
}

/// 开始发送（已在发送则无操作）。
///
/// # Arguments
///
/// * `state` - 检测器状态。
///
/// # Errors
///
/// 无法创建发送套接字时返回 [`SenderError`]。
#[tauri::command]
pub async fn signal_checker_start(state: State<'_, SignalCheckerState>) -> Result<(), SenderError> {
    let sender = state.sender.clone();
    sender.start().await
}

/// 停止发送并等待清零 / 终止包发完。
///
/// # Arguments
///
/// * `state` - 检测器状态。
#[tauri::command]
pub async fn signal_checker_stop(state: State<'_, SignalCheckerState>) -> Result<(), String> {
    let sender = state.sender.clone();
    sender.stop().await;
    Ok(())
}

/// 切换自动 / 手动模式。
///
/// # Arguments
///
/// * `state` - 检测器状态。
/// * `mode` - 目标模式。
#[tauri::command]
pub fn signal_checker_set_mode(state: State<'_, SignalCheckerState>, mode: SendMode) {
    state.sender.set_mode(mode);
}

/// 选择测试图案。
///
/// # Arguments
///
/// * `state` - 检测器状态。
/// * `pattern` - 目标图案。
#[tauri::command]
pub fn signal_checker_set_pattern(state: State<'_, SignalCheckerState>, pattern: PatternId) {
    state.sender.set_pattern(pattern);
}

/// 设置倍速（夹紧到 0.25 到 4）。
///
/// # Arguments
///
/// * `state` - 检测器状态。
/// * `speed` - 请求的倍速。
#[tauri::command]
pub fn signal_checker_set_speed(state: State<'_, SignalCheckerState>, speed: f64) {
    state.sender.set_speed(speed);
}

/// 手动模式：设置单个通道。
///
/// # Arguments
///
/// * `state` - 检测器状态。
/// * `universe` - 目标 Universe。
/// * `channel` - 通道号，`1..=512`。
/// * `value` - 通道值。
///
/// # Errors
///
/// 通道号越界时返回 [`ManualError`]。
#[tauri::command]
pub fn signal_checker_set_channel(
    state: State<'_, SignalCheckerState>,
    universe: u16,
    channel: u16,
    value: u8,
) -> Result<(), ManualError> {
    state.sender.set_channel(universe, channel, value)
}

/// 手动模式：把某个 Universe 的 512 个通道设为同一个值。
///
/// # Arguments
///
/// * `state` - 检测器状态。
/// * `universe` - 目标 Universe。
/// * `value` - 通道值。
#[tauri::command]
pub fn signal_checker_set_all(state: State<'_, SignalCheckerState>, universe: u16, value: u8) {
    state.sender.set_all(universe, value);
}

/// 手动模式：清除手动数据。
///
/// # Arguments
///
/// * `state` - 检测器状态。
/// * `universe` - 只清除该 Universe；`None` 清除全部。
#[tauri::command]
pub fn signal_checker_clear(state: State<'_, SignalCheckerState>, universe: Option<u16>) {
    match universe {
        Some(u) => state.sender.clear_universe(u),
        None => state.sender.clear_all(),
    }
}

/// 列出全部图案的元数据（分组、是否静态、是否闪烁）。
///
/// # Returns
///
/// 按界面分组顺序排列的 [`PatternInfo`]。
#[tauri::command]
#[must_use]
pub fn signal_checker_list_patterns() -> Vec<PatternInfo> {
    signal_gen::all_patterns()
}

/// 设置要实时预览的 Universe（只有发送范围内的才会推送 `signal-checker:preview`）。
///
/// # Arguments
///
/// * `state` - 检测器状态。
/// * `universe` - 要查看的 Universe；`None` 关闭预览。
#[tauri::command]
pub fn signal_checker_set_preview(state: State<'_, SignalCheckerState>, universe: Option<u16>) {
    state.sender.set_preview(universe);
}

/// 读取某个 Universe 当前会发出的 512 通道内容（停止状态下也可用，供手动模式读回）。
///
/// # Arguments
///
/// * `state` - 检测器状态。
/// * `universe` - 要查看的 Universe。
///
/// # Returns
///
/// 512 个通道值。
#[tauri::command]
#[must_use]
pub fn signal_checker_frame(state: State<'_, SignalCheckerState>, universe: u16) -> Vec<u8> {
    state.sender.frame_for(universe).to_vec()
}

/// 目标 IP 候选项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetOption {
    /// IPv4 地址。
    pub ip: String,
    /// 可读名称：网卡名或设备名；本机回环与广播地址没有。
    pub name: Option<String>,
    /// 是否在线（仅设备有意义）。
    pub online: Option<bool>,
}

/// 按来源分组的目标 IP 候选项。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetGroups {
    /// 本机回环（`127.0.0.1`），用于回灌自测。
    pub local: Vec<TargetOption>,
    /// 本机各网卡的 IPv4 地址（发到自己的网卡 IP 也能被绑定在该网卡上的接收端收到）。
    pub interfaces: Vec<TargetOption>,
    /// 已发现的设备。
    pub devices: Vec<TargetOption>,
    /// 各网卡所在子网的定向广播地址与受限广播地址。
    pub broadcasts: Vec<TargetOption>,
}

/// 已发现设备的精简信息（与 `discovery::Device` 解耦，便于纯函数测试）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceLite {
    /// IPv4 地址。
    pub ip: String,
    /// 自定义名优先，其次主机名。
    pub name: Option<String>,
    /// 是否在线。
    pub online: bool,
}

/// 由网卡、广播地址和设备拼出分组候选项（纯函数）。
///
/// # Arguments
///
/// * `interfaces` - 本机网卡列表（含首项"全部接口 0.0.0.0"虚拟项，会被跳过）。
/// * `broadcasts` - 广播目标列表。
/// * `devices` - 已发现设备。
///
/// # Returns
///
/// 分组后的 [`TargetGroups`]：回环只在 `local`；设备在线的排前面，其后按 IP 排序；各组内无重复。
#[must_use]
pub fn build_targets(
    interfaces: &[NetworkInterfaceDto],
    broadcasts: &[Ipv4Addr],
    devices: &[DeviceLite],
) -> TargetGroups {
    let mut groups = TargetGroups {
        local: vec![TargetOption {
            ip: Ipv4Addr::LOCALHOST.to_string(),
            name: None,
            online: None,
        }],
        ..TargetGroups::default()
    };

    for nic in interfaces {
        if nic.ip == "0.0.0.0" || nic.is_loopback {
            continue;
        }
        if !groups.interfaces.iter().any(|o| o.ip == nic.ip) {
            groups.interfaces.push(TargetOption {
                ip: nic.ip.clone(),
                name: Some(nic.name.clone()),
                online: None,
            });
        }
    }

    let mut sorted: Vec<&DeviceLite> = devices.iter().collect();
    sorted.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.ip.cmp(&b.ip)));
    for d in sorted {
        if !groups.devices.iter().any(|o| o.ip == d.ip) {
            groups.devices.push(TargetOption {
                ip: d.ip.clone(),
                name: d.name.clone(),
                online: Some(d.online),
            });
        }
    }

    for b in broadcasts {
        let ip = b.to_string();
        if !groups.broadcasts.iter().any(|o| o.ip == ip) {
            groups.broadcasts.push(TargetOption { ip, name: None, online: None });
        }
    }
    groups
}

/// 列出目标 IP 候选项：本机、本机网卡、已发现设备、各网卡的广播地址。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 分组后的 [`TargetGroups`]。
#[tauri::command]
#[must_use]
pub fn signal_checker_targets(app: AppHandle) -> TargetGroups {
    let devices: Vec<DeviceLite> = app
        .artnet_core()
        .devices()
        .into_iter()
        .map(|d| DeviceLite {
            ip: d.ip,
            name: d.custom_name.or(d.hostname),
            online: d.online,
        })
        .collect();
    build_targets(
        &netif::list_interfaces(),
        &netif::broadcast_targets(),
        &devices,
    )
}

/// 界面做"发送前确认"与"自测提示"所需的运行环境快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckerContext {
    /// 应用当前的运行模式；播放器模式下实时接收已停止，发给本机的信号不会被接收。
    pub app_mode: AppMode,
    /// 单网卡模式下接收所绑定的接口（`0.0.0.0` 表示全部接口）。
    pub receive_interface: String,
    /// 是否为多网卡模式（接收分别绑定在各网卡的 IP 上）。
    pub multi_nic: bool,
    /// 转发表里启用的目的地数量。
    pub forwarding_enabled: usize,
    /// 本机全部 IPv4 地址（含回环），用来判断目标是不是"发给自己"。
    pub local_ips: Vec<String>,
}

/// 由各来源的数据拼出运行环境快照（纯函数）。
///
/// # Arguments
///
/// * `app_mode` - 应用运行模式。
/// * `network` - 网络设置。
/// * `forwarding_enabled` - 转发表里启用的目的地数量。
/// * `interfaces` - 本机网卡列表（含首项"全部接口 0.0.0.0"虚拟项，会被跳过）。
///
/// # Returns
///
/// 对应的 [`CheckerContext`]；`local_ips` 无重复。
#[must_use]
pub fn build_context(
    app_mode: AppMode,
    network: &settings::NetworkSettings,
    forwarding_enabled: usize,
    interfaces: &[NetworkInterfaceDto],
) -> CheckerContext {
    let mut local_ips: Vec<String> = Vec::new();
    for nic in interfaces {
        if nic.ip != "0.0.0.0" && !local_ips.contains(&nic.ip) {
            local_ips.push(nic.ip.clone());
        }
    }
    CheckerContext {
        app_mode,
        receive_interface: network.interface.clone(),
        multi_nic: network.mode == settings::NetworkMode::MultiNic,
        forwarding_enabled,
        local_ips,
    }
}

/// 读取运行环境快照：应用模式、接收网卡、转发表与本机地址。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 当前的 [`CheckerContext`]。
#[tauri::command]
#[must_use]
pub fn signal_checker_context(app: AppHandle) -> CheckerContext {
    let core = app.artnet_core();
    let enabled = core
        .forwarding()
        .destinations
        .iter()
        .filter(|d| d.enabled)
        .count();
    build_context(
        core.app_mode_status().mode,
        &app.settings_snapshot().network,
        enabled,
        &netif::list_interfaces(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn centered_over_main_window() {
        let main = rect(100.0, 50.0, 1400.0, 900.0);
        let screen = Some(rect(0.0, 0.0, 1920.0, 1080.0));
        assert_eq!(centered_over(main, 900.0, 700.0, screen), (350.0, 150.0));
    }

    #[test]
    fn clamped_into_the_monitor() {
        let screen = Some(rect(0.0, 0.0, 1920.0, 1080.0));
        // 主窗口贴在右下角：检测器窗口收回到显示器内
        let main = rect(1700.0, 900.0, 1000.0, 800.0);
        assert_eq!(centered_over(main, 900.0, 700.0, screen), (1020.0, 380.0));
        // 主窗口在左上角之外：贴齐显示器左上角
        let main = rect(-500.0, -300.0, 600.0, 400.0);
        assert_eq!(centered_over(main, 900.0, 700.0, screen), (0.0, 0.0));
    }

    #[test]
    fn unknown_monitor_skips_clamping() {
        let main = rect(0.0, 0.0, 500.0, 500.0);
        assert_eq!(centered_over(main, 900.0, 700.0, None), (-200.0, -100.0));
    }

    fn nic(name: &str, ip: &str, is_loopback: bool) -> NetworkInterfaceDto {
        NetworkInterfaceDto {
            name: name.into(),
            ip: ip.into(),
            is_loopback,
        }
    }

    fn dev(ip: &str, name: Option<&str>, online: bool) -> DeviceLite {
        DeviceLite {
            ip: ip.into(),
            name: name.map(str::to_string),
            online,
        }
    }

    #[test]
    fn targets_are_grouped_and_loopback_only_appears_under_local() {
        let g = build_targets(
            &[
                nic("全部接口", "0.0.0.0", false),
                nic("Loopback", "127.0.0.1", true),
                nic("Ethernet", "192.168.1.10", false),
                nic("Ethernet", "192.168.1.10", false), // 重复
                nic("Wi-Fi", "10.0.0.5", false),
            ],
            &[Ipv4Addr::new(192, 168, 1, 255), Ipv4Addr::BROADCAST, Ipv4Addr::BROADCAST],
            &[],
        );
        assert_eq!(g.local.len(), 1);
        assert_eq!(g.local[0].ip, "127.0.0.1");
        let nics: Vec<_> = g.interfaces.iter().map(|o| o.ip.as_str()).collect();
        assert_eq!(nics, ["192.168.1.10", "10.0.0.5"]);
        assert_eq!(g.interfaces[0].name.as_deref(), Some("Ethernet"));
        let bcast: Vec<_> = g.broadcasts.iter().map(|o| o.ip.as_str()).collect();
        assert_eq!(bcast, ["192.168.1.255", "255.255.255.255"]);
        assert!(g.devices.is_empty());
    }

    #[test]
    fn online_devices_come_first_then_sort_by_ip() {
        let g = build_targets(
            &[],
            &[],
            &[
                dev("10.0.0.9", Some("舞台灯"), false),
                dev("10.0.0.20", None, true),
                dev("10.0.0.3", Some("节点"), true),
                dev("10.0.0.3", Some("重复"), true),
            ],
        );
        let ips: Vec<_> = g.devices.iter().map(|o| o.ip.as_str()).collect();
        assert_eq!(ips, ["10.0.0.20", "10.0.0.3", "10.0.0.9"]);
        assert_eq!(g.devices[1].name.as_deref(), Some("节点"));
        assert_eq!(g.devices[2].online, Some(false));
    }

    #[test]
    fn payloads_serialize_in_camel_case() {
        let err = serde_json::to_value(ErrorPayload {
            universe: Some(3),
            message: "x".into(),
        })
        .unwrap();
        assert_eq!(err, serde_json::json!({ "universe": 3, "message": "x" }));

        let g = serde_json::to_value(build_targets(&[], &[], &[])).unwrap();
        assert_eq!(
            g,
            serde_json::json!({
                "local": [{ "ip": "127.0.0.1", "name": null, "online": null }],
                "interfaces": [], "devices": [], "broadcasts": []
            })
        );
    }

    #[test]
    fn validate_reports_the_universe_count_or_the_error() {
        let ok = SignalConfig {
            universes: "0-9".into(),
            ..SignalConfig::default()
        };
        assert_eq!(signal_checker_validate(ok), Ok(10));
        let bad = SignalConfig {
            universes: "x".into(),
            ..SignalConfig::default()
        };
        assert!(matches!(
            signal_checker_validate(bad),
            Err(ConfigError::InvalidRange { .. })
        ));
    }

    #[test]
    fn context_lists_local_ips_without_the_all_interfaces_placeholder() {
        let net = settings::NetworkSettings {
            interface: "192.168.1.10".into(),
            ..settings::NetworkSettings::default()
        };
        let ctx = build_context(
            AppMode::Live,
            &net,
            2,
            &[
                nic("全部接口", "0.0.0.0", false),
                nic("Loopback", "127.0.0.1", true),
                nic("Ethernet", "192.168.1.10", false),
                nic("Ethernet", "192.168.1.10", false),
            ],
        );
        assert_eq!(ctx.local_ips, ["127.0.0.1", "192.168.1.10"]);
        assert_eq!(ctx.receive_interface, "192.168.1.10");
        assert!(!ctx.multi_nic);
        assert_eq!(ctx.forwarding_enabled, 2);
        assert_eq!(ctx.app_mode, AppMode::Live);
    }

    #[test]
    fn context_reports_multi_nic_mode_and_serializes_in_camel_case() {
        let net = settings::NetworkSettings {
            mode: settings::NetworkMode::MultiNic,
            ..settings::NetworkSettings::default()
        };
        let ctx = build_context(AppMode::Player, &net, 0, &[]);
        assert!(ctx.multi_nic);
        assert_eq!(
            serde_json::to_value(&ctx).unwrap(),
            serde_json::json!({
                "appMode": "player",
                "receiveInterface": net.interface,
                "multiNic": true,
                "forwardingEnabled": 0,
                "localIps": []
            })
        );
    }

    #[test]
    fn pattern_catalog_is_exposed_unchanged() {
        assert_eq!(signal_checker_list_patterns().len(), 15);
    }
}
