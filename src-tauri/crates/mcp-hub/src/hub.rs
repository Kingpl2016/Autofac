//! MCP 连接：按配置启动子进程（stdio）或连接远程地址（Streamable HTTP），列出工具，调用工具。
//!
//! 只有用户确认过指纹的服务器才能连接；连接 30 秒、调用 60 秒超时；工具结果转成文字、最多 256 KiB，
//! 前端再把它当成不可信数据交给模型。子进程在断开或应用退出时结束。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde::Serialize;

use crate::config::{fingerprint, ConfigStore, Transport};
use crate::error::{McpError, Result};

/// 连接超时。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// 调用超时。
pub const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// 工具结果的文字上限（字节）。
pub const MAX_RESULT_BYTES: usize = 256 * 1024;
/// 一个服务器最多列出多少个工具。
pub const MAX_TOOLS_PER_SERVER: usize = 50;
/// 工具描述的长度上限（字符）。
const MAX_DESCRIPTION_CHARS: usize = 1024;

/// 一个工具。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, rename = "McpTool"))]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    /// 工具名（服务器里的原名）。
    pub name: String,
    /// 显示标题。
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub title: Option<String>,
    /// 描述（截断到 1024 字符）。
    pub description: String,
    /// 参数的 JSON Schema。
    #[cfg_attr(feature = "ts", ts(type = "Record<string, unknown>"))]
    pub input_schema: serde_json::Value,
    /// 服务器声明只读（仅为提示，调用照样要确认）。
    pub read_only: bool,
}

/// 一个服务器的连接状态。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, rename = "McpStatus"))]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    /// 服务器 id。
    pub id: String,
    /// 服务器自报的名称与版本。
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub server: Option<String>,
    /// 工具。
    pub tools: Vec<ToolInfo>,
}

/// 一次工具调用的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, rename = "McpToolOutput"))]
#[serde(rename_all = "camelCase")]
pub struct ToolOutput {
    /// 结果文字（图片等非文字内容换成占位说明）。
    pub text: String,
    /// 服务器报告这是一个错误。
    pub is_error: bool,
    /// 超过上限被截断。
    pub truncated: bool,
}

/// 一个连接。
struct Conn {
    client: RunningService<RoleClient, ()>,
    status: ServerStatus,
    fingerprint: String,
}

/// MCP 连接表。
pub struct McpHub {
    config: ConfigStore,
    /// 子进程的默认工作目录。
    work_dir: PathBuf,
    conns: tokio::sync::Mutex<HashMap<String, Conn>>,
}

/// 截断到不超过 `limit` 字节（落在字符边界上）。
fn truncate_utf8(s: &mut String, limit: usize) -> bool {
    if s.len() <= limit {
        return false;
    }
    let mut at = limit;
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    s.truncate(at);
    true
}

/// 把工具结果（JSON）转成文字：文字内容原样拼接，资源取其文字，图片 / 音频换成占位说明；
/// 没有文字时用结构化结果。
///
/// # Arguments
///
/// * `result` - `CallToolResult` 的 JSON。
/// * `limit` - 字节上限。
///
/// # Returns
///
/// 结果。
pub fn result_text(result: &serde_json::Value, limit: usize) -> ToolOutput {
    let mut parts: Vec<String> = Vec::new();
    for block in result.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
        let kind = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let part = match kind {
            "text" => block.get("text").and_then(|t| t.as_str()).map(str::to_owned),
            "resource" => {
                let res = block.get("resource");
                res.and_then(|r| r.get("text")).and_then(|t| t.as_str()).map(str::to_owned).or_else(|| {
                    res.and_then(|r| r.get("uri")).and_then(|u| u.as_str()).map(|u| format!("[resource {u}]"))
                })
            }
            "resource_link" => block.get("uri").and_then(|u| u.as_str()).map(|u| format!("[link {u}]")),
            "image" | "audio" => Some(format!("[{kind} omitted]")),
            other => Some(format!("[{other} content omitted]")),
        };
        if let Some(p) = part {
            parts.push(p);
        }
    }
    let mut text = parts.join("\n");
    if text.trim().is_empty()
        && let Some(sc) = result.get("structuredContent").filter(|v| !v.is_null())
    {
        text = serde_json::to_string(sc).unwrap_or_default();
    }
    let truncated = truncate_utf8(&mut text, limit);
    ToolOutput { text, is_error: result.get("isError").and_then(serde_json::Value::as_bool).unwrap_or(false), truncated }
}

