//! 固件 HTTP 控制类接口客户端（状态 / 模式 / 节目 / 播放器 / 配置 / 诊断 / 日志 / 文件管理 / OTA 状态）。
//!
//! 流式传输（上传、下载、OTA 推送）见 [`crate::transfer`]。

use std::time::Duration;

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::{Method, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::error::{NetdevError, Result};
use crate::model::{
    ConfigPatch, ConfigResult, DeviceConfig, DeviceStatus, Diag, FileEntry, OtaStatus,
    PlayerStatus, ProgramEntry,
};
use crate::validate::{check_host, check_port, check_program_file_name, check_token};

/// 控制类请求的整体超时。
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
/// 建立连接的超时。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// 路径段编码集：仅保留 RFC3986 非保留字符。
///
/// 固件的 `url_decode` 会把 `+` 解成空格，所以 `+` 必须被编码为 `%2B`。
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// 单台设备的 HTTP 客户端。
#[derive(Clone)]
pub struct DeviceClient {
    base: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl std::fmt::Debug for DeviceClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 不输出 Token。
        f.debug_struct("DeviceClient")
            .field("base", &self.base)
            .field("has_token", &self.token.is_some())
            .finish_non_exhaustive()
    }
}

impl DeviceClient {
    /// 创建客户端。
    ///
    /// # Arguments
    ///
    /// * `host` - 设备 IP 或主机名（不带协议与端口）。
    /// * `port` - HTTP 端口，通常为 80。
    /// * `token` - 可选 Bearer Token。
    ///
    /// # Errors
    ///
    /// 主机、端口或 Token 格式非法，或 HTTP 客户端构建失败时返回 [`NetdevError`]。
    pub fn new(host: &str, port: u16, token: Option<String>) -> Result<Self> {
        let host = check_host(host)?;
        check_port(port)?;
        if let Some(t) = &token {
            check_token(t)?;
        }
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .no_proxy()
            .build()?;
        Ok(Self {
            base: format!("http://{host}:{port}"),
            token: token.filter(|t| !t.is_empty()),
            http,
        })
    }

