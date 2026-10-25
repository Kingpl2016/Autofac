//! Tauri 命令：应用运行模式（实时 / 播放器）。
//!
//! 命令只做"提取 → 调用领域 → 返回 DTO"；切换顺序与互斥由 `host-core` 的 `ModeManager` 负责。

use std::sync::Arc;

use host_core::app_mode::{AppMode, ModeStatus};
use host_core::recording::Emitter;
use host_core::ArtnetCoreExt;
use tauri::{AppHandle, Emitter as _};

/// 读取当前应用模式状态。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 当前模式、接收任务状态与发送器状态的 [`ModeStatus`]。
#[tauri::command]
pub fn app_mode_get(app: AppHandle) -> ModeStatus {
    app.artnet_core().app_mode_status()
}

/// 切换应用模式（实时 / 播放器）。
///
/// 定义为 `async` 命令，保证在 Tokio 上下文中执行（重建接收套接字需要 reactor）。
/// 录制进行中不能进入播放器模式：前端应先调用 `recording_stop` 再切换。
/// 目标等于当前模式时是幂等的；实时模式下若接收曾绑定失败，会再次尝试重建（供"重试"使用）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `mode` - 目标模式。
///
/// # Returns
///
/// 切换完成后的 [`ModeStatus`]。
///
/// # Errors
///
/// 已有切换正在进行（`transition_in_progress`）或录制进行中（`recording_active`）。
#[tauri::command]
pub async fn app_mode_set(app: AppHandle, mode: AppMode) -> Result<ModeStatus, String> {
    let emit: Emitter = Arc::new({
        let app = app.clone();
        move |name, payload| {
            let _ = app.emit(name, payload);
        }
    });
    app.artnet_core().set_app_mode(mode, &emit)
}

/// 退出应用前做安全收尾，然后退出：先卸载节目，再停止并保存进行中的录制，最后退出进程。
///
/// 窗口关闭请求在录制或播放进行中会被拦下并通知前端（`app:close-requested`），
/// 用户确认后由前端调用本命令。这样录制文件总是被完整收尾为合法的 `.artrec`，
/// 而不是留给下次启动去恢复 `.part`。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Errors
///
/// 收尾失败（例如录制线程异常退出）时返回描述；此时仍会退出，错误只用于提示。
#[tauri::command]
pub async fn app_quit(app: AppHandle) -> Result<(), String> {
    let core = app.artnet_core();
    core.playback().close();
    let mut result = Ok(());
    if core.recording().is_recording() {
        let ctl = core.recording().clone();
        result = tauri::async_runtime::spawn_blocking(move || ctl.stop())
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r.map(|_| ()));
    }
    app.exit(0);
    result
}
