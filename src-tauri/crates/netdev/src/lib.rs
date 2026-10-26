//! 网络设备（ESP32-P4 核心板）HTTP 客户端库。
//!
//! 固件只暴露 HTTP 接口（见 `esp32p4_artnet/docs/protocol.md`），本库对其做完整封装：
//!
//! - [`client`]：状态 / 工作模式 / 节目 / 播放器 / 配置 / 诊断 / 日志 / 文件管理 / OTA 状态。
//! - [`transfer`]：节目文件上传下载与固件 OTA 推送（流式、带进度、可取消）。
//! - [`firmware`]：固件镜像上传前预检。
//! - [`registry`]：多设备注册表（JSON 持久化）与 [`secret`] 凭据存储（Token 不落盘）。
//! - [`validate`]：请求发出前的本地校验，规则镜像固件。
//!
//! 本库不依赖 Tauri，宿主层只需把它包成命令。

pub mod client;
pub mod error;
pub mod firmware;
pub mod model;
pub mod registry;
pub mod secret;
pub mod transfer;
pub mod validate;

pub use client::DeviceClient;
pub use error::{ErrorPayload, NetdevError, Result};
pub use firmware::FirmwareInfo;
pub use registry::{DeviceInput, DeviceRegistry, DeviceView, SavedDevice};
pub use secret::{KeyringStore, MemoryStore, SecretStore};
pub use transfer::{Progress, ProgressFn, TransferGuard, TransferTable};