    /// 设备基础地址（不含 Token）。
    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// 构造带鉴权头的请求。
    pub(crate) fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let mut rb = self.http.request(method, format!("{}{path}", self.base));
        if let Some(t) = &self.token {
            rb = rb.bearer_auth(t);
        }
        rb
    }

    /// `/files/{name}` 路径（文件名经百分号编码）。
    pub(crate) fn file_path(name: &str) -> String {
        format!("/files/{}", utf8_percent_encode(name, SEGMENT))
    }

    /// 检查响应状态，非 2xx 时解析 `{"error":name}` 转为 [`NetdevError`]。
    pub(crate) async fn check(resp: Response) -> Result<Response> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let body = resp.text().await.unwrap_or_default();
        let name = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned));
        Err(NetdevError::from_response(status.as_u16(), name.as_deref()))
    }

    /// 发送控制类请求（带整体超时）并检查状态。
    async fn send(&self, rb: RequestBuilder) -> Result<Response> {
        Self::check(rb.timeout(CONTROL_TIMEOUT).send().await?).await
    }

    /// 发送并解析 JSON 响应体。
    async fn send_json<T: DeserializeOwned>(&self, rb: RequestBuilder) -> Result<T> {
        let text = self.send(rb).await?.text().await?;
        serde_json::from_str(&text).map_err(|e| NetdevError::BadResponse(e.to_string()))
    }

    // ===================== 状态与控制 =====================

    /// 读取设备状态（`GET /api/status`）。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn status(&self) -> Result<DeviceStatus> {
        self.send_json(self.request(Method::GET, "/api/status")).await
    }

    /// 读取工作模式（`GET /api/workmode`）。
    ///
    /// # Returns
    ///
    /// 模式号 0~5。
    ///
    /// # Errors
    ///
    /// 网络或设备错误，或响应缺少 `mode` 字段时返回 [`NetdevError`]。
    pub async fn workmode(&self) -> Result<u8> {
        let v: serde_json::Value = self.send_json(self.request(Method::GET, "/api/workmode")).await?;
        v.get("mode")
            .and_then(serde_json::Value::as_u64)
            .and_then(|m| u8::try_from(m).ok())
            .ok_or_else(|| NetdevError::BadResponse("缺少 mode".into()))
    }

    /// 设置工作模式（`PUT /api/workmode`）。
    ///
    /// # Arguments
    ///
    /// * `mode` - 模式号 0~5。
    ///
    /// # Errors
    ///
    /// 模式越界、网络或设备错误时返回 [`NetdevError`]。
    pub async fn set_workmode(&self, mode: u8) -> Result<()> {
        if mode > 5 {
            return Err(NetdevError::Invalid("工作模式必须在 0~5 之间".into()));
        }
        self.send(self.request(Method::PUT, "/api/workmode").json(&json!({ "mode": mode })))
            .await
            .map(drop)
    }

    /// 设备操作（`POST /api/board`）。
    ///
    /// # Arguments
    ///
    /// * `op` - 0 复位 / 1 恢复出厂 / 2 自检。
    ///
    /// # Errors
    ///
    /// 操作码越界、网络或设备错误时返回 [`NetdevError`]。
    pub async fn board_op(&self, op: u8) -> Result<()> {
        if op > 2 {
            return Err(NetdevError::Invalid("设备操作码必须在 0~2 之间".into()));
        }
        self.send(self.request(Method::POST, "/api/board").json(&json!({ "op": op })))
            .await
            .map(drop)
    }

    /// 节目操作（`POST /api/program`）。
    ///
    /// # Arguments
    ///
    /// * `no` - 节目号 1~255。
    /// * `action` - 0 停止 / 1 暂停 / 2 单次 / 3 循环 / 4 删除。录制（5）固件不支持，本地直接拒绝。
    ///
    /// # Errors
    ///
    /// 参数越界、网络或设备错误（含 409 模式不允许）时返回 [`NetdevError`]。
    pub async fn program_op(&self, no: u16, action: u8) -> Result<()> {
        if !(1..=255).contains(&no) {
            return Err(NetdevError::Invalid("节目号必须在 1~255 之间".into()));
        }
        match action {
            0..=4 => {}
            5 => return Err(NetdevError::NotSupported),
            _ => return Err(NetdevError::Invalid("节目操作码必须在 0~4 之间".into())),
        }
        self.send(
            self.request(Method::POST, "/api/program")
                .json(&json!({ "no": no, "action": action })),
        )
        .await
        .map(drop)
    }

    /// 读取播放器状态（`GET /api/player`）。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn player(&self) -> Result<PlayerStatus> {
        self.send_json(self.request(Method::GET, "/api/player")).await
    }

    /// 跳转播放位置（`POST /api/player/seek`）。
    ///
    /// # Arguments
    ///
    /// * `pos_ms` - 目标位置（毫秒）。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn seek(&self, pos_ms: u32) -> Result<()> {
        self.send(self.request(Method::POST, "/api/player/seek").json(&json!({ "posMs": pos_ms })))
            .await
            .map(drop)
    }

    /// 设置倍速（`POST /api/player/speed`）。
    ///
    /// # Arguments
    ///
    /// * `speed_x100` - 倍速 ×100，范围 25~200。
    ///
    /// # Errors
    ///
    /// 越界、网络或设备错误时返回 [`NetdevError`]。
    pub async fn set_speed(&self, speed_x100: u16) -> Result<()> {
        if !(25..=200).contains(&speed_x100) {
            return Err(NetdevError::Invalid("倍速必须在 25~200 之间（×100）".into()));
        }
        self.send(
            self.request(Method::POST, "/api/player/speed")
                .json(&json!({ "speedX100": speed_x100 })),
        )
        .await
        .map(drop)
    }

    // ===================== 配置 / 诊断 / 日志 =====================

    /// 读取设备配置（`GET /api/config`）。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn config(&self) -> Result<DeviceConfig> {
        self.send_json(self.request(Method::GET, "/api/config")).await
    }

    /// 写入配置补丁（`PUT /api/config`），固件对任一非法字段整体拒绝。
    ///
    /// # Arguments
    ///
    /// * `patch` - 仅包含需要修改字段的补丁。
    ///
    /// # Returns
    ///
    /// 写入结果，含是否需要重启。
    ///
    /// # Errors
    ///
    /// Token 格式非法、网络或设备错误时返回 [`NetdevError`]。
    pub async fn put_config(&self, patch: &ConfigPatch) -> Result<ConfigResult> {
        if let Some(t) = &patch.http_token {
            check_token(t)?;
        }
        self.send_json(self.request(Method::PUT, "/api/config").json(patch)).await
    }

    /// 读取运行期诊断（`GET /api/diag`）。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn diag(&self) -> Result<Diag> {
        self.send_json(self.request(Method::GET, "/api/diag")).await
    }

    /// 读取最近日志文本（`GET /api/logs`）。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn logs(&self) -> Result<String> {
        Ok(self.send(self.request(Method::GET, "/api/logs")).await?.text().await?)
    }

    // ===================== OTA 状态 =====================

    /// 读取 OTA 状态（`GET /api/ota/status`）。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn ota_status(&self) -> Result<OtaStatus> {
        self.send_json(self.request(Method::GET, "/api/ota/status")).await
    }

    /// 手动确认当前固件有效（`POST /api/ota/confirm`）。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn ota_confirm(&self) -> Result<()> {
        self.send(self.request(Method::POST, "/api/ota/confirm")).await.map(drop)
    }

    // ===================== 文件与节目映射 =====================

    /// 列出 SD 卡文件（`GET /files`），已过滤上传中的 `.part` 临时文件。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn list_files(&self) -> Result<Vec<FileEntry>> {
        let mut files: Vec<FileEntry> = self.send_json(self.request(Method::GET, "/files")).await?;
        files.retain(|f| {
            !std::path::Path::new(&f.name)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("part"))
        });
        Ok(files)
    }

    /// 列出节目映射（`GET /api/programs`）。
    ///
    /// # Errors
    ///
    /// 网络或设备错误时返回 [`NetdevError`]。
    pub async fn list_programs(&self) -> Result<Vec<ProgramEntry>> {
        #[derive(serde::Deserialize)]
        struct Wrap {
            #[serde(default)]
            programs: Vec<ProgramEntry>,
        }
        let w: Wrap = self.send_json(self.request(Method::GET, "/api/programs")).await?;
        Ok(w.programs)
    }

    /// 删除文件（`DELETE /files/{name}`）。
    ///
    /// # Arguments
    ///
    /// * `name` - 文件名。
    ///
    /// # Errors
    ///
    /// 文件名非法、正在播放（[`NetdevError::Busy`]）、网络或设备错误时返回 [`NetdevError`]。
    pub async fn delete_file(&self, name: &str) -> Result<()> {
        check_program_file_name(name)?;
        self.send(self.request(Method::DELETE, &Self::file_path(name))).await.map(drop)
    }

    /// 重命名文件（`POST /rename`）。
    ///
    /// # Arguments
    ///
    /// * `from` - 原文件名。
    /// * `to` - 新文件名。
    ///
    /// # Errors
    ///
    /// 文件名非法、网络或设备错误时返回 [`NetdevError`]。
    pub async fn rename_file(&self, from: &str, to: &str) -> Result<()> {
        check_program_file_name(from)?;
        check_program_file_name(to)?;
        self.send(
            self.request(Method::POST, "/rename")
                .json(&json!({ "from": from, "to": to })),
        )
        .await
        .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client_for(server: &MockServer, token: Option<&str>) -> DeviceClient {
        let addr = server.address();
        DeviceClient::new(&addr.ip().to_string(), addr.port(), token.map(str::to_owned)).unwrap()
    }

    #[test]
    fn rejects_bad_host_and_token() {
        assert!(DeviceClient::new("http://x", 80, None).is_err());
        assert!(DeviceClient::new("1.2.3.4", 0, None).is_err());
        assert!(DeviceClient::new("1.2.3.4", 80, Some("short".into())).is_err());
        let c = DeviceClient::new("1.2.3.4", 80, Some("abcd1234".into())).unwrap();
        assert!(!format!("{c:?}").contains("abcd1234"));
    }

    #[test]
    fn encodes_file_names() {
        assert_eq!(DeviceClient::file_path("a b+c.artrec"), "/files/a%20b%2Bc.artrec");
        assert_eq!(DeviceClient::file_path("开场.artrec"), "/files/%E5%BC%80%E5%9C%BA.artrec");
    }

    #[tokio::test]
    async fn status_parses_and_sends_bearer() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/status"))
            .and(header("authorization", "Bearer abcd1234"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "version": "1.2.3", "workMode": 4, "ip": "10.0.0.2", "netmask": "255.255.255.0",
                "gateway": "10.0.0.1", "viaDhcp": true, "linkUp": true, "sdMounted": true,
                "sdTotal": 1000, "sdFree": 400,
                "player": { "state": 2, "programNo": 3, "posMs": 10, "durMs": 100 }
            })))
            .mount(&server)
            .await;
        let s = client_for(&server, Some("abcd1234")).status().await.unwrap();
        assert_eq!(s.version, "1.2.3");
        assert_eq!(s.work_mode, 4);
        assert_eq!(s.sd_free, Some(400));
        assert_eq!(s.player.program_no, 3);
    }

    #[tokio::test]
    async fn maps_error_statuses() {
        let server = MockServer::start().await;
        for (p, status, name) in [
            ("/api/board", 401, "unauthorized"),
            ("/api/program", 409, "wrong_mode"),
            ("/api/workmode", 507, "no_space"),
        ] {
            Mock::given(path(p))
                .respond_with(ResponseTemplate::new(status).set_body_json(json!({ "error": name })))
                .mount(&server)
                .await;
        }
        let c = client_for(&server, None);
        assert!(matches!(c.board_op(0).await, Err(NetdevError::Unauthorized)));
        assert!(matches!(c.program_op(1, 2).await, Err(NetdevError::WrongMode)));
        assert!(matches!(c.set_workmode(1).await, Err(NetdevError::NoSpace)));
    }

    #[tokio::test]
    async fn local_validation_sends_no_request() {
        let server = MockServer::start().await;
        let c = client_for(&server, None);
        assert!(matches!(c.set_workmode(6).await, Err(NetdevError::Invalid(_))));
        assert!(matches!(c.board_op(3).await, Err(NetdevError::Invalid(_))));
        assert!(matches!(c.program_op(0, 2).await, Err(NetdevError::Invalid(_))));
        assert!(matches!(c.program_op(1, 5).await, Err(NetdevError::NotSupported)));
        assert!(matches!(c.set_speed(24).await, Err(NetdevError::Invalid(_))));
        assert!(matches!(c.delete_file("a/b.artrec").await, Err(NetdevError::Invalid(_))));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn control_requests_send_expected_bodies() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/program"))
            .and(body_json(json!({ "no": 7, "action": 3 })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ok": true })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/api/config"))
            .and(body_json(json!({ "dhcp": false, "ip": "10.0.0.9" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "netRebootRequired": true })))
            .expect(1)
            .mount(&server)
            .await;
        let c = client_for(&server, None);
        c.program_op(7, 3).await.unwrap();
        let patch = ConfigPatch { dhcp: Some(false), ip: Some("10.0.0.9".into()), ..ConfigPatch::default() };
        let r = c.put_config(&patch).await.unwrap();
        assert!(r.ok && r.net_reboot_required);
    }

    #[tokio::test]
    async fn lists_files_hides_part_and_programs_unwrap() {
        let server = MockServer::start().await;
        Mock::given(path("/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "name": "a.artrec", "size": 10, "isDir": false, "program": 1 },
                { "name": "b.artrec.part", "size": 5, "isDir": false }
            ])))
            .mount(&server)
            .await;
        Mock::given(path("/api/programs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "programs": [{ "no": 1, "file": "a.artrec", "size": 10 }]
            })))
            .mount(&server)
            .await;
        let c = client_for(&server, None);
        let files = c.list_files().await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].program, Some(1));
        assert_eq!(c.list_programs().await.unwrap()[0].file, "a.artrec");
    }

    #[tokio::test]
    async fn bad_json_is_bad_response() {
        let server = MockServer::start().await;
        Mock::given(path("/api/player")).respond_with(ResponseTemplate::new(200).set_body_string("nope")).mount(&server).await;
        assert!(matches!(client_for(&server, None).player().await, Err(NetdevError::BadResponse(_))));
    }

    #[tokio::test]
    async fn unreachable_host_is_network_or_timeout() {
        // 127.0.0.1:1 通常无监听，连接应被拒绝。
        let c = DeviceClient::new("127.0.0.1", 1, None).unwrap();
        assert!(matches!(c.status().await, Err(NetdevError::Network(_) | NetdevError::Timeout)));
    }
}
