//! Tauri 命令：录制控制、节目库管理与启动恢复结果。
//!
//! 命令只做"提取 → 调用领域 → 返回 DTO"；录制控制器位于 `host-core` 插件（经
//! [`host_core::ArtnetCoreExt`] 访问），落盘逻辑位于 `recorder` crate。

use std::path::PathBuf;
use std::sync::Arc;

use recorder::{LibraryEntry, LibraryError, RecoveryOutcome};
use tauri::{AppHandle, Emitter as _, Manager};
use tauri_plugin_opener::OpenerExt as _;

use host_core::recording::{
    DirCheck, DiskInfo, Emitter, RecordingResult, RecordingStartArgs, RecordingStartResult,
    RecordingStatus,
};
use host_core::ArtnetCoreExt;
use host_core::SettingsExt;

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
    host_core::recording::resolve_dir(configured, &default_dir(app))
}

/// 解析当前生效的录制目录（配置为空时回落默认目录）。
///
/// 所有"需要知道录制目录"的命令（节目库列举/重命名/删除、回放路径校验、上传核心板）统一走此函数。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 当前生效的录制目录。
#[must_use]
pub fn resolved_dir(app: &AppHandle) -> PathBuf {
    let cfg = app.settings_snapshot();
    recording_dir(app, &cfg.recording.directory)
}

/// 返回当前生效的录制目录（配置为空时是默认目录）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 当前生效的录制目录路径字符串。
///
/// # Errors
///
/// 恒为 `Ok`（保留 `Result` 以兼容前端签名）。
#[tauri::command]
pub fn get_recording_dir(app: AppHandle) -> Result<String, String> {
    Ok(resolved_dir(&app).to_string_lossy().into_owned())
}

/// 检查一个候选录制目录（设置页在用户选定 / 编辑目录后调用）。
///
/// 只读探测，不会创建目录。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `path` - 要检查的目录；为空则检查当前生效的录制目录（含默认目录）。
///
/// # Returns
///
/// 目录是否存在、是否可写以及所在卷剩余空间的 [`DirCheck`]。
#[tauri::command]
pub fn recording_check_dir(app: AppHandle, path: Option<String>) -> DirCheck {
    let dir = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => resolved_dir(&app),
    };
    app.artnet_core().recording().check_dir(&dir)
}

/// 错误码：要打开的路径不是目录。
pub const ERR_NOT_A_DIRECTORY: &str = "not_a_directory";

/// 在系统文件管理器中打开录制目录。
///
/// 由后端打开而不是前端直接调用 opener 插件，是为了不向前端放开任意路径的打开权限：
/// 这里**只打开目录**，传入的路径若是文件（打开文件可能执行它）一律拒绝。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `path` - 要打开的目录（设置页里尚未保存的草稿路径）；为空则打开当前生效的录制目录，
///   且目录不存在时先创建。传入的非空路径必须是已存在的目录。
///
/// # Errors
///
/// 路径不是已存在的目录返回 [`ERR_NOT_A_DIRECTORY`]；默认目录无法创建或系统无法打开时返回错误描述。
#[tauri::command]
pub fn recording_open_dir(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let dir = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            let dir = PathBuf::from(p);
            if !dir.is_dir() {
                return Err(ERR_NOT_A_DIRECTORY.to_string());
            }
            dir
        }
        _ => {
            let dir = resolved_dir(&app);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            dir
        }
    };
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 查询录制目录所在卷的剩余空间。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `path` - 要查询的目录；为空则查询当前生效的录制目录。设置页在用户编辑目录时用它预览新目录。
///
/// # Returns
///
/// 剩余字节数、等级与是否允许开始录制的 [`DiskInfo`]；无法查询时 `free_bytes` 为 `None`。
#[tauri::command]
pub fn recording_disk_info(app: AppHandle, path: Option<String>) -> DiskInfo {
    let dir = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => resolved_dir(&app),
    };
    app.artnet_core().recording().disk_info(&dir)
}

/// 开始录制。
///
/// 创建文件、写文件头与磁盘空间检查都在 `spawn_blocking` 线程上执行，不占用主线程。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录、访问运行时与发射事件。
/// * `args` - 前端提交的录制参数。
///
/// # Returns
///
/// 最终文件路径与 Universe 规划结果。
///
/// # Errors
///
/// 回放进行中（`playback_active`）、已在录制（`already_recording`）、
/// 没有可录制的 Universe（`no_universes`）或目录不可写等落盘错误。
#[tauri::command]
pub async fn recording_start(
    app: AppHandle,
    args: RecordingStartArgs,
) -> Result<RecordingStartResult, String> {
    tauri::async_runtime::spawn_blocking(move || start_blocking(&app, args))
        .await
        .map_err(|e| e.to_string())?
}

