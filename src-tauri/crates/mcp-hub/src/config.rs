//! MCP 服务器配置：持久化到 `data/mcp-servers.json`；密钥（环境变量的值、HTTP 的 Bearer Token）
//! 进系统凭据管理器，不写进配置文件、不返回给前端。
//!
//! 每个服务器有一个“指纹”（传输方式、命令、参数、工作目录、环境变量名、地址的哈希）。用户在界面上看到完整的
//! 命令行并确认后记下指纹；之后配置一改指纹就变，必须重新确认才能连接——避免配置文件被改后悄悄运行别的程序。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use ai_gateway::SecretStore;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{McpError, Result};

/// 最多保存多少个服务器。
pub const MAX_SERVERS: usize = 32;
/// 名称最长字符数。
const MAX_NAME_CHARS: usize = 40;
/// 命令 / 参数 / 地址的长度上限（字符）。
const MAX_FIELD_CHARS: usize = 2048;
/// 最多多少个参数。
const MAX_ARGS: usize = 64;
/// 最多多少个环境变量。
const MAX_ENV: usize = 32;

/// 连接方式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, rename = "McpTransport"))]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Transport {
    /// 本机子进程（stdio）。
    Stdio {
        /// 可执行文件（`npx`、`uvx`、绝对路径…）。
        command: String,
        /// 参数。
        args: Vec<String>,
        /// 工作目录；省略时用数据目录。
        #[cfg_attr(feature = "ts", ts(optional = nullable))]
        cwd: Option<String>,
        /// 环境变量名（值在凭据管理器里）。
        env_names: Vec<String>,
    },
    /// 远程 Streamable HTTP。
    Http {
        /// 服务地址（HTTPS；本机 / 局域网可用 HTTP）。
        url: String,
    },
}

/// 一个服务器的配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, rename = "McpServer"))]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// 稳定 id（小写字母、数字与连字符）。
    pub id: String,
    /// 显示名（也用于工具名前缀）。
    pub name: String,
    /// 是否启用（停用的不连接，工具不给模型）。
    pub enabled: bool,
    /// 连接方式。
    pub transport: Transport,
    /// 用户确认过的指纹；与当前指纹不同时要重新确认。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub approved: Option<String>,
}

/// 新增 / 更新服务器的输入（密钥只写不读：省略时保持不变）。
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, rename = "McpServerInput"))]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    /// 已有服务器 id；新增时省略。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub id: Option<String>,
    /// 显示名。
    pub name: String,
    /// 是否启用。
    pub enabled: bool,
    /// 连接方式。
    pub transport: Transport,
    /// stdio 的环境变量（名 → 值）；省略时保持原来的值（名称以 `transport.env_names` 为准）。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub env: Option<BTreeMap<String, String>>,
    /// HTTP 的 Bearer Token；省略时保持不变，空串清除。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub token: Option<String>,
}

/// 返回给前端的服务器视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, rename = "McpServerView"))]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    /// 配置。
    #[serde(flatten)]
    pub config: ServerConfig,
    /// 当前指纹。
    pub fingerprint: String,
    /// 需要用户确认（从未确认，或确认后改过）。
    pub needs_approval: bool,
    /// 确认时给用户看的完整命令行 / 地址。
    pub summary: String,
    /// 是否保存了 Token（HTTP）。
    pub has_token: bool,
}

/// 磁盘文件结构。
#[derive(Debug, Default, Serialize, Deserialize)]
struct FileData {
    #[serde(default)]
    servers: Vec<ServerConfig>,
}

/// FNV-1a 64 位哈希（指纹用：只需稳定，不需要抗碰撞——确认的是界面上展示的完整内容）。
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// 配置的指纹。
///
/// # Arguments
///
/// * `transport` - 连接方式。
///
/// # Returns
///
/// 16 位十六进制。
pub fn fingerprint(transport: &Transport) -> String {
    let text = serde_json::to_string(transport).unwrap_or_default();
    format!("{:016x}", fnv1a(&text))
}

