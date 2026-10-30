//! AI 网关错误类型与前端可见的错误载荷。

use serde::Serialize;
use thiserror::Error;

/// AI 网关操作错误。
#[derive(Debug, Error)]
pub enum AiError {
    /// 配置字段非法（名称、地址、模型、温度等）。
    #[error("{0}")]
    InvalidProfile(String),

    /// 配置不存在。
    #[error("AI 配置不存在")]
    UnknownProfile,

    /// 请求地址不在该配置的接口地址之下。
    #[error("请求地址不在配置的接口地址之下")]
    UrlNotAllowed,

    /// 非 HTTPS 且不是本机 / 局域网地址。
    #[error("只允许 HTTPS；HTTP 仅限本机或局域网地址")]
    InsecureUrl,

    /// 请求本身不合法（方法、请求体过大、id 为空或重复等）。
    #[error("{0}")]
    BadRequest(String),

    /// 无法连接或传输中断。
    #[error("网络错误：{0}")]
    Network(String),

    /// 请求超时。
    #[error("请求超时")]
    Timeout,

    /// 请求被取消。
    #[error("请求已取消")]
    Cancelled,

    /// 响应超过大小上限。
    #[error("响应过大")]
    ResponseTooLarge,

    /// 模型服务拒绝了 Key（HTTP 401 / 403）。
    #[error("模型服务拒绝了 API Key")]
    Unauthorized,

    /// 模型服务返回了其它非 2xx 状态。
    #[error("模型服务返回状态 {status}")]
    Http {
        /// HTTP 状态码。
        status: u16,
    },

    /// 响应无法按该接口的格式解析。
    #[error("响应无法解析：{0}")]
    BadResponse(String),

    /// 凭据存储（系统钥匙串）错误。
    #[error("凭据存储错误：{0}")]
    Secret(String),

    /// 本地文件读写错误。
    #[error("本地文件错误：{0}")]
    Io(String),

    /// 文件超过大小上限。
    #[error("文件过大")]
    FileTooLarge,

    /// 内容不是合法 JSON。
    #[error("内容不是合法的 JSON")]
    InvalidJson,

    /// 路径不合法（扩展名不对）。
    #[error("路径不合法")]
    BadPath,
}

/// 便捷 `Result` 别名。
pub type Result<T> = std::result::Result<T, AiError>;

impl AiError {
    /// 稳定的错误码，供前端据此映射国际化文案。
    ///
    /// # Returns
    ///
    /// 小写下划线风格的错误码。
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidProfile(_) => "invalid_profile",
            Self::UnknownProfile => "unknown_profile",
            Self::UrlNotAllowed => "url_not_allowed",
            Self::InsecureUrl => "insecure_url",
            Self::BadRequest(_) => "bad_request",
            Self::Network(_) => "network",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::ResponseTooLarge => "response_too_large",
            Self::Unauthorized => "unauthorized",
            Self::Http { .. } => "http_status",
            Self::BadResponse(_) => "bad_response",
            Self::Secret(_) => "secret",
            Self::Io(_) => "io",
            Self::FileTooLarge => "file_too_large",
            Self::InvalidJson => "invalid_json",
            Self::BadPath => "bad_path",
        }
    }
}

impl From<reqwest::Error> for AiError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            Self::Timeout
        } else {
            // 不带 URL：URL 里可能有查询参数形式的密钥（个别代理服务这样用）
            Self::Network(e.without_url().to_string())
        }
    }
}

impl From<std::io::Error> for AiError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

/// 前端可见的错误载荷（Tauri 命令的 `Err` 序列化形态）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AiErrorPayload {
    /// 稳定错误码，见 [`AiError::code`]。
    pub code: String,
    /// 面向用户的中文描述（不含 API Key）。
    pub message: String,
}

impl From<AiError> for AiErrorPayload {
    fn from(e: AiError) -> Self {
        Self { code: e.code().to_owned(), message: e.to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 载荷带错误码与描述() {
        let p = AiErrorPayload::from(AiError::UrlNotAllowed);
        assert_eq!(p.code, "url_not_allowed");
        assert!(!p.message.is_empty());
    }
}
