//! ESP32-P4 核心板连接句柄：保存目标地址与连接状态。

use std::sync::{Arc, Mutex};

use serde::Serialize;

/// 核心板连接配置与状态（前端 DTO，camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EspConfig {
    /// 核心板主机/IP。
    pub host: String,
    /// 控制端口（TCP 1227）。
    pub tcp_port: u16,
    /// 文件服务 HTTP 端口。
    pub http_port: u16,
    /// 是否已连接（最近一次探测可达）。
    pub connected: bool,
}

impl Default for EspConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            tcp_port: 1227,
            http_port: 80,
            connected: false,
        }
    }
}

/// 核心板句柄：共享连接配置。
#[derive(Clone, Default)]
pub struct EspHandle {
    cfg: Arc<Mutex<EspConfig>>,
}

impl EspHandle {
    /// 创建句柄（默认未配置）。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 读取当前配置快照。
    #[must_use]
    pub fn config(&self) -> EspConfig {
        self.cfg.lock().map(|c| c.clone()).unwrap_or_default()
    }

    /// 设置目标地址。
    ///
    /// # Arguments
    ///
    /// * `host` - 主机/IP。
    /// * `tcp_port` - 控制端口。
    /// * `http_port` - 文件服务端口。
    pub fn set_target(&self, host: String, tcp_port: u16, http_port: u16) {
        if let Ok(mut c) = self.cfg.lock() {
            c.host = host;
            c.tcp_port = tcp_port;
            c.http_port = http_port;
        }
    }

    /// 更新连接状态。
    pub fn set_connected(&self, connected: bool) {
        if let Ok(mut c) = self.cfg.lock() {
            c.connected = connected;
        }
    }
}
