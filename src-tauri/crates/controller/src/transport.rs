//! 核心板文件 CRUD 传输抽象与默认 HTTP 实现。
//!
//! 控制指令走 TCP 1227；但 `.artrec` 文件可能较大且需断点续传，故文件 CRUD
//! 另走核心板上的 HTTP 服务（ESP-IDF `esp_http_server`）。传输以
//! [`DeviceTransport`] trait 抽象，便于将来回退到 1227 分组传输。
//!
//! # 安全提示
//!
//! 该文件通道默认无鉴权、内网明文；预留 token（见 [`HttpTransport::with_token`]）。
//!
//! # 待与固件对齐的 REST 约定
//!
//! - `GET  /files`           → 文件条目 JSON 数组
//! - `GET  /files/{name}`    → 文件内容（支持 Range 续传）
//! - `PUT  /files/{name}`    → 上传/覆盖（请求体为文件字节）
//! - `DELETE /files/{name}`  → 删除
//! - `POST /rename`          → JSON `{ "from": ..., "to": ... }`

use async_trait::async_trait;

use crate::error::Result;
use crate::model::FileEntry;

/// 核心板文件传输抽象（list / read / write / delete / rename）。
#[async_trait]
pub trait DeviceTransport: Send + Sync {
    /// 列出 SD 卡文件。
    ///
    /// # Errors
    ///
    /// 请求失败返回 [`ControllerError::Http`]。
    async fn list_files(&self) -> Result<Vec<FileEntry>>;

    /// 下载文件全部字节。
    ///
    /// # Arguments
    ///
    /// * `name` - 文件名。
    ///
    /// # Errors
    ///
    /// 请求失败返回 [`ControllerError::Http`]。
    async fn read_file(&self, name: &str) -> Result<Vec<u8>>;

    /// 上传/覆盖文件。
    ///
    /// # Arguments
    ///
    /// * `name` - 文件名。
    /// * `bytes` - 文件内容。
    ///
    /// # Errors
    ///
    /// 请求失败返回 [`ControllerError::Http`]。
    async fn write_file(&self, name: &str, bytes: Vec<u8>) -> Result<()>;

    /// 删除文件。
    ///
    /// # Arguments
    ///
    /// * `name` - 文件名。
    ///
    /// # Errors
    ///
    /// 请求失败返回 [`ControllerError::Http`]。
    async fn delete_file(&self, name: &str) -> Result<()>;

    /// 重命名文件。
    ///
    /// # Arguments
    ///
    /// * `from` - 原文件名。
    /// * `to` - 新文件名。
    ///
    /// # Errors
    ///
    /// 请求失败返回 [`ControllerError::Http`]。
    async fn rename_file(&self, from: &str, to: &str) -> Result<()>;
}

/// 基于 HTTP 的默认文件传输实现。
pub struct HttpTransport {
    base: String,
    token: Option<String>,
    client: reqwest::Client,
}

impl HttpTransport {
    /// 以主机与端口创建 HTTP 传输。
    ///
    /// # Arguments
    ///
    /// * `host` - 核心板 IP 或主机名。
    /// * `port` - HTTP 端口（ESP-IDF 默认 80）。
    #[must_use]
    pub fn new(host: &str, port: u16) -> Self {
        Self {
            base: format!("http://{host}:{port}"),
            token: None,
            client: reqwest::Client::new(),
        }
    }

    /// 设置可选 Bearer token（预留鉴权）。
    #[must_use]
    pub fn with_token(mut self, token: Option<String>) -> Self {
        self.token = token;
        self
    }

    fn req(&self, method: reqwest::Method, url: String) -> reqwest::RequestBuilder {
        let mut b = self.client.request(method, url);
        if let Some(t) = &self.token {
            b = b.bearer_auth(t);
        }
        b
    }

    /// 发送请求并要求响应为 2xx，统一错误处理。
    async fn send_ok(&self, b: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        Ok(b.send().await?.error_for_status()?)
    }
}

#[async_trait]
impl DeviceTransport for HttpTransport {
    async fn list_files(&self) -> Result<Vec<FileEntry>> {
        let url = format!("{}/files", self.base);
        Ok(self
            .send_ok(self.req(reqwest::Method::GET, url))
            .await?
            .json::<Vec<FileEntry>>()
            .await?)
    }

    async fn read_file(&self, name: &str) -> Result<Vec<u8>> {
        let url = format!("{}/files/{}", self.base, name);
        Ok(self
            .send_ok(self.req(reqwest::Method::GET, url))
            .await?
            .bytes()
            .await?
            .to_vec())
    }

    async fn write_file(&self, name: &str, bytes: Vec<u8>) -> Result<()> {
        let url = format!("{}/files/{}", self.base, name);
        self.send_ok(self.req(reqwest::Method::PUT, url).body(bytes))
            .await?;
        Ok(())
    }

    async fn delete_file(&self, name: &str) -> Result<()> {
        let url = format!("{}/files/{}", self.base, name);
        self.send_ok(self.req(reqwest::Method::DELETE, url)).await?;
        Ok(())
    }

    async fn rename_file(&self, from: &str, to: &str) -> Result<()> {
        let url = format!("{}/rename", self.base);
        self.send_ok(
            self.req(reqwest::Method::POST, url)
                .json(&serde_json::json!({ "from": from, "to": to })),
        )
        .await?;
        Ok(())
    }
}
