//! Tauri 命令：网络设备（ESP32-P4 核心板）的多设备管理、控制、配置、文件与固件升级。
//!
//! 逻辑全部位于 `netdev` 库；本模块只做"提取 State → 调用库 → 返回 DTO"。
//! 传输类命令通过 `Channel<Progress>` 回传进度，用 `transfer_id` 登记取消令牌（见 [`netdev_cancel`]）。
//! 错误统一序列化为 `{ code, message }`，前端据 `code` 映射国际化文案。

use std::path::Path;
use std::sync::Arc;

use netdev::model::{
    ConfigPatch, ConfigResult, DeviceConfig, DeviceStatus, Diag, FileEntry, OtaReceipt, OtaStatus,
    PlayerStatus, ProgramEntry, UploadReceipt,
};
use netdev::{
    DeviceClient, DeviceInput, DeviceRegistry, DeviceView, ErrorPayload, FirmwareInfo, NetdevError,
    Progress, ProgressFn, SavedDevice, SecretStore, TransferTable,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::recording_commands::resolved_dir;

/// 注册表文件名（位于数据根目录）。
const REGISTRY_FILE: &str = "net-devices.json";

/// 命令返回类型：错误序列化为 [`ErrorPayload`]。
type CmdResult<T> = Result<T, ErrorPayload>;

/// 网络设备模块的应用状态：设备注册表 + 进行中的传输登记表。
pub struct NetdevState {
    registry: DeviceRegistry,
    transfers: Arc<TransferTable>,
}

impl NetdevState {
    /// 创建状态。
    ///
    /// # Arguments
    ///
    /// * `app` - 应用句柄，用于定位数据根目录。
    /// * `secrets` - Token 存储（生产传系统凭据管理器）。
    ///
    /// # Returns
    ///
    /// 已从磁盘加载注册表的状态；数据目录不可用时回退到当前目录。
    #[must_use]
    pub fn new(app: &AppHandle, secrets: Arc<dyn SecretStore>) -> Self {
        let dir = app.state::<crate::data_dir::DataRoot>().path().to_path_buf();
        Self {
            registry: DeviceRegistry::load(dir.join(REGISTRY_FILE), secrets),
            transfers: Arc::new(TransferTable::default()),
        }
    }

    fn client(&self, id: &str) -> CmdResult<DeviceClient> {
        Ok(self.registry.client_for(id)?)
    }
}

/// 把 Tauri 通道包装成库使用的进度回调。
fn progress_fn(channel: Channel<Progress>) -> ProgressFn {
    Arc::new(move |p| {
        let _ = channel.send(p);
    })
}

// ===================== 设备管理 =====================

/// 列出已保存设备及其 Token 状态。
#[tauri::command]
pub fn netdev_list(state: State<'_, NetdevState>) -> Vec<DeviceView> {
    state.registry.list()
}

/// 新增或更新设备。
///
/// # Errors
///
/// 主机 / 端口 / 名称非法、重复或写盘失败时返回错误载荷。
#[tauri::command]
pub fn netdev_save(state: State<'_, NetdevState>, input: DeviceInput) -> CmdResult<SavedDevice> {
    Ok(state.registry.save(&input)?)
}

/// 删除设备并清除其 Token。
///
/// # Errors
///
/// 设备不存在或写盘失败时返回错误载荷。
#[tauri::command]
pub fn netdev_remove(state: State<'_, NetdevState>, id: String) -> CmdResult<()> {
    Ok(state.registry.remove(&id)?)
}

/// 设置或清除设备 Token（空串清除）。仅更新本地凭据，不改设备上的 Token。
///
/// # Errors
///
/// 设备不存在、Token 格式非法或凭据存储失败时返回错误载荷。
#[tauri::command]
pub fn netdev_set_token(state: State<'_, NetdevState>, id: String, token: String) -> CmdResult<()> {
    Ok(state.registry.set_token(&id, &token)?)
}

/// 探测一台尚未保存的设备（`GET /api/status`），用于"添加设备"时验证连通性与 Token。
///
/// # Errors
///
/// 参数非法、网络不通或需要鉴权（`unauthorized`）时返回错误载荷。
#[tauri::command]
pub async fn netdev_probe(host: String, port: u16, token: Option<String>) -> CmdResult<DeviceStatus> {
    Ok(DeviceClient::new(&host, port, token)?.status().await?)
}

// ===================== 状态与控制 =====================

/// 读取设备状态。
///
/// # Errors
///
/// 设备不存在、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_status(state: State<'_, NetdevState>, id: String) -> CmdResult<DeviceStatus> {
    Ok(state.client(&id)?.status().await?)
}

