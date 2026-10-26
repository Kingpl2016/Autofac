//! 网络设备错误类型。
//!
//! 固件错误体为 `{"error":"<name>"}`，HTTP 状态与内部状态一一对应（见 `docs/protocol.md` 第 2 节）。
//! 这里优先按错误名映射，错误名缺失或未知时回退到 HTTP 状态码。

use serde::Serialize;
use thiserror::Error;

/// 网络设备操作错误。
#[derive(Debug, Error)]
pub enum NetdevError {
    /// 设备要求鉴权但未提供或 Token 不正确（HTTP 401）。
    #[error("设备要求鉴权：请设置或更正 Token")]
    Unauthorized,

    /// 参数非法（HTTP 400）。
    #[error("参数非法")]
    InvalidArg,

    /// 编号或文件不存在（HTTP 404）。
    #[error("设备上未找到目标")]
    NotFound,

    /// 设备忙或文件正在播放（HTTP 409，`busy`）。
    #[error("设备忙或该文件正在播放")]
    Busy,

    /// 当前工作模式不允许该操作（HTTP 409，`wrong_mode`）。
    #[error("当前工作模式不允许此操作")]
    WrongMode,

    /// `.artrec` 校验失败（HTTP 422）。
    #[error("文件校验失败，不是有效的 .artrec")]
    BadFile,

    /// 固件未实现（HTTP 501）。
    #[error("设备不支持该操作")]
    NotSupported,

    /// 资源未就绪，例如 SD 卡未挂载（HTTP 503）。
    #[error("设备资源未就绪（如 SD 卡未挂载）")]
    NotReady,

    /// 设备存储空间不足（HTTP 507）。
    #[error("设备存储空间不足")]
    NoSpace,

    /// 设备内部 IO 错误（HTTP 500）。
    #[error("设备内部错误")]
    DeviceIo,

    /// 其它未识别的 HTTP 状态。
    #[error("设备返回异常状态 {status}")]
    Http {
        /// HTTP 状态码。
        status: u16,
    },

    /// 请求超时。
    #[error("请求超时")]
    Timeout,

    /// 无法连接到设备或传输中断。
    #[error("网络错误：{0}")]
    Network(String),

    /// 本地参数校验失败（文件名、主机等），未发出请求。
    #[error("{0}")]
    Invalid(String),

    /// 本地文件读写错误。
    #[error("本地文件错误：{0}")]
    LocalIo(String),

    /// 用户取消了传输。
    #[error("传输已取消")]
    Cancelled,

    /// 设备不在注册表中。
    #[error("设备不存在")]
    UnknownDevice,

    /// 凭据存储（系统钥匙串）错误。
    #[error("凭据存储错误：{0}")]
    Secret(String),

    /// 响应无法解析。
    #[error("设备响应无法解析：{0}")]
    BadResponse(String),
}

/// 便捷 `Result` 别名。
pub type Result<T> = std::result::Result<T, NetdevError>;

impl NetdevError {
    /// 稳定的错误码，供前端据此映射国际化文案。
    ///
    /// # Returns
    ///
    /// 小写下划线风格的错误码，与固件 `error` 字段命名一致。
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::InvalidArg => "invalid_arg",
            Self::NotFound => "not_found",
            Self::Busy => "busy",
            Self::WrongMode => "wrong_mode",
            Self::BadFile => "bad_file",
            Self::NotSupported => "not_supported",
            Self::NotReady => "not_ready",
            Self::NoSpace => "no_space",
            Self::DeviceIo => "device_io",
            Self::Http { .. } => "http",
            Self::Timeout => "timeout",
            Self::Network(_) => "network",
            Self::Invalid(_) => "invalid",
            Self::LocalIo(_) => "local_io",
            Self::Cancelled => "cancelled",
            Self::UnknownDevice => "unknown_device",
            Self::Secret(_) => "secret",
            Self::BadResponse(_) => "bad_response",
        }
    }

    /// 由固件响应（HTTP 状态 + 可选错误名）构造错误。
    ///
    /// # Arguments
    ///
    /// * `status` - HTTP 状态码。
    /// * `name` - 响应体 `{"error":"..."}` 中的错误名；缺失传 `None`。
    ///
    /// # Returns
    ///
    /// 与响应对应的错误变体。
    #[must_use]
    pub fn from_response(status: u16, name: Option<&str>) -> Self {
        match name {
            Some("unauthorized") => return Self::Unauthorized,
            Some("invalid_arg") => return Self::InvalidArg,
            Some("not_found") => return Self::NotFound,
            Some("busy") => return Self::Busy,
            Some("wrong_mode") => return Self::WrongMode,
            Some("bad_file") => return Self::BadFile,
            Some("not_supported") => return Self::NotSupported,
            Some("no_space") => return Self::NoSpace,
            Some("again") => return Self::NotReady,
            Some("io_error") => return Self::DeviceIo,
            _ => {}
        }
        match status {
            400 => Self::InvalidArg,
            401 => Self::Unauthorized,
            404 => Self::NotFound,
            409 => Self::Busy,
            422 => Self::BadFile,
            500 => Self::DeviceIo,
            501 => Self::NotSupported,
            503 => Self::NotReady,
            507 => Self::NoSpace,
            other => Self::Http { status: other },
        }
    }
}

impl From<reqwest::Error> for NetdevError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            Self::Timeout
        } else if e.is_decode() {
            Self::BadResponse(e.to_string())
        } else {
            Self::Network(e.without_url().to_string())
        }
    }
}

impl From<std::io::Error> for NetdevError {
    fn from(e: std::io::Error) -> Self {
        Self::LocalIo(e.to_string())
    }
}

/// 前端可见的错误载荷（Tauri 命令的 `Err` 序列化形态）。
#[derive(Debug, Clone, Serialize)]
pub struct ErrorPayload {
    /// 稳定错误码，见 [`NetdevError::code`]。
    pub code: &'static str,
    /// 面向用户的中文描述（不含 Token 等敏感信息）。
    pub message: String,
}

impl From<&NetdevError> for ErrorPayload {
    fn from(e: &NetdevError) -> Self {
        Self {
            code: e.code(),
            message: e.to_string(),
        }
    }
}

impl From<NetdevError> for ErrorPayload {
    fn from(e: NetdevError) -> Self {
        Self::from(&e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_takes_precedence_over_status() {
        assert!(matches!(
            NetdevError::from_response(409, Some("wrong_mode")),
            NetdevError::WrongMode
        ));
        assert!(matches!(
            NetdevError::from_response(409, Some("busy")),
            NetdevError::Busy
        ));
    }

    #[test]
    fn falls_back_to_status() {
        assert!(matches!(NetdevError::from_response(401, None), NetdevError::Unauthorized));
        assert!(matches!(NetdevError::from_response(422, None), NetdevError::BadFile));
        assert!(matches!(NetdevError::from_response(507, Some("???")), NetdevError::NoSpace));
        assert!(matches!(
            NetdevError::from_response(418, None),
            NetdevError::Http { status: 418 }
        ));
    }

    #[test]
    fn payload_has_code_and_message() {
        let p = ErrorPayload::from(NetdevError::Cancelled);
        assert_eq!(p.code, "cancelled");
        assert!(!p.message.is_empty());
    }
}
