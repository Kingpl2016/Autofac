//! Tauri 命令：AI 助手的 MCP 客户端（服务器配置、命令确认、连接、工具调用）。
//!
//! 逻辑在 `mcp-hub` 库；本模块只做“提取 State → 调用库 → 返回 DTO”。错误序列化为 `{ code, message }`。
//! 每次工具调用都由前端逐次征得用户同意后才会到这里。

use std::sync::Arc;

use ai_gateway::SecretStore;
use mcp_hub::{ConfigStore, McpError, McpHub, ServerConfig, ServerInput, ServerStatus, ServerView, ToolOutput};
use serde::Serialize;
use skill_store::TrashEntry;
use tauri::{AppHandle, Manager, State};

/// 配置文件名（位于数据根目录）。
const SERVERS_FILE: &str = "mcp-servers.json";

/// 返回给前端的错误。
#[derive(Debug, Serialize)]
pub struct McpErrorPayload {
    /// 错误码（见 [`McpError::code`]）。
    code: &'static str,
    /// 描述（连接失败时给用户看原因）。
    message: String,
}

impl From<McpError> for McpErrorPayload {
    fn from(e: McpError) -> Self {
        Self { code: e.code(), message: e.to_string() }
    }
}

/// 命令返回类型。
type CmdResult<T> = Result<T, McpErrorPayload>;

/// MCP 的应用状态。
pub struct McpState {
    hub: McpHub,
}

impl McpState {
    /// 创建状态。
    ///
    /// # Arguments
    ///
    /// * `app` - 应用句柄，用于定位数据根目录。
    /// * `secrets` - 凭据存储（生产传系统凭据管理器）。
    ///
    /// # Returns
    ///
    /// 已加载配置、还没有连接的状态。
    #[must_use]
    pub fn new(app: &AppHandle, secrets: Arc<dyn SecretStore>) -> Self {
        let dir = app.state::<crate::data_dir::DataRoot>().path().to_path_buf();
        let config = ConfigStore::load(dir.join(SERVERS_FILE), secrets);
        Self { hub: McpHub::new(config, dir) }
    }
}

/// 列出 MCP 服务器。
///
/// # Arguments
///
/// * `state` - MCP 状态。
///
/// # Returns
///
/// 服务器视图（含是否需要确认与给用户看的命令行）。
#[tauri::command]
pub async fn mcp_servers_list(state: State<'_, McpState>) -> CmdResult<Vec<ServerView>> {
    Ok(state.hub.config().list())
}

/// 新增或更新服务器（已连接的先断开；改了命令要重新确认）。
///
/// # Arguments
///
/// * `state` - MCP 状态。
/// * `input` - 输入。
///
/// # Returns
///
/// 保存后的视图。
///
/// # Errors
///
/// 字段不合规、服务器不存在、凭据存储或写盘失败。
#[tauri::command]
pub async fn mcp_server_save(state: State<'_, McpState>, input: ServerInput) -> CmdResult<ServerView> {
    if let Some(id) = &input.id {
        state.hub.disconnect(id).await;
    }
    Ok(state.hub.config().save(&input)?)
}

/// 确认服务器的命令 / 地址（指纹必须与当前一致）。
///
/// # Arguments
///
/// * `state` - MCP 状态。
/// * `id` - 服务器 id。
/// * `fingerprint` - 用户看到的指纹。
///
/// # Returns
///
/// 更新后的视图。
///
/// # Errors
///
/// 服务器不存在、指纹过期或写盘失败。
#[tauri::command]
pub async fn mcp_server_approve(state: State<'_, McpState>, id: String, fingerprint: String) -> CmdResult<ServerView> {
    Ok(state.hub.config().approve(&id, &fingerprint)?)
}

/// 删除服务器：先断开，配置（不含密钥）放进回收站，30 天内可恢复。
///
/// # Arguments
///
/// * `app` - 应用句柄（取回收站）。
/// * `state` - MCP 状态。
/// * `id` - 服务器 id。
///
/// # Returns
///
/// 回收站条目。
///
/// # Errors
///
/// 服务器不存在或写盘失败。
#[tauri::command]
pub async fn mcp_server_delete(app: AppHandle, state: State<'_, McpState>, id: String) -> CmdResult<TrashEntry> {
    state.hub.disconnect(&id).await;
    let removed = state.hub.config().delete(&id)?;
    let json = serde_json::to_string(&removed).map_err(|e| McpError::Invalid(e.to_string()))?;
    let skills = app.state::<crate::skills_commands::SkillsState>();
    skills.trash_put_json("mcp", &removed.name, &json).map_err(|e| McpErrorPayload { code: "io", message: e })
}

/// 从回收站恢复服务器（要重新确认命令、重新填写密钥）。
///
/// # Arguments
///
/// * `app` - 应用句柄（取回收站）。
/// * `state` - MCP 状态。
/// * `trash_id` - 回收站条目 id。
///
/// # Returns
///
/// 恢复后的视图。
///
/// # Errors
///
/// 条目不存在或不是 MCP 配置、配置不合规或写盘失败。
#[tauri::command]
pub async fn mcp_server_restore(app: AppHandle, state: State<'_, McpState>, trash_id: String) -> CmdResult<ServerView> {
    let skills = app.state::<crate::skills_commands::SkillsState>();
    let json = skills.trash_take_json(&trash_id, "mcp").map_err(|e| McpErrorPayload { code: "unknown_server", message: e })?;
    let config: ServerConfig = serde_json::from_str(&json).map_err(|e| McpError::Invalid(e.to_string()))?;
    Ok(state.hub.config().restore(&config)?)
}

/// 连接服务器并列出工具。
///
/// # Arguments
///
/// * `state` - MCP 状态。
/// * `id` - 服务器 id。
///
/// # Returns
///
/// 状态与工具。
///
/// # Errors
///
/// 没确认过（`needs_approval`）、已停用、超时或连接失败。
#[tauri::command]
pub async fn mcp_connect(state: State<'_, McpState>, id: String) -> CmdResult<ServerStatus> {
    Ok(state.hub.connect(&id).await?)
}

/// 断开服务器。
///
/// # Arguments
///
/// * `state` - MCP 状态。
/// * `id` - 服务器 id。
///
/// # Errors
///
/// 不会失败（保持命令签名一致）。
#[tauri::command]
pub async fn mcp_disconnect(state: State<'_, McpState>, id: String) -> CmdResult<()> {
    state.hub.disconnect(&id).await;
    Ok(())
}

/// 已连接的服务器与工具。
///
/// # Arguments
///
/// * `state` - MCP 状态。
///
/// # Returns
///
/// 状态。
#[tauri::command]
pub async fn mcp_status(state: State<'_, McpState>) -> CmdResult<Vec<ServerStatus>> {
    Ok(state.hub.statuses().await)
}

/// 调用工具（前端已征得用户同意）。
///
/// # Arguments
///
/// * `state` - MCP 状态。
/// * `id` - 服务器 id。
/// * `tool` - 工具名。
/// * `arguments` - 参数（JSON 对象）。
///
/// # Returns
///
/// 结果文字（最多 256 KiB）。
///
/// # Errors
///
/// 没有连接、工具不存在、超时（60 秒）或调用失败。
#[tauri::command]
pub async fn mcp_call_tool(state: State<'_, McpState>, id: String, tool: String, arguments: serde_json::Value) -> CmdResult<ToolOutput> {
    Ok(state.hub.call(&id, &tool, arguments).await?)
}
