//! 带连接状态的异步控制器客户端句柄。
//!
//! [`ControllerHandle`] 持有目标地址与连接状态，并提供控制指令（TCP 1227）与文件 CRUD（HTTP）
//! 的异步方法。写类指令 fire-and-forget（不等应答）以避免固件未应答时阻塞；读类等待应答。
//! 本模块不依赖 Tauri，宿主层只需把它包成 `#[tauri::command]` 薄封装。

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;

use crate::protocol::Frame;
use crate::registers::{self, BoardOp, ProgramAction, WorkMode};
use crate::transport::{DeviceTransport, HttpTransport};
use crate::{tcp, FileEntry};

/// 控制指令超时（毫秒）。
const CTRL_TIMEOUT_MS: u64 = 1500;

/// 获取互斥锁，中毒时恢复内部值而非 panic。
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 控制器连接配置与状态（前端 DTO，camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerConfig {
    /// 设备主机/IP。
    pub host: String,
    /// 控制端口（TCP 1227）。
    pub tcp_port: u16,
    /// 文件服务 HTTP 端口。
    pub http_port: u16,
    /// 是否已连接（最近一次探测可达）。
    pub connected: bool,
}

impl Default for ControllerConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            tcp_port: 1227,
            http_port: 80,
            connected: false,
        }
    }
}

/// 连接探测结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerStatus {
    /// 连接配置与状态。
    pub config: ControllerConfig,
    /// 探测到的当前工作模式（若可读）。
    pub work_mode: Option<u8>,
}

/// 控制器客户端句柄：共享连接配置，提供控制与文件异步方法。
#[derive(Clone, Default)]
pub struct ControllerHandle {
    cfg: Arc<Mutex<ControllerConfig>>,
}

impl ControllerHandle {
    /// 读取当前配置快照。
    #[must_use]
    pub fn config(&self) -> ControllerConfig {
        lock(&self.cfg).clone()
    }

    /// 已配置目标 `(host, tcp_port, http_port)`；未配置返回错误。
    fn target(&self) -> Result<(String, u16, u16), String> {
        let c = lock(&self.cfg);
        if c.host.trim().is_empty() {
            return Err("未配置控制器地址".to_string());
        }
        Ok((c.host.clone(), c.tcp_port, c.http_port))
    }

