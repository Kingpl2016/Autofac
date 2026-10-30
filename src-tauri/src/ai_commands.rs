//! Tauri 命令：节目编辑器 AI 助手的厂商配置、API Key、流式代理与对话记录。
//!
//! 逻辑全部位于 `ai-gateway` 库；本模块只做“提取 State → 调用库 → 返回 DTO”。
//! 错误统一序列化为 `{ code, message }`，前端据 `code` 映射国际化文案。

use std::sync::Arc;

use ai_gateway::{
    AiError, AiErrorPayload, HttpClient, ModelInfo, ModelListInput, ProfileInput, ProfileStore, ProfileView,
    ProxyEvent, ProxyRequest, ProxyTable, SecretStore, history, list_models, normalize_base_url, same_origin,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// 配置文件名（位于数据根目录）。
const PROFILES_FILE: &str = "ai-profiles.json";

/// 命令返回类型：错误序列化为 [`AiErrorPayload`]。
type CmdResult<T> = Result<T, AiErrorPayload>;

/// AI 模块的应用状态：配置表、HTTP 客户端与进行中的代理请求。
pub struct AiState {
    profiles: ProfileStore,
    client: Option<HttpClient>,
    proxies: Arc<ProxyTable>,
}

impl AiState {
    /// 创建状态。
    ///
    /// # Arguments
    ///
    /// * `app` - 应用句柄，用于定位数据根目录。
    /// * `secrets` - Key 存储（生产传系统凭据管理器）。
    ///
    /// # Returns
    ///
    /// 已从磁盘加载配置的状态；HTTP 客户端初始化失败时代理命令返回网络错误，其它命令照常可用。
    #[must_use]
    pub fn new(app: &AppHandle, secrets: Arc<dyn SecretStore>) -> Self {
        let dir = app.state::<crate::data_dir::DataRoot>().path().to_path_buf();
        let agent = format!("ArtNetStudio/{}", env!("CARGO_PKG_VERSION"));
        let client = ai_gateway::build_client(&agent)
            .inspect_err(|e| tracing::error!(error = %e, "AI 代理的 HTTP 客户端初始化失败"))
            .ok();
        Self { profiles: ProfileStore::load(dir.join(PROFILES_FILE), secrets), client, proxies: Arc::default() }
    }
}

/// 列出 AI 配置及其 Key 状态。
///
/// # Arguments
///
/// * `state` - AI 状态。
///
/// # Returns
///
/// 配置视图列表。
#[tauri::command]
pub fn ai_profiles_list(state: State<'_, AiState>) -> Vec<ProfileView> {
    state.profiles.list()
}

/// 新增或更新 AI 配置。
///
/// # Arguments
///
/// * `state` - AI 状态。
/// * `input` - 配置；带 `id` 表示更新。
///
/// # Returns
///
/// 保存后的配置视图。
///
/// # Errors
///
/// 字段非法、id 不存在或写盘失败时返回错误载荷。
#[tauri::command]
pub fn ai_profile_save(state: State<'_, AiState>, input: ProfileInput) -> CmdResult<ProfileView> {
    Ok(state.profiles.save(&input)?)
}

/// 删除 AI 配置并清除其 Key。
///
/// # Arguments
///
/// * `state` - AI 状态。
/// * `id` - 配置 id。
///
/// # Errors
///
/// 配置不存在、写盘或凭据删除失败时返回错误载荷。
#[tauri::command]
pub fn ai_profile_delete(state: State<'_, AiState>, id: String) -> CmdResult<()> {
    Ok(state.profiles.delete(&id)?)
}

/// 设置或清除配置的 API Key（空串清除）。Key 只进系统凭据管理器，不会再返回给前端。
///
/// # Arguments
///
/// * `state` - AI 状态。
/// * `id` - 配置 id。
/// * `key` - 新 Key。
///
/// # Errors
///
/// 配置不存在、Key 格式非法或凭据存储失败时返回错误载荷。
#[tauri::command]
pub fn ai_key_set(state: State<'_, AiState>, id: String, key: String) -> CmdResult<()> {
    Ok(state.profiles.set_key(&id, &key)?)
}

/// 经代理发送一次模型请求，响应经 `on_event` 依次回传 `head`、若干 `chunk`、`end`。
///
/// # Arguments
///
/// * `state` - AI 状态。
/// * `request` - 前端组装的请求（目标地址必须在配置的接口地址之下）。
/// * `on_event` - 响应事件通道。
///
/// # Errors
///
/// 配置不存在、地址越界或不安全、网络错误、超时、被取消（`cancelled`）或响应过大时返回错误载荷。
#[tauri::command]
pub async fn ai_fetch(
    state: State<'_, AiState>,
    request: ProxyRequest,
    on_event: Channel<ProxyEvent>,
) -> CmdResult<()> {
    let client = state.client.clone().ok_or_else(|| AiError::Network("HTTP 客户端不可用".into()))?;
    let profile = state.profiles.get(&request.profile_id)?;
    let key = state.profiles.key(&profile.id)?;
    let guard = ProxyTable::begin(&state.proxies, &request.request_id)?;
    ai_gateway::forward(&client, &profile, key.as_deref(), request, guard.token(), |event| {
        let _ = on_event.send(event);
    })
    .await?;
    Ok(())
}

/// 查询模型服务提供的模型列表（设置页的模型下拉框）。
///
/// Key 的来源：表单里刚填的 `key` 优先；否则用 `profile_id` 对应配置在凭据库里的 Key——但只有接口地址
/// 与该配置同源时才用，防止把已保存的 Key 发到改过的其它主机上。
///
/// # Arguments
///
/// * `state` - AI 状态。
/// * `input` - 协议、接口地址，以及可选的配置 id 与 Key。
///
/// # Returns
///
/// 模型列表（按 id 排序）。
///
/// # Errors
///
/// 地址不合法或不安全、Key 被拒绝（`unauthorized`）、其它状态（`http_status`）、网络错误、超时、
/// 响应过大或格式不对时返回错误载荷。
#[tauri::command]
pub async fn ai_list_models(state: State<'_, AiState>, input: ModelListInput) -> CmdResult<Vec<ModelInfo>> {
    let client = state.client.clone().ok_or_else(|| AiError::Network("HTTP 客户端不可用".into()))?;
    let base_url = normalize_base_url(&input.base_url)?;
    let typed = input.key.as_deref().map(str::trim).filter(|k| !k.is_empty()).map(str::to_owned);
    let key = match (typed, input.profile_id.as_deref()) {
        (Some(k), _) => Some(k),
        (None, Some(id)) => {
            let profile = state.profiles.get(id)?;
            if same_origin(&profile.base_url, &base_url) { state.profiles.key(id)? } else { None }
        }
        (None, None) => None,
    };
    Ok(list_models(&client, input.kind, &base_url, key.as_deref()).await?)
}

/// 取消一次进行中的代理请求。
///
/// # Arguments
///
/// * `state` - AI 状态。
/// * `request_id` - 请求 id。
///
/// # Returns
///
/// 找到并已取消时为 `true`。
#[tauri::command]
pub fn ai_fetch_cancel(state: State<'_, AiState>, request_id: String) -> bool {
    state.proxies.cancel(&request_id)
}

/// 读取对话记录文件。
///
/// # Arguments
///
/// * `path` - 对话记录文件（必须以 `.ai.json` 结尾）。
///
/// # Returns
///
/// 文件内容；不存在时为 `None`。
///
/// # Errors
///
/// 路径不合法（`bad_path`）、文件过大（`file_too_large`）或读取失败（`io`）。
#[tauri::command]
pub fn ai_history_read(path: String) -> CmdResult<Option<String>> {
    let path = history::check_path(&path)?;
    Ok(history::read(&path)?)
}

/// 写入对话记录文件（原子写入）。
///
/// # Arguments
///
/// * `path` - 对话记录文件（必须以 `.ai.json` 结尾）。
/// * `text` - 内容（JSON）。
///
/// # Errors
///
/// 路径不合法（`bad_path`）、过大（`file_too_large`）、不是 JSON（`invalid_json`）或写入失败（`io`）。
#[tauri::command]
pub fn ai_history_write(path: String, text: String) -> CmdResult<()> {
    let path = history::check_path(&path)?;
    Ok(history::write(&path, &text)?)
}

/// 节目库条目的对话记录路径：数据根目录下 `ai-history/<条目 id>.ai.json`。
///
/// # Arguments
///
/// * `root` - 数据根目录。
/// * `entry` - 节目库条目 id（只允许字母、数字、`-`、`_`、`.`，防止路径穿越）。
///
/// # Returns
///
/// 完整路径。
///
/// # Errors
///
/// id 为空、过长或含其它字符时返回 `bad_path`。
#[tauri::command]
pub fn ai_history_library_path(root: State<'_, crate::data_dir::DataRoot>, entry: String) -> CmdResult<String> {
    let ok = !entry.is_empty()
        && entry.len() <= 200
        && !entry.starts_with('.')
        && entry.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok {
        return Err(AiError::BadPath.into());
    }
    let path = root.path().join("ai-history").join(format!("{entry}{}", history::HISTORY_SUFFIX));
    Ok(path.to_string_lossy().into_owned())
}
