//! AI 模型网关：节目编辑器 AI 助手的后端部分。
//!
//! 模型调用的协议细节（OpenAI 兼容 / Anthropic / Gemini 的请求体与流格式）全部在前端由 AI SDK 处理，
//! 本库只做前端不能、也不该做的事：
//!
//! - [`profile`]：厂商配置（接口地址、模型、温度等）持久化为 JSON；
//! - [`secret`]：API Key 存进系统凭据管理器，永远不写入 JSON、日志，也不返回给前端；
//! - [`proxy`]：流式 HTTP 代理。前端的 SDK 用占位 Key 构造请求，这里校验目标地址必须在配置的接口地址之下、
//!   丢弃前端带来的认证头并按厂商注入真实 Key，再把响应按 UTF-8 文本分块回传；
//! - [`history`]：工程旁的对话记录文件（`*.ai.json`）的读写。
//!
//! 本库不依赖 Tauri，宿主层只需把它包成命令。

pub mod error;
pub mod history;
pub mod models;
pub mod profile;
pub mod proxy;
pub mod secret;

pub use error::{AiError, AiErrorPayload, Result};
pub use models::{ModelInfo, ModelListInput, list_models, same_origin};
pub use profile::{Profile, ProfileInput, ProfileStore, ProfileView, ProviderKind, normalize_base_url};
pub use proxy::{ProxyEvent, ProxyGuard, ProxyRequest, ProxyTable, build_client, forward};
/// 代理用的 HTTP 客户端（宿主层不必直接依赖 `reqwest`）。
pub use reqwest::Client as HttpClient;
pub use secret::{KeyringStore, MemoryStore, SecretStore};
