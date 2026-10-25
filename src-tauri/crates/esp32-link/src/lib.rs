//! ESP32-P4 核心板链路。
//!
//! - [`protocol`]：TCP 1227 指令帧编解码（帧头 0x35 + 操作码 + 寄存器 + 校验和）。
//! - [`registers`]：寄存器枚举与高层指令帧构造（复位/工作模式/节目/通道）。
//! - [`tcp`]：按命令连接的指令客户端。
//! - [`transport`]：文件 CRUD 抽象 [`DeviceTransport`] 与默认 [`HttpTransport`]。
//! - [`model`]：文件条目模型。

pub mod error;
pub mod model;
pub mod protocol;
pub mod registers;
pub mod tcp;
pub mod transport;

pub use error::{EspError, Result};
pub use model::FileEntry;
pub use protocol::{decode, encode, Frame, OpCode};
pub use registers::{
    board_op, get_work_mode, program_op, read_channels, set_work_mode, write_channels, BoardOp,
    ProgramAction, WorkMode,
};
pub use transport::{DeviceTransport, HttpTransport};