/// 设置工作模式（0~5）。
///
/// # Errors
///
/// 模式非法、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_set_workmode(state: State<'_, NetdevState>, id: String, mode: u8) -> CmdResult<()> {
    Ok(state.client(&id)?.set_workmode(mode).await?)
}

/// 设备操作（0 复位 / 1 恢复出厂 / 2 自检）。
///
/// # Errors
///
/// 操作码非法、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_board_op(state: State<'_, NetdevState>, id: String, op: u8) -> CmdResult<()> {
    Ok(state.client(&id)?.board_op(op).await?)
}

/// 节目操作（0 停止 / 1 暂停 / 2 单次 / 3 循环 / 4 删除）。
///
/// # Errors
///
/// 参数非法、模式不允许（`wrong_mode`）、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_program_op(
    state: State<'_, NetdevState>,
    id: String,
    no: u16,
    action: u8,
) -> CmdResult<()> {
    Ok(state.client(&id)?.program_op(no, action).await?)
}

/// 读取播放器状态。
///
/// # Errors
///
/// 设备不存在、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_player(state: State<'_, NetdevState>, id: String) -> CmdResult<PlayerStatus> {
    Ok(state.client(&id)?.player().await?)
}

/// 跳转播放位置（毫秒）。
///
/// # Errors
///
/// 网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_seek(state: State<'_, NetdevState>, id: String, pos_ms: u32) -> CmdResult<()> {
    Ok(state.client(&id)?.seek(pos_ms).await?)
}

/// 设置倍速（×100，25~200）。
///
/// # Errors
///
/// 倍速越界、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_speed(state: State<'_, NetdevState>, id: String, speed_x100: u16) -> CmdResult<()> {
    Ok(state.client(&id)?.set_speed(speed_x100).await?)
}

// ===================== 配置 / 诊断 / 日志 =====================

/// 读取设备配置。
///
/// # Errors
///
/// 设备不存在、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_get_config(state: State<'_, NetdevState>, id: String) -> CmdResult<DeviceConfig> {
    Ok(state.client(&id)?.config().await?)
}

/// 写入配置补丁。
///
/// 补丁里带 `httpToken` 时：先用旧 Token 把新 Token 写到设备，设备接受后再更新本地凭据，
/// 避免设备与本地不一致导致后续请求 401。
///
/// # Errors
///
/// 校验失败、网络或设备错误，或设备已接受但本地凭据写入失败时返回错误载荷。
#[tauri::command]
pub async fn netdev_put_config(
    state: State<'_, NetdevState>,
    id: String,
    patch: ConfigPatch,
) -> CmdResult<ConfigResult> {
    let result = state.client(&id)?.put_config(&patch).await?;
    if let Some(token) = &patch.http_token {
        state.registry.set_token(&id, token)?;
    }
    Ok(result)
}

/// 读取运行期诊断。
///
/// # Errors
///
/// 设备不存在、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_diag(state: State<'_, NetdevState>, id: String) -> CmdResult<Diag> {
    Ok(state.client(&id)?.diag().await?)
}

/// 读取最近日志文本。
///
/// # Errors
///
/// 设备不存在、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_logs(state: State<'_, NetdevState>, id: String) -> CmdResult<String> {
    Ok(state.client(&id)?.logs().await?)
}

// ===================== 文件 =====================

/// 列出设备 SD 卡文件。
///
/// # Errors
///
/// 设备不存在、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_list_files(state: State<'_, NetdevState>, id: String) -> CmdResult<Vec<FileEntry>> {
    Ok(state.client(&id)?.list_files().await?)
}

/// 列出节目映射。
///
/// # Errors
///
/// 设备不存在、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_list_programs(
    state: State<'_, NetdevState>,
    id: String,
) -> CmdResult<Vec<ProgramEntry>> {
    Ok(state.client(&id)?.list_programs().await?)
}

/// 删除设备上的文件。
///
/// # Errors
///
/// 文件名非法、文件正在播放（`busy`）、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_delete_file(state: State<'_, NetdevState>, id: String, name: String) -> CmdResult<()> {
    Ok(state.client(&id)?.delete_file(&name).await?)
}

/// 重命名设备上的文件。
///
/// # Errors
///
/// 文件名非法、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_rename_file(
    state: State<'_, NetdevState>,
    id: String,
    from: String,
    to: String,
) -> CmdResult<()> {
    Ok(state.client(&id)?.rename_file(&from, &to).await?)
}