/// [`recording_start`] 的阻塞实现体。
///
/// 持有 `playback_commands::session_gate` 完成"回放互斥检查 + 开始录制"，与打开节目串行。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `args` - 前端提交的录制参数。
///
/// # Returns
///
/// 最终文件路径与 Universe 规划结果。
///
/// # Errors
///
/// 同 [`recording_start`]。
fn start_blocking(
    app: &AppHandle,
    args: RecordingStartArgs,
) -> Result<RecordingStartResult, String> {
    let _gate = crate::playback_commands::session_gate();
    crate::playback_commands::ensure_not_playing(app)?;
    let cfg = app.settings_snapshot();
    let dir = recording_dir(app, &cfg.recording.directory);
    let core = app.artnet_core();
    let snapshot = core.snapshot();
    let emit: Emitter = Arc::new({
        let app = app.clone();
        move |name, payload| {
            let _ = app.emit(name, payload);
        }
    });
    core.recording().start(emit, &cfg, dir, &snapshot, args)
}

/// 停止录制并等待文件收尾完成。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 本次录制的最终 [`RecordingResult`]（已完成的文件、致命错误与丢帧数）。
///
/// # Errors
///
/// 当前没有进行中的录制（`not_recording`）或录制线程异常退出。
#[tauri::command]
pub async fn recording_stop(app: AppHandle) -> Result<RecordingResult, String> {
    let ctl = app.artnet_core().recording().clone();
    tauri::async_runtime::spawn_blocking(move || ctl.stop())
        .await
        .map_err(|e| e.to_string())?
}

/// 当前录制状态快照。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 当前的 [`RecordingStatus`]。
#[tauri::command]
pub fn recording_status(app: AppHandle) -> RecordingStatus {
    app.artnet_core().recording().status()
}

/// 错误码：目标名称已存在。
pub const LIB_ERR_EXISTS: &str = "already_exists";
/// 错误码：路径不在录制目录内。
pub const LIB_ERR_OUTSIDE: &str = "outside_library";
/// 错误码：文件不存在。
pub const LIB_ERR_NOT_FOUND: &str = "not_found";
/// 错误码前缀：无法移入系统回收站（后面跟冒号和系统给出的原因）。
pub const LIB_ERR_TRASH: &str = "trash_failed";

/// 把库错误转换为前端可翻译的错误码（其余原样返回描述）。
fn lib_err(e: LibraryError) -> String {
    match e {
        LibraryError::AlreadyExists => LIB_ERR_EXISTS.to_string(),
        LibraryError::OutsideLibrary => LIB_ERR_OUTSIDE.to_string(),
        LibraryError::NotFound => LIB_ERR_NOT_FOUND.to_string(),
        LibraryError::Trash(m) => format!("{LIB_ERR_TRASH}: {m}"),
        LibraryError::Io(e) => e.to_string(),
    }
}

/// 列出节目库（按修改时间从新到旧）。
///
/// 在 `spawn_blocking` 线程上执行；经 recorder 的进程级节目库缓存，只重读有变化的文件。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录。
///
/// # Returns
///
/// 录制目录下全部节目的 [`LibraryEntry`] 列表，按修改时间从新到旧排序。
///
/// # Errors
///
/// 仅当阻塞任务异常结束（panic 或运行时关闭）时返回描述；正常情况恒为 `Ok`。
#[tauri::command]
pub async fn recordings_list(app: AppHandle) -> Result<Vec<LibraryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || recorder::list_library(&resolved_dir(&app)))
        .await
        .map_err(|e| e.to_string())
}

/// 重命名节目（连同 sidecar 与概览缓存），返回新路径。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录。
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
pub async fn recordings_rename(
    app: AppHandle,
    path: String,
    new_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = resolved_dir(&app);
        recorder::rename_recording(&dir, std::path::Path::new(&path), &new_name)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(lib_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除节目及其 sidecar 与概览缓存（一并移入系统回收站）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录。
/// * `path` - 待删除节目的路径，须位于录制目录内。
///
/// # Errors
///
/// 同 [`recordings_rename`]；无法移入回收站时为 `trash_failed: <原因>`。
#[tauri::command]
pub async fn recordings_delete(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        recorder::delete_recording(&resolved_dir(&app), std::path::Path::new(&path))
            .map_err(lib_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 取走应用启动时恢复出的孤立录制结果（取走后清空，只提示一次）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 启动时恢复的 [`RecoveryOutcome`] 列表；没有或已被取走时为空。
#[tauri::command]
pub fn recording_take_recovered(app: AppHandle) -> Vec<RecoveryOutcome> {
    app.artnet_core().recording().take_recovered()
}