/// 给用户确认的说明：完整命令行（参数含空格时加引号）或地址。
///
/// # Arguments
///
/// * `transport` - 连接方式。
///
/// # Returns
///
/// 文字。
pub fn summary(transport: &Transport) -> String {
    match transport {
        Transport::Stdio { command, args, cwd, env_names } => {
            let quote = |s: &str| if s.contains(char::is_whitespace) || s.is_empty() { format!("\"{s}\"") } else { s.to_owned() };
            let mut line = std::iter::once(quote(command)).chain(args.iter().map(|a| quote(a))).collect::<Vec<_>>().join(" ");
            if let Some(dir) = cwd {
                line = format!("{line}\n(cwd: {dir})");
            }
            if !env_names.is_empty() {
                line = format!("{line}\n(env: {})", env_names.join(", "));
            }
            line
        }
        Transport::Http { url } => url.clone(),
    }
}

/// 环境变量名：字母、数字与下划线，不以数字开头。
fn valid_env_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 128 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !n.starts_with(|c: char| c.is_ascii_digit())
}

/// 校验并规整连接方式。
///
/// # Arguments
///
/// * `transport` - 用户输入。
///
/// # Returns
///
/// 规整后的连接方式（去首尾空白、环境变量名去重排序）。
///
/// # Errors
///
/// 字段为空、过长、含控制字符，或地址不安全时返回 [`McpError::Invalid`]。
pub fn normalize_transport(transport: &Transport) -> Result<Transport> {
    let bad = |s: &str| s.chars().count() > MAX_FIELD_CHARS || s.chars().any(|c| c.is_control() && c != '\t');
    match transport {
        Transport::Stdio { command, args, cwd, env_names } => {
            let command = command.trim().to_owned();
            if command.is_empty() || bad(&command) {
                return Err(McpError::Invalid("command is empty or too long".into()));
            }
            if args.len() > MAX_ARGS || args.iter().any(|a| bad(a)) {
                return Err(McpError::Invalid("too many or too long arguments".into()));
            }
            let cwd = cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
            if cwd.as_deref().is_some_and(bad) {
                return Err(McpError::Invalid("working directory is too long".into()));
            }
            let mut names: Vec<String> = env_names.iter().map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()).collect();
            names.sort();
            names.dedup();
            if names.len() > MAX_ENV || names.iter().any(|n| !valid_env_name(n)) {
                return Err(McpError::Invalid("invalid environment variable names".into()));
            }
            Ok(Transport::Stdio { command, args: args.clone(), cwd, env_names: names })
        }
        Transport::Http { url } => {
            let url = url.trim().to_owned();
            let parsed = url::Url::parse(&url).map_err(|_| McpError::Invalid("the url cannot be parsed".into()))?;
            if !parsed.username().is_empty() || parsed.password().is_some() || parsed.host().is_none() {
                return Err(McpError::Invalid("the url must not contain credentials".into()));
            }
            let local = match parsed.host() {
                Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
                Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
                None => false,
            };
            match parsed.scheme() {
                "https" => {}
                "http" if local => {}
                _ => return Err(McpError::Invalid("use https (http only for this computer or the local network)".into())),
            }
            Ok(Transport::Http { url })
        }
    }
}

/// 凭据管理器里的键。
fn token_key(id: &str) -> String {
    format!("mcp-token:{id}")
}
fn env_key(id: &str) -> String {
    format!("mcp-env:{id}")
}

/// 服务器配置表。
pub struct ConfigStore {
    path: PathBuf,
    servers: Mutex<Vec<ServerConfig>>,
    secrets: Arc<dyn SecretStore>,
}

