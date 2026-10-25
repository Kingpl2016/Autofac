//! 测试信号发生器（Signal Checker 的后端核心）。
//!
//! - [`pattern`]：15 种测试图案的确定性渲染与相位时钟（纯逻辑，可用虚拟时间测试）。
//! - [`config`]：发送配置与校验（IP、端口、协议、Universe 范围）。
//! - [`manual`]：手动模式下各 Universe 的通道数据。
//! - [`sender`]：44Hz UDP 发送器（后台任务 + 控制句柄），支持运行中改配置并正确收尾。
//!
//! 本 crate 与 Tauri 无关：窗口、命令与事件由应用壳装配。

pub mod config;
pub mod manual;
pub mod pattern;
pub mod sender;

pub use config::{
    ConfigError, SignalConfig, SignalProtocol, ValidConfig, ARTNET_PORT, MAX_UNIVERSES, SACN_PORT,
};
pub use manual::{ManualData, ManualError};
pub use pattern::{
    all_patterns, clamp_speed, render, Clock, PatternGroup, PatternId, PatternInfo, CHANNELS,
    MAX_SPEED, MIN_SPEED, SPEED_STEPS,
};
pub use sender::{
    EventSink, SendMode, SenderError, SenderEvent, SenderStatus, SignalSender, SEND_RATE_HZ,
};
