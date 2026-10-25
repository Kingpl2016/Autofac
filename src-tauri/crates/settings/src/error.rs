//! 配置存取错误类型。

use thiserror::Error;

/// 配置加载/保存/解析过程中的错误。
#[derive(Debug, Error)]
pub enum SettingsError {
    /// 底层 IO 错误。
    #[error("配置 IO 错误: {0}")]
    Io(#[from] std::io::Error),

    /// JSON 序列化/反序列化错误。
    #[error("配置 JSON 错误: {0}")]
    Json(#[from] serde_json::Error),
}

/// 配置操作的便捷 `Result` 别名。
pub type Result<T> = std::result::Result<T, SettingsError>;
