//! Tauri 命令：录制控制、来源统计与启动恢复结果。
//!
//! 命令只做"提取 → 调用领域 → 返回 DTO"；录制逻辑位于 `recording` 模块与 `recorder` crate。

use std::path::PathBuf;

use std::sync::Arc;

use recorder::{LibraryEntry, LibraryError, RecoveryOutcome};
use signal_engine::SourceStat;
use tauri::{AppHandle, Emitter as _, Manager, State};

use crate::recording::{
    resolve_dir, Emitter, RecordingResult, RecordingStartArgs, RecordingStartResult,
    RecordingStatus,
};
use crate::state::AppState;
use crate::util::lock;

/// 默认录制目录：文档目录下的 `ArtNet Studio Recordings`，取不到时回落到应用数据目录。
fn default_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .map(|d| d.join("ArtNet Studio Recordings"))
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("recordings")))
        .unwrap_or_else(|_| PathBuf::from("recordings"))
}

/// 按配置解析实际录制目录。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析默认录制目录。
/// * `configured` - 配置中的录制目录；为空表示使用默认目录。
///
/// # Returns
///
/// 配置非空时为配置的目录，否则为默认录制目录。
#[must_use]
pub fn recording_dir(app: &AppHandle, configured: &str) -> PathBuf {
    resolve_dir(configured, &default_dir(app))
}

/// 返回当前生效的录制目录（配置为空时是默认目录）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `state` - 应用状态。
///
/// # Returns
///
/// 当前生效的录制目录路径字符串。
///
/// # Errors
///
/// 配置锁中毒时返回错误字符串。
#[tauri::command]
pub fn get_recording_dir(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    Ok(resolved_dir(&app, &state).to_string_lossy().into_owned())
}

/// 当前来源（按 IP 聚合）统计，供录制来源选择器初始渲染。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 按来源 IP 聚合的 [`SourceStat`] 列表。
#[tauri::command]
pub fn get_source_stats(state: State<'_, AppState>) -> Vec<SourceStat> {
    state.runtime.source_stats()
}

/// 开始录制。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录与发射事件。
/// * `state` - 应用状态。
/// * `args` - 前端提交的录制参数。
///
/// # Returns
///
/// 最终文件路径与 Universe 规划结果。
///
/// # Errors
///
/// 已在录制（`already_recording`）、没有可录制的 Universe（`no_universes`）
/// 或目录不可写等落盘错误。
#[tauri::command]
pub fn recording_start(
    app: AppHandle,
    state: State<'_, AppState>,
    args: RecordingStartArgs,
) -> Result<RecordingStartResult, String> {
    crate::playback_commands::ensure_not_playing(&state)?;
    let cfg = lock(&state.settings).clone();
    let dir = recording_dir(&app, &cfg.recording.directory);
    let snapshot = state.runtime.snapshot();
    let emit: Emitter = Arc::new(move |name, payload| {
        let _ = app.emit(name, payload);
    });
    state
        .runtime
        .recording()
        .start(emit, &cfg, dir, &snapshot, args)
}

/// 停止录制并等待文件收尾完成。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 本次录制的最终 [`RecordingResult`]（已完成的文件、致命错误与丢帧数）。
///
/// # Errors
///
/// 当前没有进行中的录制（`not_recording`）或录制线程异常退出。
#[tauri::command]
pub async fn recording_stop(state: State<'_, AppState>) -> Result<RecordingResult, String> {
    let ctl = state.runtime.recording().clone();
    tauri::async_runtime::spawn_blocking(move || ctl.stop())
        .await
        .map_err(|e| e.to_string())?
}

/// 当前录制状态快照。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 当前的 [`RecordingStatus`]。
#[tauri::command]
pub fn recording_status(state: State<'_, AppState>) -> RecordingStatus {
    state.runtime.recording().status()
}

/// 错误码：目标名称已存在。
pub const LIB_ERR_EXISTS: &str = "already_exists";
/// 错误码：路径不在录制目录内。
pub const LIB_ERR_OUTSIDE: &str = "outside_library";
/// 错误码：文件不存在。
pub const LIB_ERR_NOT_FOUND: &str = "not_found";

/// 把库错误转换为前端可翻译的错误码（其余原样返回描述）。
fn lib_err(e: LibraryError) -> String {
    match e {
        LibraryError::AlreadyExists => LIB_ERR_EXISTS.to_string(),
        LibraryError::OutsideLibrary => LIB_ERR_OUTSIDE.to_string(),
        LibraryError::NotFound => LIB_ERR_NOT_FOUND.to_string(),
        LibraryError::Io(e) => e.to_string(),
    }
}

/// 解析当前生效的录制目录：锁配置并在配置为空时回落默认目录。
///
/// 所有"需要知道录制目录"的命令（节目库列举/重命名/删除、回放路径校验、上传核心板）
/// 统一走此函数，避免分散的"锁配置 → 解析目录"样板。
#[must_use]
pub fn resolved_dir(app: &AppHandle, state: &State<'_, AppState>) -> PathBuf {
    let cfg = lock(&state.settings);
    recording_dir(app, &cfg.recording.directory)
}

/// 列出节目库（按修改时间从新到旧）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录。
/// * `state` - 应用状态。
///
/// # Returns
///
/// 录制目录下全部节目的 [`LibraryEntry`] 列表，按修改时间从新到旧排序。
///
/// # Errors
///
/// 配置锁中毒时返回错误字符串。
#[tauri::command]
pub fn recordings_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<LibraryEntry>, String> {
    let dir = resolved_dir(&app, &state);
    Ok(recorder::list_library(&dir))
}

/// 重命名节目，返回新路径。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录。
/// * `state` - 应用状态。
/// * `path` - 待重命名节目的路径，须位于录制目录内。
/// * `new_name` - 新显示名；文件名由它规整得到。
///
/// # Returns
///
/// 重命名后节目文件的新路径字符串。
///
/// # Errors
///
/// 路径不在录制目录内（`outside_library`）、目标已存在（`already_exists`）、
/// 文件不存在（`not_found`）或文件系统失败。
#[tauri::command]
pub fn recordings_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let dir = resolved_dir(&app, &state);
    recorder::rename_recording(&dir, std::path::Path::new(&path), &new_name)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(lib_err)
}

/// 删除节目及其 sidecar。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录。
/// * `state` - 应用状态。
/// * `path` - 待删除节目的路径，须位于录制目录内。
///
/// # Errors
///
/// 同 [`recordings_rename`]。
#[tauri::command]
pub fn recordings_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let dir = resolved_dir(&app, &state);
    recorder::delete_recording(&dir, std::path::Path::new(&path)).map_err(lib_err)
}

/// 取走应用启动时恢复出的孤立录制结果（取走后清空，只提示一次）。
///
/// # Arguments
///
/// * `state` - 应用状态。
///
/// # Returns
///
/// 启动时恢复的 [`RecoveryOutcome`] 列表；没有或已被取走时为空。
#[tauri::command]
pub fn recording_take_recovered(state: State<'_, AppState>) -> Vec<RecoveryOutcome> {
    state.runtime.recording().take_recovered()
}
