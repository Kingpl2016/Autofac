//! Tauri 命令：外接控制器连接、指令控制与文件 CRUD（应用壳薄封装）。
//!
//! 控制器逻辑位于 `controller` crate 的 [`controller::ControllerHandle`]（异步方法、含连接状态），
//! 本模块只做"提取 State → 调用句柄 → 返回 DTO"。句柄由应用壳在 setup 中 `manage`。

use std::path::Path;

use controller::{ControllerConfig, ControllerHandle, ControllerStatus, FileEntry};
use tauri::{AppHandle, State};

use crate::recording_commands::resolved_dir;

/// 读取当前控制器连接状态。
#[tauri::command]
pub fn controller_get_status(state: State<'_, ControllerHandle>) -> ControllerConfig {
    state.config()
}

/// 配置目标并探测连接（读取工作模式）。
///
/// # Errors
///
/// 连接或读取失败时返回错误字符串。
#[tauri::command]
pub async fn controller_connect(
    state: State<'_, ControllerHandle>,
    host: String,
    tcp_port: u16,
    http_port: u16,
) -> Result<ControllerStatus, String> {
    ControllerHandle::clone(&state)
        .connect(host, tcp_port, http_port)
        .await
}

/// 断开（标记未连接）。
#[tauri::command]
pub fn controller_disconnect(state: State<'_, ControllerHandle>) {
    state.disconnect();
}

/// 设备操作（0 复位 / 1 出厂 / 2 测试）。
///
/// # Errors
///
/// 非法操作码、未配置或发送失败时返回错误字符串。
#[tauri::command]
pub async fn controller_board_op(state: State<'_, ControllerHandle>, op: u8) -> Result<(), String> {
    ControllerHandle::clone(&state).board_op(op).await
}

/// 设置工作模式（0~5）。
///
/// # Errors
///
/// 非法模式或发送失败返回错误字符串。
#[tauri::command]
pub async fn controller_set_work_mode(
    state: State<'_, ControllerHandle>,
    mode: u8,
) -> Result<(), String> {
    ControllerHandle::clone(&state).set_work_mode(mode).await
}

/// 读取工作模式。
///
/// # Errors
///
/// 发送失败或无应答返回错误字符串。
#[tauri::command]
pub async fn controller_get_work_mode(state: State<'_, ControllerHandle>) -> Result<u8, String> {
    ControllerHandle::clone(&state).get_work_mode().await
}

/// 节目文件操作（programNo + action 0~5）。
///
/// # Errors
///
/// 非法动作或发送失败返回错误字符串。
#[tauri::command]
pub async fn controller_program_op(
    state: State<'_, ControllerHandle>,
    program_no: u8,
    action: u8,
) -> Result<(), String> {
    ControllerHandle::clone(&state)
        .program_op(program_no, action)
        .await
}

/// 写通道。
///
/// # Errors
///
/// 发送失败返回错误字符串。
#[tauri::command]
pub async fn controller_write_channels(
    state: State<'_, ControllerHandle>,
    start: u8,
    unit_count: u8,
    unit_run: u8,
    values: Vec<u8>,
) -> Result<(), String> {
    ControllerHandle::clone(&state)
        .write_channels(start, unit_count, unit_run, &values)
        .await
}

/// 读通道，返回应答帧中的数据。
///
/// # Errors
///
/// 发送失败或无应答返回错误字符串。
#[tauri::command]
pub async fn controller_read_channels(
    state: State<'_, ControllerHandle>,
    start: u8,
    unit_count: u8,
    unit_run: u8,
) -> Result<Vec<u8>, String> {
    ControllerHandle::clone(&state)
        .read_channels(start, unit_count, unit_run)
        .await
}

/// 列出设备 SD 卡文件。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn controller_list_files(
    state: State<'_, ControllerHandle>,
) -> Result<Vec<FileEntry>, String> {
    ControllerHandle::clone(&state).list_files().await
}

/// 下载文件字节（经 IPC 二进制通道，避免 JSON 数字数组膨胀）。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn controller_download_file(
    state: State<'_, ControllerHandle>,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = ControllerHandle::clone(&state).download_file(&name).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 上传/覆盖文件。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn controller_upload_file(
    state: State<'_, ControllerHandle>,
    name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    ControllerHandle::clone(&state).upload_file(&name, data).await
}

/// 删除文件。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn controller_delete_file(
    state: State<'_, ControllerHandle>,
    name: String,
) -> Result<(), String> {
    ControllerHandle::clone(&state).delete_file(&name).await
}

/// 重命名文件。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn controller_rename_file(
    state: State<'_, ControllerHandle>,
    from: String,
    to: String,
) -> Result<(), String> {
    ControllerHandle::clone(&state).rename_file(&from, &to).await
}

/// 把节目库里的 `.artrec` 上传到控制器 SD 卡（后端直接读盘，避免大文件走 IPC）。
///
/// 这是"节目库 → 设备"的跨域桥接：路径来自录制库，传输经控制器句柄。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄（解析录制目录）。
/// * `state` - 控制器句柄。
/// * `path` - 节目库中的 `.artrec` 路径，必须位于录制目录内。
///
/// # Returns
///
/// 上传到 SD 卡后的文件名。
///
/// # Errors
///
/// 未配置控制器、路径非法、读盘失败或请求失败时返回错误字符串。
#[tauri::command]
pub async fn controller_upload_recording(
    app: AppHandle,
    state: State<'_, ControllerHandle>,
    path: String,
) -> Result<String, String> {
    let handle = ControllerHandle::clone(&state);
    let dir = resolved_dir(&app);
    let file = recorder::resolve_in_dir(&dir, Path::new(&path)).map_err(|e| e.to_string())?;
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("文件名无效")?
        .to_string();
    let data = std::fs::read(&file).map_err(|e| e.to_string())?;
    handle.upload_file(&name, data).await?;
    Ok(name)
}