    /// 发送一条控制帧（fire-and-forget）。
    async fn send_ctrl(&self, frame: Vec<u8>) -> Result<(), String> {
        let (host, port, _) = self.target()?;
        tcp::send_command(&host, port, &frame, false, CTRL_TIMEOUT_MS)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// 发送一条查询帧并等待应答。
    async fn send_query(&self, frame: Vec<u8>) -> Result<Option<Frame>, String> {
        let (host, port, _) = self.target()?;
        tcp::send_command(&host, port, &frame, true, CTRL_TIMEOUT_MS)
            .await
            .map_err(|e| e.to_string())
    }

    /// 文件传输客户端。
    fn http(&self) -> Result<HttpTransport, String> {
        let (host, _, http_port) = self.target()?;
        Ok(HttpTransport::new(&host, http_port))
    }

    /// 配置目标并探测连接（读取工作模式）。
    ///
    /// # Errors
    ///
    /// 连接或读取失败时返回错误字符串（并将连接状态置为未连接）。
    pub async fn connect(
        &self,
        host: String,
        tcp_port: u16,
        http_port: u16,
    ) -> Result<ControllerStatus, String> {
        {
            let mut c = lock(&self.cfg);
            c.host.clone_from(&host);
            c.tcp_port = tcp_port;
            c.http_port = http_port;
        }
        let frame = registers::get_work_mode();
        match tcp::send_command(&host, tcp_port, &frame, true, CTRL_TIMEOUT_MS).await {
            Ok(resp) => {
                lock(&self.cfg).connected = true;
                Ok(ControllerStatus {
                    config: self.config(),
                    work_mode: resp.and_then(|f| f.data.first().copied()),
                })
            }
            Err(e) => {
                lock(&self.cfg).connected = false;
                Err(e.to_string())
            }
        }
    }

    /// 断开（标记未连接）。
    pub fn disconnect(&self) {
        lock(&self.cfg).connected = false;
    }

    /// 设备操作（0 复位 / 1 出厂 / 2 测试）。
    ///
    /// # Errors
    ///
    /// 非法操作码、未配置或发送失败时返回错误字符串。
    pub async fn board_op(&self, op: u8) -> Result<(), String> {
        let b = BoardOp::try_from(op).map_err(|()| "非法设备操作码".to_string())?;
        self.send_ctrl(registers::board_op(b)).await
    }

    /// 设置工作模式（0~5）。
    ///
    /// # Errors
    ///
    /// 非法模式或发送失败返回错误字符串。
    pub async fn set_work_mode(&self, mode: u8) -> Result<(), String> {
        let m = WorkMode::from_u8(mode).ok_or("非法工作模式")?;
        self.send_ctrl(registers::set_work_mode(m)).await
    }

    /// 读取工作模式。
    ///
    /// # Errors
    ///
    /// 发送失败或无应答返回错误字符串。
    pub async fn get_work_mode(&self) -> Result<u8, String> {
        let resp = self.send_query(registers::get_work_mode()).await?;
        resp.and_then(|f| f.data.first().copied())
            .ok_or_else(|| "控制器未返回工作模式".to_string())
    }

    /// 节目文件操作（programNo + action 0~5）。
    ///
    /// # Errors
    ///
    /// 非法动作或发送失败返回错误字符串。
    pub async fn program_op(&self, program_no: u8, action: u8) -> Result<(), String> {
        let a = ProgramAction::try_from(action).map_err(|()| "非法节目操作码".to_string())?;
        self.send_ctrl(registers::program_op(program_no, a)).await
    }

    /// 写通道。
    ///
    /// # Errors
    ///
    /// 发送失败返回错误字符串。
    pub async fn write_channels(
        &self,
        start: u8,
        unit_count: u8,
        unit_run: u8,
        values: &[u8],
    ) -> Result<(), String> {
        self.send_ctrl(registers::write_channels(start, unit_count, unit_run, values))
            .await
    }

    /// 读通道，返回应答帧中的数据。
    ///
    /// # Errors
    ///
    /// 发送失败或无应答返回错误字符串。
    pub async fn read_channels(
        &self,
        start: u8,
        unit_count: u8,
        unit_run: u8,
    ) -> Result<Vec<u8>, String> {
        let resp = self
            .send_query(registers::read_channels(start, unit_count, unit_run))
            .await?;
        Ok(resp.map(|f| f.data).unwrap_or_default())
    }

    /// 列出设备 SD 卡文件。
    ///
    /// # Errors
    ///
    /// 请求失败返回错误字符串。
    pub async fn list_files(&self) -> Result<Vec<FileEntry>, String> {
        self.http()?.list_files().await.map_err(|e| e.to_string())
    }

    /// 下载文件字节。
    ///
    /// # Errors
    ///
    /// 请求失败返回错误字符串。
    pub async fn download_file(&self, name: &str) -> Result<Vec<u8>, String> {
        self.http()?.read_file(name).await.map_err(|e| e.to_string())
    }

    /// 上传/覆盖文件。
    ///
    /// # Errors
    ///
    /// 请求失败返回错误字符串。
    pub async fn upload_file(&self, name: &str, data: Vec<u8>) -> Result<(), String> {
        self.http()?
            .write_file(name, data)
            .await
            .map_err(|e| e.to_string())
    }

    /// 删除文件。
    ///
    /// # Errors
    ///
    /// 请求失败返回错误字符串。
    pub async fn delete_file(&self, name: &str) -> Result<(), String> {
        self.http()?.delete_file(name).await.map_err(|e| e.to_string())
    }

    /// 重命名文件。
    ///
    /// # Errors
    ///
    /// 请求失败返回错误字符串。
    pub async fn rename_file(&self, from: &str, to: &str) -> Result<(), String> {
        self.http()?
            .rename_file(from, to)
            .await
            .map_err(|e| e.to_string())
    }
}
