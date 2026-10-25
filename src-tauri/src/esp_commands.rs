//! ESP32-P4 核心板相关 Tauri 命令：连接、指令控制与文件 CRUD。
//!
//! 控制指令走 TCP 1227；文件 CRUD 走 HTTP（见 `esp32-link` transport）。
//! 写类指令采用 fire-and-forget（不等应答）以避免固件未应答时阻塞；读类等待应答。

use serde::Serialize;
use tauri::State;

use esp32_link::registers::{BoardOp, ProgramAction};
use esp32_link::{
    board_op, get_work_mode, program_op, read_channels, set_work_mode, tcp, write_channels,
    DeviceTransport, FileEntry, Frame, HttpTransport, WorkMode,
};

use crate::esp::EspConfig;
use crate::state::AppState;

/// 控制指令超时（毫秒）。
const CTRL_TIMEOUT_MS: u64 = 1500;

/// 连接探测结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EspStatus {
    /// 连接配置与状态。
    pub config: EspConfig,
    /// 探测到的当前工作模式（若可读）。
    pub work_mode: Option<u8>,
}

fn target(state: &State<'_, AppState>) -> Result<(String, u16, u16), String> {
    let c = state.esp.config();
    if c.host.trim().is_empty() {
        return Err("未配置核心板地址".to_string());
    }
    Ok((c.host, c.tcp_port, c.http_port))
}

/// 发送一条控制帧（fire-and-forget，不等待应答）。
///
/// 写类指令统一走此路径：未配置目标或发送失败时返回错误字符串。
async fn send_ctrl(state: &State<'_, AppState>, frame: Vec<u8>) -> Result<(), String> {
    let (host, port, _) = target(state)?;
    tcp::send_command(&host, port, &frame, false, CTRL_TIMEOUT_MS)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 发送一条查询帧并等待应答帧。
///
/// 读类指令统一走此路径：未配置目标或发送失败时返回错误字符串，无应答返回 `Ok(None)`。
async fn send_query(state: &State<'_, AppState>, frame: Vec<u8>) -> Result<Option<Frame>, String> {
    let (host, port, _) = target(state)?;
    tcp::send_command(&host, port, &frame, true, CTRL_TIMEOUT_MS)
        .await
        .map_err(|e| e.to_string())
}

/// 读取当前核心板连接状态。
#[tauri::command]
pub fn esp_get_status(state: State<'_, AppState>) -> EspConfig {
    state.esp.config()
}

/// 配置目标并探测连接（读取工作模式）。
///
/// # Errors
///
/// 连接或读取失败时返回错误字符串（并将连接状态置为未连接）。
#[tauri::command]
pub async fn esp_connect(
    state: State<'_, AppState>,
    host: String,
    tcp_port: u16,
    http_port: u16,
) -> Result<EspStatus, String> {
    state.esp.set_target(host.clone(), tcp_port, http_port);
    let frame = get_work_mode();
    match tcp::send_command(&host, tcp_port, &frame, true, CTRL_TIMEOUT_MS).await {
        Ok(resp) => {
            state.esp.set_connected(true);
            Ok(EspStatus {
                config: state.esp.config(),
                work_mode: resp.and_then(|f| f.data.first().copied()),
            })
        }
        Err(e) => {
            state.esp.set_connected(false);
            Err(e.to_string())
        }
    }
}

/// 断开（标记未连接）。
#[tauri::command]
pub fn esp_disconnect(state: State<'_, AppState>) {
    state.esp.set_connected(false);
}

/// 核心板操作（0 复位 / 1 出厂 / 2 测试）。
///
/// # Errors
///
/// 未配置或发送失败时返回错误字符串。
#[tauri::command]
pub async fn esp_board_op(state: State<'_, AppState>, op: u8) -> Result<(), String> {
    let b = BoardOp::try_from(op).map_err(|()| "非法核心板操作码".to_string())?;
    send_ctrl(&state, board_op(b)).await
}

/// 设置工作模式（0~5）。
///
/// # Errors
///
/// 非法模式或发送失败返回错误字符串。
#[tauri::command]
pub async fn esp_set_work_mode(state: State<'_, AppState>, mode: u8) -> Result<(), String> {
    let m = WorkMode::from_u8(mode).ok_or("非法工作模式")?;
    send_ctrl(&state, set_work_mode(m)).await
}

/// 读取工作模式。
///
/// # Errors
///
/// 发送失败或无应答返回错误字符串。
#[tauri::command]
pub async fn esp_get_work_mode(state: State<'_, AppState>) -> Result<u8, String> {
    let resp = send_query(&state, get_work_mode()).await?;
    resp.and_then(|f| f.data.first().copied())
        .ok_or_else(|| "核心板未返回工作模式".to_string())
}

/// 节目文件操作（programNo + action 0~5）。
///
/// # Errors
///
/// 非法动作或发送失败返回错误字符串。
#[tauri::command]
pub async fn esp_program_op(
    state: State<'_, AppState>,
    program_no: u8,
    action: u8,
) -> Result<(), String> {
    let a = ProgramAction::try_from(action).map_err(|()| "非法节目操作码".to_string())?;
    send_ctrl(&state, program_op(program_no, a)).await
}

/// 写通道。
///
/// # Errors
///
/// 发送失败返回错误字符串。
#[tauri::command]
pub async fn esp_write_channels(
    state: State<'_, AppState>,
    start: u8,
    unit_count: u8,
    unit_run: u8,
    values: Vec<u8>,
) -> Result<(), String> {
    send_ctrl(&state, write_channels(start, unit_count, unit_run, &values)).await
}

/// 读通道，返回应答帧中的数据。
///
/// # Errors
///
/// 发送失败或无应答返回错误字符串。
#[tauri::command]
pub async fn esp_read_channels(
    state: State<'_, AppState>,
    start: u8,
    unit_count: u8,
    unit_run: u8,
) -> Result<Vec<u8>, String> {
    let resp = send_query(&state, read_channels(start, unit_count, unit_run)).await?;
    Ok(resp.map(|f| f.data).unwrap_or_default())
}

// ---- 文件 CRUD（HTTP） ----

fn http(state: &State<'_, AppState>) -> Result<HttpTransport, String> {
    let (host, _, http_port) = target(state)?;
    Ok(HttpTransport::new(&host, http_port))
}

/// 列出核心板 SD 卡文件。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn esp_list_files(state: State<'_, AppState>) -> Result<Vec<FileEntry>, String> {
    http(&state)?.list_files().await.map_err(|e| e.to_string())
}

