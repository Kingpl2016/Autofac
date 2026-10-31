//! MCP 客户端的错误。

/// MCP 客户端的错误（`code` 给前端翻译）。
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    /// 配置不合规（名称、命令、地址…）。
    #[error("invalid server config: {0}")]
    Invalid(String),
    /// 服务器不存在。
    #[error("unknown server")]
    UnknownServer,
    /// 命令 / 地址还没经用户确认（或确认后改过）。
    #[error("the server command has not been approved")]
    NeedsApproval,
    /// 服务器已停用。
    #[error("the server is disabled")]
    Disabled,
    /// 没有连接（先连接）。
    #[error("not connected")]
    NotConnected,
    /// 工具不存在。
    #[error("unknown tool")]
    UnknownTool,
    /// 连接或调用超时。
    #[error("timed out")]
    Timeout,
    /// 启动进程或连接失败。
    #[error("connect failed: {0}")]
    Connect(String),
    /// 调用失败（协议错误、服务器报错）。
    #[error("call failed: {0}")]
    Call(String),
    /// 凭据存储不可用。
    #[error("secret store: {0}")]
    Secret(String),
    /// 读写配置失败。
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl McpError {
    /// 错误码。
    ///
    /// # Returns
    ///
    /// `invalid` / `unknown_server` / `needs_approval` / `disabled` / `not_connected` / `unknown_tool` /
    /// `timeout` / `connect` / `call` / `secret` / `io`。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::UnknownServer => "unknown_server",
            Self::NeedsApproval => "needs_approval",
            Self::Disabled => "disabled",
            Self::NotConnected => "not_connected",
            Self::UnknownTool => "unknown_tool",
            Self::Timeout => "timeout",
            Self::Connect(_) => "connect",
            Self::Call(_) => "call",
            Self::Secret(_) => "secret",
            Self::Io(_) => "io",
        }
    }
}

/// 结果类型。
pub type Result<T> = std::result::Result<T, McpError>;