/// Windows 上按 `PATH` 与 `PATHEXT` 找到 `npx` 这类不带扩展名的命令（`.cmd` / `.bat` 需要完整路径才能启动）。
///
/// # Arguments
///
/// * `command` - 用户填的命令。
///
/// # Returns
///
/// 找到时为完整路径，否则原样返回。
fn resolve_command(command: &str) -> PathBuf {
    let path = Path::new(command);
    if !cfg!(windows) || path.extension().is_some() || path.components().count() > 1 {
        return path.to_path_buf();
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{command}{}", ext.to_ascii_lowercase()));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    path.to_path_buf()
}

/// 工具列表换成界面 / 模型用的形状。
fn tools_of(list: Vec<rmcp::model::Tool>) -> Vec<ToolInfo> {
    list.into_iter()
        .take(MAX_TOOLS_PER_SERVER)
        .map(|t| ToolInfo {
            name: t.name.to_string(),
            title: t.title.clone().or_else(|| t.annotations.as_ref().and_then(|a| a.title.clone())),
            description: t.description.as_deref().unwrap_or("").chars().take(MAX_DESCRIPTION_CHARS).collect(),
            input_schema: serde_json::Value::Object((*t.input_schema).clone()),
            read_only: t.annotations.as_ref().and_then(|a| a.read_only_hint).unwrap_or(false),
        })
        .collect()
}

impl McpHub {
    /// 创建连接表。
    ///
    /// # Arguments
    ///
    /// * `config` - 服务器配置表。
    /// * `work_dir` - 子进程的默认工作目录。
    ///
    /// # Returns
    ///
    /// 连接表（还没有连接）。
    pub fn new(config: ConfigStore, work_dir: PathBuf) -> Self {
        Self { config, work_dir, conns: tokio::sync::Mutex::new(HashMap::new()) }
    }

    /// 配置表。
    ///
    /// # Returns
    ///
    /// 配置表。
    pub fn config(&self) -> &ConfigStore {
        &self.config
    }

    /// 连接一个服务器并列出工具（已连接且配置没变时直接返回）。
    ///
    /// # Arguments
    ///
    /// * `id` - 服务器 id。
    ///
    /// # Returns
    ///
    /// 状态与工具。
    ///
    /// # Errors
    ///
    /// 服务器不存在、已停用、没确认过（[`McpError::NeedsApproval`]）、超时或连接失败。
    pub async fn connect(&self, id: &str) -> Result<ServerStatus> {
        let cfg = self.config.get(id)?;
        if !cfg.enabled {
            return Err(McpError::Disabled);
        }
        let fp = fingerprint(&cfg.transport);
        if cfg.approved.as_deref() != Some(fp.as_str()) {
            return Err(McpError::NeedsApproval);
        }
        let mut conns = self.conns.lock().await;
        if let Some(c) = conns.get(id)
            && c.fingerprint == fp
            && !c.client.is_closed()
        {
            return Ok(c.status.clone());
        }
        if let Some(old) = conns.remove(id) {
            let _ = old.client.cancel().await;
        }
        let client = tokio::time::timeout(CONNECT_TIMEOUT, self.open(id, &cfg.transport)).await.map_err(|_| McpError::Timeout)??;
        let tools = tokio::time::timeout(CONNECT_TIMEOUT, client.list_all_tools())
            .await
            .map_err(|_| McpError::Timeout)?
            .map_err(|e| McpError::Connect(e.to_string()))?;
        let server = client.peer_info().and_then(|info| {
            let v = serde_json::to_value(&*info).ok()?;
            let s = v.get("serverInfo")?;
            Some(format!("{} {}", s.get("name")?.as_str()?, s.get("version").and_then(|x| x.as_str()).unwrap_or("")).trim().to_owned())
        });
        let status = ServerStatus { id: id.to_owned(), server, tools: tools_of(tools) };
        conns.insert(id.to_owned(), Conn { client, status: status.clone(), fingerprint: fp });
        Ok(status)
    }

    /// 建立连接（不含超时）。
    async fn open(&self, id: &str, transport: &Transport) -> Result<RunningService<RoleClient, ()>> {
        match transport {
            Transport::Stdio { command, args, cwd, .. } => {
                let mut cmd = tokio::process::Command::new(resolve_command(command));
                cmd.args(args);
                cmd.current_dir(cwd.as_deref().map_or_else(|| self.work_dir.clone(), PathBuf::from));
                for (k, v) in self.config.env(id)? {
                    cmd.env(k, v);
                }
                cmd.kill_on_drop(true);
                #[cfg(windows)]
                {
                    // 不弹出控制台窗口
                    cmd.creation_flags(0x0800_0000);
                }
                let (proc, stderr) = TokioChildProcess::builder(cmd)
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| McpError::Connect(e.to_string()))?;
                if let Some(stderr) = stderr {
                    // 服务器的日志转进应用日志（最多 200 行）
                    let name = id.to_owned();
                    tokio::spawn(async move {
                        use tokio::io::AsyncBufReadExt;
                        let mut lines = tokio::io::BufReader::new(stderr).lines();
                        let mut n = 0;
                        while let Ok(Some(line)) = lines.next_line().await {
                            if n < 200 {
                                tracing::debug!(server = %name, "{line}");
                            }
                            n += 1;
                        }
                    });
                }
                ().serve(proc).await.map_err(|e| McpError::Connect(e.to_string()))
            }
            Transport::Http { url } => {
                let mut config = StreamableHttpClientTransportConfig::with_uri(url.clone());
                if let Some(token) = self.config.token(id)? {
                    config = config.auth_header(token);
                }
                ().serve(StreamableHttpClientTransport::from_config(config)).await.map_err(|e| McpError::Connect(e.to_string()))
            }
        }
    }

    /// 已连接的服务器状态。
    ///
    /// # Returns
    ///
    /// 状态（按 id 排序）。
    pub async fn statuses(&self) -> Vec<ServerStatus> {
        let conns = self.conns.lock().await;
        let mut out: Vec<ServerStatus> = conns.values().filter(|c| !c.client.is_closed()).map(|c| c.status.clone()).collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// 调用工具。
    ///
    /// # Arguments
    ///
    /// * `id` - 服务器 id。
    /// * `tool` - 工具名。
    /// * `arguments` - 参数（JSON 对象；其它类型按空参数处理）。
    ///
    /// # Returns
    ///
    /// 结果文字。
    ///
    /// # Errors
    ///
    /// 没有连接、工具不存在、超时或调用失败。
    pub async fn call(&self, id: &str, tool: &str, arguments: serde_json::Value) -> Result<ToolOutput> {
        let conns = self.conns.lock().await;
        let conn = conns.get(id).filter(|c| !c.client.is_closed()).ok_or(McpError::NotConnected)?;
        if !conn.status.tools.iter().any(|t| t.name == tool) {
            return Err(McpError::UnknownTool);
        }
        let mut params = CallToolRequestParams::new(tool.to_owned());
        if let serde_json::Value::Object(obj) = arguments {
            params = params.with_arguments(obj);
        }
        let peer = conn.client.peer().clone();
        // 调用期间不占着连接表（其它服务器可以同时调用）
        drop(conns);
        let result = tokio::time::timeout(CALL_TIMEOUT, peer.call_tool(params))
            .await
            .map_err(|_| McpError::Timeout)?
            .map_err(|e| McpError::Call(e.to_string()))?;
        let value = serde_json::to_value(&result).map_err(|e| McpError::Call(e.to_string()))?;
        Ok(result_text(&value, MAX_RESULT_BYTES))
    }

    /// 断开一个服务器（结束子进程）。没有连接时什么也不做。
    ///
    /// # Arguments
    ///
    /// * `id` - 服务器 id。
    pub async fn disconnect(&self, id: &str) {
        let conn = self.conns.lock().await.remove(id);
        if let Some(c) = conn {
            let _ = c.client.cancel().await;
        }
    }

    /// 断开全部连接（应用退出时）。
    pub async fn disconnect_all(&self) {
        let all: Vec<Conn> = self.conns.lock().await.drain().map(|(_, c)| c).collect();
        for c in all {
            let _ = c.client.cancel().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 结果转文字_非文字内容占位_截断在字符边界() {
        let r = json!({ "content": [
            { "type": "text", "text": "hello" },
            { "type": "image", "data": "...", "mimeType": "image/png" },
            { "type": "resource", "resource": { "uri": "file:///a", "text": "file body" } },
            { "type": "resource_link", "uri": "https://x" }
        ], "isError": false });
        let out = result_text(&r, 1024);
        assert_eq!(out.text, "hello\n[image omitted]\nfile body\n[link https://x]");
        assert!(!out.is_error && !out.truncated);

        let long = json!({ "content": [{ "type": "text", "text": "灯光".repeat(100) }], "isError": true });
        let out = result_text(&long, 10);
        assert!(out.truncated && out.is_error);
        assert_eq!(out.text, "灯光灯");
    }

    #[test]
    fn 没有文字时用结构化结果() {
        let r = json!({ "content": [], "structuredContent": { "ok": 1 } });
        assert_eq!(result_text(&r, 100).text, "{\"ok\":1}");
    }

    #[tokio::test]
    async fn 没确认不能连接_命令不存在时报连接错误_未连接不能调用() {
        use crate::config::ServerInput;
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::load(dir.path().join("mcp.json"), std::sync::Arc::new(ai_gateway::MemoryStore::default()));
        let v = store
            .save(&ServerInput {
                id: None,
                name: "Ghost".into(),
                enabled: true,
                transport: Transport::Stdio { command: "definitely-not-a-real-mcp-server-xyz".into(), args: vec![], cwd: None, env_names: vec![] },
                env: None,
                token: None,
            })
            .unwrap();
        let hub = McpHub::new(store, dir.path().to_path_buf());
        assert!(matches!(hub.connect("ghost").await, Err(McpError::NeedsApproval)));
        hub.config().approve("ghost", &v.fingerprint).unwrap();
        assert!(matches!(hub.connect("ghost").await, Err(McpError::Connect(_))));
        assert!(matches!(hub.call("ghost", "x", serde_json::Value::Null).await, Err(McpError::NotConnected)));
        assert!(matches!(hub.connect("nope").await, Err(McpError::UnknownServer)));
        assert!(hub.statuses().await.is_empty());
    }

    #[test]
    fn 命令解析_带路径或扩展名的原样返回() {
        assert_eq!(resolve_command("C:/tools/server.exe"), PathBuf::from("C:/tools/server.exe"));
        assert_eq!(resolve_command("./server"), PathBuf::from("./server"));
    }
}