/// 下载文件字节。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn esp_download_file(
    state: State<'_, AppState>,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = http(&state)?.read_file(&name).await.map_err(|e| e.to_string())?;
    // 以原始字节（IPC 二进制通道）返回，避免 Vec<u8> 被序列化成 JSON 数字数组而体积膨胀数倍。
    Ok(tauri::ipc::Response::new(bytes))
}

/// 上传/覆盖文件。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn esp_upload_file(
    state: State<'_, AppState>,
    name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    http(&state)?
        .write_file(&name, data)
        .await
        .map_err(|e| e.to_string())
}

/// 把节目库里的 `.artrec` 上传到核心板 SD 卡（后端直接读盘，避免大文件走 IPC）。
///
/// # Arguments
///
/// * `path` - 节目库中的 `.artrec` 路径，必须位于录制目录内。
///
/// # Returns
///
/// 上传到 SD 卡后的文件名。
///
/// # Errors
///
/// 路径非法、读盘失败、未配置核心板或请求失败时返回错误字符串。
#[tauri::command]
pub async fn esp_upload_recording(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let dir = crate::recording_commands::resolved_dir(&app, &state);
    let file = recorder::resolve_in_dir(&dir, std::path::Path::new(&path))
        .map_err(|e| e.to_string())?;
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("文件名无效")?
        .to_string();
    let data = std::fs::read(&file).map_err(|e| e.to_string())?;
    http(&state)?
        .write_file(&name, data)
        .await
        .map_err(|e| e.to_string())?;
    Ok(name)
}

/// 删除文件。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn esp_delete_file(state: State<'_, AppState>, name: String) -> Result<(), String> {
    http(&state)?.delete_file(&name).await.map_err(|e| e.to_string())
}

/// 重命名文件。
///
/// # Errors
///
/// 请求失败返回错误字符串。
#[tauri::command]
pub async fn esp_rename_file(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), String> {
    http(&state)?
        .rename_file(&from, &to)
        .await
        .map_err(|e| e.to_string())
}
