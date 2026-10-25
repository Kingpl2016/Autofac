//! 外接控制器（当前实现：ESP32-P4 核心板）。
//!
//! - [`protocol`]：TCP 1227 指令帧编解码（帧头 0x35 + 操作码 + 寄存器 + 校验和）。
//! - [`registers`]：寄存器枚举与高层指令帧构造（复位/工作模式/节目/通道）。
//! - [`tcp`]：按命令连接的指令客户端。
//! - [`transport`]：文件 CRUD 抽象 [`DeviceTransport`] 与默认 [`HttpTransport`]。
//! - [`model`]：文件条目模型。
//! - [`client`]：带连接状态的异步客户端句柄 [`ControllerHandle`]（宿主层包成 Tauri 命令即可）。

pub mod client;
pub mod error;
pub mod model;
pub mod protocol;
pub mod registers;
pub mod tcp;
pub mod transport;

pub use client::{ControllerConfig, ControllerHandle, ControllerStatus};
pub use error::{ControllerError, Result};
pub use model::FileEntry;
pub use protocol::{decode, encode, Frame, OpCode};
pub use registers::{
    board_op, get_work_mode, program_op, read_channels, set_work_mode, write_channels, BoardOp,
    ProgramAction, WorkMode,
};
pub use transport::{DeviceTransport, HttpTransport};
