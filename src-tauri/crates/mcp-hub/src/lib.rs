//! AI 助手的 MCP 客户端（只做客户端）。
//!
//! - [`config`]：服务器配置（`data/mcp-servers.json`），密钥进系统凭据管理器，命令指纹需用户确认；
//! - [`hub`]：stdio / Streamable HTTP 连接、工具列表、带超时与大小上限的工具调用。
//!
//! 每次工具调用由前端逐次征得用户同意（AI SDK 的 `needsApproval`），结果当成不可信数据交给模型。

pub mod config;
pub mod error;
pub mod hub;

pub use config::{ConfigStore, ServerConfig, ServerInput, ServerView, Transport};
pub use error::{McpError, Result};
pub use hub::{McpHub, ServerStatus, ToolInfo, ToolOutput};
