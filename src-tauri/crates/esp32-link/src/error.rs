//! ESP32-P4 链路错误类型。

use thiserror::Error;

/// 核心板链路（指令协议与文件传输）错误。
#[derive(Debug, Error)]
pub enum EspError {
    /// 帧头非法。
    #[error("帧头非法：期望 0x35，实际 {0:#04X}")]
    BadHeader(u8),

    /// 操作码非法。
    #[error("通信定义/操作码非法：{0:#04X}")]
    BadOpcode(u8),

    /// 帧长度不足。
    #[error("帧数据截断")]
    Truncated,

    /// 校验和不符。
    #[error("校验和不符：期望 {expected:#04X}，实际 {actual:#04X}")]
    BadChecksum {
        /// 帧内声明的校验和。
        expected: u8,
        /// 实际计算的校验和。
        actual: u8,
    },

    /// 底层 IO / 网络错误（保留源错误以便诊断）。
    #[error("网络错误：{0}")]
    Io(#[from] std::io::Error),

    /// HTTP 文件传输错误（保留源错误以便诊断）。
    #[error("文件传输错误：{0}")]
    Http(#[from] reqwest::Error),

    /// 操作超时。
    #[error("操作超时")]
    Timeout,
}

/// 链路操作的便捷 `Result` 别名。
pub type Result<T> = std::result::Result<T, EspError>;