/// 上传本地文件到设备（流式、带进度、可取消）。
///
/// # Arguments
///
/// * `id` - 设备 id。
/// * `name` - 设备上的文件名。
/// * `path` - 本地文件路径。
/// * `transfer_id` - 前端生成的传输 id，用于 [`netdev_cancel`]。
/// * `on_progress` - 进度通道。
///
/// # Errors
///
/// 参数非法、被取消，或设备返回错误（`bad_file` / `no_space` / `busy`）时返回错误载荷。
#[tauri::command]
pub async fn netdev_upload_file(
    state: State<'_, NetdevState>,
    id: String,
    name: String,
    path: String,
    transfer_id: String,
    on_progress: Channel<Progress>,
) -> CmdResult<UploadReceipt> {
    let client = state.client(&id)?;
    let guard = TransferTable::begin(&state.transfers, &transfer_id)?;
    Ok(client
        .upload_file(&name, Path::new(&path), progress_fn(on_progress), guard.token())
        .await?)
}

/// 下载设备文件到本地路径（流式、带进度、可取消）。
///
/// # Errors
///
/// 参数非法、被取消、设备或写盘错误时返回错误载荷；失败不留临时文件。
#[tauri::command]
pub async fn netdev_download_file(
    state: State<'_, NetdevState>,
    id: String,
    name: String,
    dest: String,
    transfer_id: String,
    on_progress: Channel<Progress>,
) -> CmdResult<()> {
    let client = state.client(&id)?;
    let guard = TransferTable::begin(&state.transfers, &transfer_id)?;
    Ok(client
        .download_file(&name, Path::new(&dest), progress_fn(on_progress), guard.token())
        .await?)
}

/// 把节目库里的 `.artrec` 上传到设备（后端直接读盘，不经 IPC 传内容）。
///
/// # Arguments
///
/// * `app` - 应用句柄（解析录制目录）。
/// * `id` - 设备 id。
/// * `path` - 节目库中的 `.artrec` 路径，必须位于录制目录内。
/// * `transfer_id` - 传输 id。
/// * `on_progress` - 进度通道。
///
/// # Returns
///
/// 上传后设备上的文件名。
///
/// # Errors
///
/// 路径不在录制目录内、被取消，或设备 / 网络错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_upload_recording(
    app: AppHandle,
    state: State<'_, NetdevState>,
    id: String,
    path: String,
    transfer_id: String,
    on_progress: Channel<Progress>,
) -> CmdResult<String> {
    let client = state.client(&id)?;
    let dir = resolved_dir(&app);
    let file = recorder::resolve_in_dir(&dir, Path::new(&path))
        .map_err(|e| NetdevError::Invalid(e.to_string()))?;
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| NetdevError::Invalid("文件名无效".into()))?
        .to_string();
    let guard = TransferTable::begin(&state.transfers, &transfer_id)?;
    client
        .upload_file(&name, &file, progress_fn(on_progress), guard.token())
        .await?;
    Ok(name)
}

/// 取消进行中的传输。
///
/// # Returns
///
/// 找到并触发取消返回 `true`；传输已结束返回 `false`。
#[tauri::command]
pub fn netdev_cancel(state: State<'_, NetdevState>, transfer_id: String) -> bool {
    state.transfers.cancel(&transfer_id)
}

// ===================== 固件升级 =====================

/// 读取 OTA 状态。
///
/// # Errors
///
/// 设备不存在、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_ota_status(state: State<'_, NetdevState>, id: String) -> CmdResult<OtaStatus> {
    Ok(state.client(&id)?.ota_status().await?)
}

/// 手动确认当前固件有效（取消回滚）。
///
/// # Errors
///
/// 设备不存在、网络或设备错误时返回错误载荷。
#[tauri::command]
pub async fn netdev_ota_confirm(state: State<'_, NetdevState>, id: String) -> CmdResult<()> {
    Ok(state.client(&id)?.ota_confirm().await?)
}

/// 固件预检：读取镜像头，返回版本 / 工程名 / 构建时间 / 大小。
///
/// # Errors
///
/// 文件无法读取、不是 ESP 应用镜像或超过 OTA 分区大小时返回错误载荷。
#[tauri::command]
pub fn netdev_inspect_firmware(path: String) -> CmdResult<FirmwareInfo> {
    Ok(netdev::firmware::inspect(Path::new(&path))?)
}

/// 推送固件触发 OTA（流式、带进度、可取消）。成功后设备约 0.5 秒重启。
///
/// # Errors
///
/// 本地读取失败、被取消，或设备拒绝时返回错误载荷。
#[tauri::command]
pub async fn netdev_ota_upload(
    state: State<'_, NetdevState>,
    id: String,
    path: String,
    transfer_id: String,
    on_progress: Channel<Progress>,
) -> CmdResult<OtaReceipt> {
    let client = state.client(&id)?;
    let guard = TransferTable::begin(&state.transfers, &transfer_id)?;
    Ok(client
        .ota_upload(Path::new(&path), progress_fn(on_progress), guard.token())
        .await?)
}