impl ConfigStore {
    /// 从磁盘加载；文件缺失得到空表，损坏时备份为 `.bad` 后得到空表。
    ///
    /// # Arguments
    ///
    /// * `path` - 配置文件路径。
    /// * `secrets` - 凭据存储。
    ///
    /// # Returns
    ///
    /// 配置表。
    pub fn load(path: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        let servers = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<FileData>(&text) {
                Ok(d) => d.servers,
                Err(e) => {
                    tracing::warn!(error = %e, "MCP 服务器配置文件损坏，已备份并重置");
                    let _ = std::fs::rename(&path, path.with_extension("json.bad"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Self { path, servers: Mutex::new(servers), secrets }
    }

    fn persist(&self, servers: &[ServerConfig]) -> Result<()> {
        let text = serde_json::to_string_pretty(&FileData { servers: servers.to_vec() }).map_err(|e| McpError::Invalid(e.to_string()))?;
        fsutil::write_atomic(&self.path, text.as_bytes())?;
        Ok(())
    }

    fn view(&self, config: ServerConfig) -> ServerView {
        let fp = fingerprint(&config.transport);
        let has_token = matches!(config.transport, Transport::Http { .. }) && matches!(self.secrets.get(&token_key(&config.id)), Ok(Some(_)));
        ServerView {
            needs_approval: config.approved.as_deref() != Some(fp.as_str()),
            summary: summary(&config.transport),
            fingerprint: fp,
            has_token,
            config,
        }
    }

    /// 列出服务器。
    ///
    /// # Returns
    ///
    /// 视图。
    pub fn list(&self) -> Vec<ServerView> {
        let servers = self.servers.lock().clone();
        servers.into_iter().map(|c| self.view(c)).collect()
    }

    /// 取一个服务器。
    ///
    /// # Arguments
    ///
    /// * `id` - 服务器 id。
    ///
    /// # Returns
    ///
    /// 配置。
    ///
    /// # Errors
    ///
    /// 不存在时返回 [`McpError::UnknownServer`]。
    pub fn get(&self, id: &str) -> Result<ServerConfig> {
        self.servers.lock().iter().find(|s| s.id == id).cloned().ok_or(McpError::UnknownServer)
    }

    /// stdio 服务器的环境变量（名 → 值）。
    ///
    /// # Arguments
    ///
    /// * `id` - 服务器 id。
    ///
    /// # Returns
    ///
    /// 环境变量；没有保存时为空。
    ///
    /// # Errors
    ///
    /// 凭据存储不可用时返回 [`McpError::Secret`]。
    pub fn env(&self, id: &str) -> Result<BTreeMap<String, String>> {
        let text = self.secrets.get(&env_key(id)).map_err(|e| McpError::Secret(e.to_string()))?;
        Ok(text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default())
    }

    /// HTTP 服务器的 Token。
    ///
    /// # Arguments
    ///
    /// * `id` - 服务器 id。
    ///
    /// # Returns
    ///
    /// Token；没有保存时为 `None`。
    ///
    /// # Errors
    ///
    /// 凭据存储不可用时返回 [`McpError::Secret`]。
    pub fn token(&self, id: &str) -> Result<Option<String>> {
        self.secrets.get(&token_key(id)).map_err(|e| McpError::Secret(e.to_string()))
    }

    /// 新增或更新服务器。改了连接方式（指纹变化）的需要重新确认。
    ///
    /// # Arguments
    ///
    /// * `input` - 输入。
    ///
    /// # Returns
    ///
    /// 保存后的视图。
    ///
    /// # Errors
    ///
    /// 字段不合规（[`McpError::Invalid`]）、id 不存在（[`McpError::UnknownServer`]）、服务器过多、
    /// 凭据存储或写盘失败。
    pub fn save(&self, input: &ServerInput) -> Result<ServerView> {
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            return Err(McpError::Invalid(format!("name must be 1-{MAX_NAME_CHARS} characters")));
        }
        let transport = normalize_transport(&input.transport)?;
        let mut servers = self.servers.lock();
        let id = if let Some(id) = &input.id {
            if !servers.iter().any(|s| &s.id == id) {
                return Err(McpError::UnknownServer);
            }
            id.clone()
        } else {
            if servers.len() >= MAX_SERVERS {
                return Err(McpError::Invalid(format!("at most {MAX_SERVERS} servers")));
            }
            let base: String = name.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
            let base = base.trim_matches('-').chars().take(24).collect::<String>();
            let base = if base.is_empty() { "server".to_owned() } else { base };
            let mut id = base.clone();
            let mut n = 2;
            while servers.iter().any(|s| s.id == id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            id
        };
        let approved = servers.iter().find(|s| s.id == id).and_then(|s| s.approved.clone());
        // 指纹没变时沿用确认
        let approved = approved.filter(|fp| *fp == fingerprint(&transport));
        let saved = ServerConfig { id: id.clone(), name: name.to_owned(), enabled: input.enabled, transport, approved };
        if let Some(slot) = servers.iter_mut().find(|s| s.id == id) {
            *slot = saved.clone();
        } else {
            servers.push(saved.clone());
        }
        // 密钥：环境变量只保留配置里列出的名字
        if let Transport::Stdio { env_names, .. } = &saved.transport {
            let mut env = match &input.env {
                Some(env) => env.clone(),
                None => self.env(&id)?,
            };
            env.retain(|k, _| env_names.contains(k));
            let text = serde_json::to_string(&env).map_err(|e| McpError::Invalid(e.to_string()))?;
            if env.is_empty() { self.secrets.delete(&env_key(&id)) } else { self.secrets.set(&env_key(&id), &text) }
                .map_err(|e| McpError::Secret(e.to_string()))?;
        }
        if let Some(token) = &input.token {
            let token = token.trim();
            if token.chars().count() > 4096 || token.chars().any(char::is_control) {
                return Err(McpError::Invalid("token is too long or has control characters".into()));
            }
            if token.is_empty() { self.secrets.delete(&token_key(&id)) } else { self.secrets.set(&token_key(&id), token) }
                .map_err(|e| McpError::Secret(e.to_string()))?;
        }
        self.persist(&servers)?;
        drop(servers);
        Ok(self.view(saved))
    }

    /// 记下用户确认过的指纹（必须与当前指纹一致，避免确认的是旧内容）。
    ///
    /// # Arguments
    ///
    /// * `id` - 服务器 id。
    /// * `fingerprint` - 界面上展示时的指纹。
    ///
    /// # Returns
    ///
    /// 更新后的视图。
    ///
    /// # Errors
    ///
    /// 服务器不存在、指纹已过期（[`McpError::NeedsApproval`]）或写盘失败。
    pub fn approve(&self, id: &str, fp: &str) -> Result<ServerView> {
        let mut servers = self.servers.lock();
        let slot = servers.iter_mut().find(|s| s.id == id).ok_or(McpError::UnknownServer)?;
        if fingerprint(&slot.transport) != fp {
            return Err(McpError::NeedsApproval);
        }
        slot.approved = Some(fp.to_owned());
        let saved = slot.clone();
        self.persist(&servers)?;
        drop(servers);
        Ok(self.view(saved))
    }

    /// 从回收站恢复一个服务器配置：id 被占用时换一个；确认状态清除（要重新确认）。密钥删除时已清除，需要重新填写。
    ///
    /// # Arguments
    ///
    /// * `config` - 删除前的配置。
    ///
    /// # Returns
    ///
    /// 恢复后的视图。
    ///
    /// # Errors
    ///
    /// 配置不合规、服务器过多或写盘失败。
    pub fn restore(&self, config: &ServerConfig) -> Result<ServerView> {
        let transport = normalize_transport(&config.transport)?;
        let name = config.name.trim();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            return Err(McpError::Invalid("invalid name".into()));
        }
        let mut servers = self.servers.lock();
        if servers.len() >= MAX_SERVERS {
            return Err(McpError::Invalid(format!("at most {MAX_SERVERS} servers")));
        }
        let valid = |s: &str| !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        let base = if valid(&config.id) { config.id.clone() } else { "server".to_owned() };
        let mut id = base.clone();
        let mut n = 2;
        while servers.iter().any(|s| s.id == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        let saved = ServerConfig { id, name: name.to_owned(), enabled: config.enabled, transport, approved: None };
        servers.push(saved.clone());
        self.persist(&servers)?;
        drop(servers);
        Ok(self.view(saved))
    }

    /// 删除服务器（同时清除它的密钥）。
    ///
    /// # Arguments
    ///
    /// * `id` - 服务器 id。
    ///
    /// # Returns
    ///
    /// 删除前的配置（前端放进回收站，恢复时重新保存）。
    ///
    /// # Errors
    ///
    /// 不存在时返回 [`McpError::UnknownServer`]；写盘失败时返回 [`McpError::Io`]。
    pub fn delete(&self, id: &str) -> Result<ServerConfig> {
        let mut servers = self.servers.lock();
        let at = servers.iter().position(|s| s.id == id).ok_or(McpError::UnknownServer)?;
        let removed = servers.remove(at);
        self.persist(&servers)?;
        drop(servers);
        let _ = self.secrets.delete(&env_key(id));
        let _ = self.secrets.delete(&token_key(id));
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ai_gateway::MemoryStore;

    fn stdio(command: &str, args: &[&str]) -> Transport {
        Transport::Stdio { command: command.into(), args: args.iter().map(|s| (*s).to_owned()).collect(), cwd: None, env_names: vec!["API_KEY".into()] }
    }

    fn store() -> (tempfile::TempDir, ConfigStore, Arc<MemoryStore>) {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemoryStore::default());
        let s = ConfigStore::load(dir.path().join("mcp-servers.json"), secrets.clone());
        (dir, s, secrets)
    }

    #[test]
    fn 保存_确认_改命令后要重新确认_密钥不落盘() {
        let (dir, s, _) = store();
        let input = ServerInput {
            id: None,
            name: "Files Server".into(),
            enabled: true,
            transport: stdio(" npx ", &["-y", "@scope/server", "C:/My Docs"]),
            env: Some(BTreeMap::from([("API_KEY".into(), "sk-secret".into()), ("EXTRA".into(), "x".into())])),
            token: None,
        };
        let v = s.save(&input).unwrap();
        assert_eq!(v.config.id, "files-server");
        assert!(v.needs_approval);
        assert_eq!(v.summary, "npx -y @scope/server \"C:/My Docs\"\n(env: API_KEY)");
        assert_eq!(s.env("files-server").unwrap(), BTreeMap::from([("API_KEY".into(), "sk-secret".into())]));
        let text = std::fs::read_to_string(dir.path().join("mcp-servers.json")).unwrap();
        assert!(!text.contains("sk-secret"));

        assert!(matches!(s.approve("files-server", "0000"), Err(McpError::NeedsApproval)));
        let ok = s.approve("files-server", &v.fingerprint).unwrap();
        assert!(!ok.needs_approval);

        // 只改名字：指纹不变，确认还在；环境变量不传时保持
        let renamed = s.save(&ServerInput { id: Some("files-server".into()), name: "Files".into(), env: None, ..input.clone() }).unwrap();
        assert!(!renamed.needs_approval);
        assert_eq!(s.env("files-server").unwrap().get("API_KEY").map(String::as_str), Some("sk-secret"));
        // 改参数：要重新确认
        let changed = s.save(&ServerInput { id: Some("files-server".into()), transport: stdio("npx", &["-y", "other"]), env: None, ..input.clone() }).unwrap();
        assert!(changed.needs_approval);

        // 第二个同名：id 加序号
        assert_eq!(s.save(&input).unwrap().config.id, "files-server-2");
        let removed = s.delete("files-server").unwrap();
        assert_eq!(removed.transport, stdio("npx", &["-y", "other"]));
        assert!(s.env("files-server").unwrap().is_empty());
    }

    #[test]
    fn 地址与字段校验() {
        assert!(normalize_transport(&Transport::Http { url: "https://mcp.example.com/mcp".into() }).is_ok());
        assert!(normalize_transport(&Transport::Http { url: "http://127.0.0.1:3000/mcp".into() }).is_ok());
        assert!(normalize_transport(&Transport::Http { url: "http://mcp.example.com/mcp".into() }).is_err());
        assert!(normalize_transport(&Transport::Http { url: "https://u:p@x.com".into() }).is_err());
        assert!(normalize_transport(&stdio("", &[])).is_err());
        assert!(normalize_transport(&stdio("npx", &["a\nb"])).is_err());
        let bad_env = Transport::Stdio { command: "x".into(), args: vec![], cwd: None, env_names: vec!["1BAD".into()] };
        assert!(normalize_transport(&bad_env).is_err());
    }

    #[test]
    fn http_token_进凭据管理器() {
        let (_dir, s, secrets) = store();
        let v = s
            .save(&ServerInput { id: None, name: "Remote".into(), enabled: true, transport: Transport::Http { url: "https://x.com/mcp".into() }, env: None, token: Some(" tk ".into()) })
            .unwrap();
        assert!(v.has_token);
        assert_eq!(secrets.get("mcp-token:remote").unwrap().as_deref(), Some("tk"));
        let v = s
            .save(&ServerInput { id: Some("remote".into()), name: "Remote".into(), enabled: true, transport: Transport::Http { url: "https://x.com/mcp".into() }, env: None, token: Some(String::new()) })
            .unwrap();
        assert!(!v.has_token);
    }
}
