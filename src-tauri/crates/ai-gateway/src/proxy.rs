//! 流式 HTTP 代理：前端 AI SDK 的请求经这里发往模型接口，API Key 只在这里注入。
//!
//! 安全约束：
//!
//! - 目标地址必须与配置的接口地址同协议、同主机、同端口，路径在其之下（防止被诱导访问任意地址）；
//! - 只允许 HTTPS，HTTP 仅限本机 / 局域网（见 [`crate::profile`]）；
//! - 只转发白名单里的请求头，前端带来的任何认证头一律丢弃，再按厂商注入真实 Key；
//! - 请求体与响应各有大小上限，可随时取消。
//!
//! 响应按到达顺序回传：先 [`ProxyEvent::Head`]（状态码与响应头），再若干 [`ProxyEvent::Chunk`]
//! （UTF-8 文本；跨块的多字节字符会留到下一块拼完整），最后 [`ProxyEvent::End`]。
//! 非 2xx 状态同样完整回传响应体，由 SDK 按各家格式解析错误。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use parking_lot::Mutex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::error::{AiError, Result};
use crate::profile::{Profile, check_secure};

/// 请求体上限（对话历史 + 工具定义，足够宽裕）。
pub const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
/// 响应上限。
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
/// 建立连接的超时。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 两次读到数据之间的最长间隔（推理模型首个 token 之前可能思考很久）。
const READ_TIMEOUT: Duration = Duration::from_secs(300);

/// 允许从前端转发的请求头（小写）。认证头不在其中，由代理按配置注入。
const FORWARDED_HEADERS: &[&str] = &["content-type", "accept", "anthropic-version", "anthropic-beta"];

/// 不回传给前端的响应头（小写）。
const HIDDEN_RESPONSE_HEADERS: &[&str] = &["set-cookie"];

/// 一次代理请求（由前端的 `fetch` 实现组装）。
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    /// 请求 id（前端生成），用于取消。
    pub request_id: String,
    /// 使用的 AI 配置 id。
    pub profile_id: String,
    /// 完整的目标地址。
    pub url: String,
    /// HTTP 方法，只支持 `GET` / `POST`。
    pub method: String,
    /// 请求头（只有白名单里的会被转发）。
    pub headers: Vec<(String, String)>,
    /// 请求体（JSON 文本）。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub body: Option<String>,
}

/// 代理回传给前端的事件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ProxyEvent {
    /// 收到响应头。
    Head {
        /// HTTP 状态码。
        status: u16,
        /// 响应头（已去掉 `set-cookie`）。
        headers: Vec<(String, String)>,
    },
    /// 一段响应体文本。
    Chunk {
        /// UTF-8 文本。
        text: String,
    },
    /// 响应体结束。
    End,
}

/// 构造代理用的 HTTP 客户端（跟随系统代理，带连接与读取超时）。
///
/// # Arguments
///
/// * `user_agent` - `User-Agent` 请求头。
///
/// # Returns
///
/// 可复用的客户端。
///
/// # Errors
///
/// TLS 后端初始化失败时返回 [`AiError::Network`]。
pub fn build_client(user_agent: &str) -> Result<Client> {
    // reqwest 用 `rustls-no-provider`：进程里还没有默认加密后端时装上 ring（与自动更新插件的做法一致）
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    Client::builder()
        .user_agent(user_agent)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(AiError::from)
}

/// 检查目标地址是否在接口地址之下。
///
/// # Arguments
///
/// * `base` - 配置的接口地址（已规整）。
/// * `target` - 请求的完整地址。
///
/// # Returns
///
/// 解析后的目标地址。
///
/// # Errors
///
/// 协议不安全时返回 [`AiError::InsecureUrl`]；协议 / 主机 / 端口不同、带用户信息或路径越界时返回
/// [`AiError::UrlNotAllowed`]。
pub fn check_target(base: &str, target: &str) -> Result<Url> {
    let base = Url::parse(base).map_err(|_| AiError::UrlNotAllowed)?;
    // `Url::parse` 会消解 `.` / `..` 路径段，越界的写法在这里已经展开
    let url = Url::parse(target).map_err(|_| AiError::UrlNotAllowed)?;
    check_secure(&url)?;
    let same_origin = url.scheme() == base.scheme()
        && url.host_str().map(str::to_ascii_lowercase) == base.host_str().map(str::to_ascii_lowercase)
        && url.port_or_known_default() == base.port_or_known_default();
    if !same_origin || !url.username().is_empty() || url.password().is_some() {
        return Err(AiError::UrlNotAllowed);
    }
    let prefix = base.path().trim_end_matches('/');
    let path = url.path();
    let inside = path == prefix || path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'));
    if !inside {
        return Err(AiError::UrlNotAllowed);
    }
    Ok(url)
}

/// 组装转发的请求头：只保留白名单，再注入 Key。
///
/// # Arguments
///
/// * `profile` - 配置（决定认证头的形式）。
/// * `key` - Key；`None` 或空串时不带认证头。
/// * `from_client` - 前端给出的请求头。
///
/// # Returns
///
/// 实际发送的请求头。
///
/// # Errors
///
/// 头名或值不合法时返回 [`AiError::BadRequest`]。
fn outgoing_headers(profile: &Profile, key: Option<&str>, from_client: &[(String, String)]) -> Result<HeaderMap> {
    let mut map = HeaderMap::new();
    for (name, value) in from_client {
        let lower = name.to_ascii_lowercase();
        if !FORWARDED_HEADERS.contains(&lower.as_str()) {
            continue;
        }
        let name = HeaderName::from_bytes(lower.as_bytes()).map_err(|_| AiError::BadRequest("请求头不合法".into()))?;
        let value = HeaderValue::from_str(value).map_err(|_| AiError::BadRequest("请求头不合法".into()))?;
        map.insert(name, value);
    }
    if let Some(key) = key.filter(|k| !k.is_empty()) {
        let (name, value) = profile.kind.auth_header(key);
        let mut value = HeaderValue::from_str(&value).map_err(|_| AiError::Secret("Key 含非法字符".into()))?;
        value.set_sensitive(true);
        map.insert(HeaderName::from_static(name), value);
    }
    Ok(map)
}

/// 增量 UTF-8 解码：块边界切开的多字节字符留到下一块。
#[derive(Debug, Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    /// 追加一块字节，返回其中已完整的文本（非法字节替换为 U+FFFD）。
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // 前缀已验证合法
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    if let Some(bad) = e.error_len() {
                        out.push('\u{FFFD}');
                        self.pending.drain(..valid + bad);
                    } else {
                        // 末尾是不完整的多字节字符：留到下一块
                        self.pending.drain(..valid);
                        return out;
                    }
                }
            }
        }
    }

    /// 结束时剩下的不完整字节。
    fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        rest
    }
}

/// 转发一次请求，并把响应按事件回传。
///
/// # Arguments
///
/// * `client` - HTTP 客户端（见 [`build_client`]）。
/// * `profile` - 请求所属的配置。
/// * `key` - 配置的 Key；`None` 时不带认证头。
/// * `req` - 前端组装的请求。
/// * `cancel` - 取消令牌。
/// * `emit` - 事件回调，依次收到 `Head`、若干 `Chunk`、`End`。
///
/// # Errors
///
/// - 地址越界 / 不安全：[`AiError::UrlNotAllowed`] / [`AiError::InsecureUrl`]；
/// - 方法不支持、请求体过大、请求头不合法：[`AiError::BadRequest`]；
/// - 连接失败 / 中断 / 超时：[`AiError::Network`] / [`AiError::Timeout`]；
/// - 被取消：[`AiError::Cancelled`]；响应过大：[`AiError::ResponseTooLarge`]。
///
/// 在 `Head` 之后出错时，已回传的部分作废，由前端让响应流报错。
pub async fn forward(
    client: &Client,
    profile: &Profile,
    key: Option<&str>,
    req: ProxyRequest,
    cancel: &CancellationToken,
    mut emit: impl FnMut(ProxyEvent) + Send,
) -> Result<()> {
    let url = check_target(&profile.base_url, &req.url)?;
    let method = match req.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return Err(AiError::BadRequest("只支持 GET / POST".into())),
    };
    if req.body.as_ref().is_some_and(|b| b.len() > MAX_REQUEST_BYTES) {
        return Err(AiError::BadRequest("请求体过大".into()));
    }
    let headers = outgoing_headers(profile, key, &req.headers)?;
    let mut builder = client.request(method, url).headers(headers);
    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let response = tokio::select! {
        () = cancel.cancelled() => return Err(AiError::Cancelled),
        r = builder.send() => r?,
    };
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter(|(name, _)| !HIDDEN_RESPONSE_HEADERS.contains(&name.as_str()))
        .filter_map(|(name, value)| value.to_str().ok().map(|v| (name.as_str().to_owned(), v.to_owned())))
        .collect();
    emit(ProxyEvent::Head { status, headers });

    let mut stream = response.bytes_stream();
    let mut decoder = Utf8Decoder::default();
    let mut total = 0usize;
    loop {
        let next = tokio::select! {
            () = cancel.cancelled() => return Err(AiError::Cancelled),
            n = stream.next() => n,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk?;
        total += chunk.len();
        if total > MAX_RESPONSE_BYTES {
            return Err(AiError::ResponseTooLarge);
        }
        let text = decoder.push(&chunk);
        if !text.is_empty() {
            emit(ProxyEvent::Chunk { text });
        }
    }
    let rest = decoder.finish();
    if !rest.is_empty() {
        emit(ProxyEvent::Chunk { text: rest });
    }
    emit(ProxyEvent::End);
    Ok(())
}

/// 进行中的代理请求登记表：按请求 id 保存取消令牌。
#[derive(Debug, Default)]
pub struct ProxyTable {
    map: Mutex<HashMap<String, CancellationToken>>,
}

/// 登记守卫：持有期间请求可被取消，析构时自动注销。
#[derive(Debug)]
pub struct ProxyGuard {
    table: Arc<ProxyTable>,
    id: String,
    token: CancellationToken,
}

impl ProxyGuard {
    /// 本次请求的取消令牌。
    ///
    /// # Returns
    ///
    /// 取消令牌。
    #[must_use]
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
}

impl Drop for ProxyGuard {
    fn drop(&mut self) {
        self.table.map.lock().remove(&self.id);
    }
}

impl ProxyTable {
    /// 登记一次请求。
    ///
    /// # Arguments
    ///
    /// * `table` - 登记表。
    /// * `id` - 请求 id（前端生成，非空且不与进行中的请求重复）。
    ///
    /// # Returns
    ///
    /// 登记守卫。
    ///
    /// # Errors
    ///
    /// id 为空或已被占用时返回 [`AiError::BadRequest`]。
    pub fn begin(table: &Arc<Self>, id: &str) -> Result<ProxyGuard> {
        if id.is_empty() {
            return Err(AiError::BadRequest("请求 id 不能为空".into()));
        }
        let mut map = table.map.lock();
        if map.contains_key(id) {
            return Err(AiError::BadRequest("请求 id 重复".into()));
        }
        let token = CancellationToken::new();
        map.insert(id.to_owned(), token.clone());
        Ok(ProxyGuard { table: Arc::clone(table), id: id.to_owned(), token })
    }

    /// 取消一次请求。
    ///
    /// # Arguments
    ///
    /// * `id` - 请求 id。
    ///
    /// # Returns
    ///
    /// 找到并已取消时为 `true`；请求已结束或不存在时为 `false`。
    pub fn cancel(&self, id: &str) -> bool {
        self.map.lock().get(id).map(CancellationToken::cancel).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::ProviderKind;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn profile(base_url: &str, kind: ProviderKind) -> Profile {
        Profile {
            id: "p1".into(),
            name: "test".into(),
            kind,
            base_url: base_url.trim_end_matches('/').into(),
            model: "m".into(),
            supports_structured_outputs: false,
            input_modalities: Vec::new(),
            temperature: 0.0,
            seed: None,
        }
    }

    fn request(url: String) -> ProxyRequest {
        ProxyRequest {
            request_id: "r1".into(),
            profile_id: "p1".into(),
            url,
            method: "POST".into(),
            headers: vec![
                ("Authorization".into(), "Bearer placeholder".into()),
                ("Content-Type".into(), "application/json".into()),
                ("X-Evil".into(), "1".into()),
            ],
            body: Some("{\"model\":\"m\"}".into()),
        }
    }

    async fn run(p: &Profile, key: Option<&str>, req: ProxyRequest) -> (Result<()>, Vec<ProxyEvent>) {
        let client = build_client("test").unwrap();
        let mut events = Vec::new();
        let r = forward(&client, p, key, req, &CancellationToken::new(), |e| events.push(e)).await;
        (r, events)
    }

    fn body_of(events: &[ProxyEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                ProxyEvent::Chunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn 替换认证头_只转发白名单_流式回传() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer sk-real"))
            .respond_with(ResponseTemplate::new(200).set_body_string("data: {\"t\":\"你好\"}\n\ndata: [DONE]\n\n"))
            .expect(1)
            .mount(&server)
            .await;
        let p = profile(&format!("{}/v1", server.uri()), ProviderKind::OpenaiCompatible);
        let (r, events) = run(&p, Some("sk-real"), request(format!("{}/v1/chat/completions", server.uri()))).await;
        r.unwrap();
        assert!(matches!(events.first(), Some(ProxyEvent::Head { status: 200, .. })));
        assert_eq!(events.last(), Some(&ProxyEvent::End));
        assert_eq!(body_of(&events), "data: {\"t\":\"你好\"}\n\ndata: [DONE]\n\n");
        let received = server.received_requests().await.unwrap();
        let headers = &received[0].headers;
        assert!(headers.get("x-evil").is_none(), "白名单外的头不转发");
        assert_eq!(headers.get_all("authorization").iter().count(), 1, "占位 Key 被丢弃");
        assert_eq!(headers.get("content-type").unwrap(), "application/json");
    }

    #[tokio::test]
    async fn anthropic_与_gemini_的认证头() {
        let server = MockServer::start().await;
        Mock::given(header("x-api-key", "ak"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;
        Mock::given(header("x-goog-api-key", "gk"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;
        let a = profile(&server.uri(), ProviderKind::Anthropic);
        let (r, e) = run(&a, Some("ak"), request(format!("{}/v1/messages", server.uri()))).await;
        r.unwrap();
        assert_eq!(body_of(&e), "ok");
        let g = profile(&format!("{}/v1beta", server.uri()), ProviderKind::Google);
        let (r, e) = run(&g, Some("gk"), request(format!("{}/v1beta/models/x:streamGenerateContent?alt=sse", server.uri()))).await;
        r.unwrap();
        assert_eq!(body_of(&e), "ok");
    }

    #[tokio::test]
    async fn 没有_key_时不带认证头_错误状态也回传响应体() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_string("{\"error\":\"no key\"}"))
            .mount(&server)
            .await;
        let p = profile(&server.uri(), ProviderKind::OpenaiCompatible);
        let (r, events) = run(&p, None, request(format!("{}/chat/completions", server.uri()))).await;
        r.unwrap();
        assert!(matches!(events.first(), Some(ProxyEvent::Head { status: 401, .. })));
        assert_eq!(body_of(&events), "{\"error\":\"no key\"}");
        let received = server.received_requests().await.unwrap();
        assert!(received[0].headers.get("authorization").is_none());
    }

    #[tokio::test]
    async fn 取消进行中的请求() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
            .mount(&server)
            .await;
        let p = profile(&server.uri(), ProviderKind::OpenaiCompatible);
        let client = build_client("test").unwrap();
        let table = Arc::new(ProxyTable::default());
        let guard = ProxyTable::begin(&table, "r1").unwrap();
        let t = Arc::clone(&table);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(t.cancel("r1"));
        });
        let r = forward(&client, &p, None, request(format!("{}/x", server.uri())), guard.token(), |_| {}).await;
        assert!(matches!(r, Err(AiError::Cancelled)));
        drop(guard);
        assert!(!table.cancel("r1"));
    }

    #[tokio::test]
    async fn 方法与请求体检查() {
        let p = profile("http://127.0.0.1:9/v1", ProviderKind::OpenaiCompatible);
        let mut req = request("http://127.0.0.1:9/v1/x".into());
        req.method = "DELETE".into();
        assert!(matches!(run(&p, None, req).await.0, Err(AiError::BadRequest(_))));
        let mut req = request("http://127.0.0.1:9/v1/x".into());
        req.body = Some("x".repeat(MAX_REQUEST_BYTES + 1));
        assert!(matches!(run(&p, None, req).await.0, Err(AiError::BadRequest(_))));
    }

    #[test]
    fn 目标地址必须在接口地址之下() {
        let base = "https://api.deepseek.com/v1";
        assert!(check_target(base, "https://api.deepseek.com/v1/chat/completions").is_ok());
        assert!(check_target(base, "https://API.deepseek.com:443/v1/models").is_ok());
        assert!(check_target(base, "https://api.deepseek.com/v1").is_ok());
        for bad in [
            "https://api.deepseek.com/v2/chat",
            "https://api.deepseek.com/v1x/chat",
            "https://api.deepseek.com/v1/../admin",
            "https://evil.com/v1/chat",
            "https://api.deepseek.com:8443/v1/chat",
            "https://u:p@api.deepseek.com/v1/chat",
            "not a url",
        ] {
            assert!(matches!(check_target(base, bad), Err(AiError::UrlNotAllowed)), "{bad}");
        }
        assert!(matches!(check_target(base, "http://api.deepseek.com/v1/chat"), Err(AiError::InsecureUrl)));
        // 接口地址没有路径时，同源的任何路径都可以
        assert!(check_target("https://api.anthropic.com", "https://api.anthropic.com/v1/messages").is_ok());
    }

    #[test]
    fn 跨块的多字节字符被拼完整() {
        let bytes = "灯光ok".as_bytes();
        let mut d = Utf8Decoder::default();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&d.push(std::slice::from_ref(b)));
        }
        out.push_str(&d.finish());
        assert_eq!(out, "灯光ok");
        let mut d = Utf8Decoder::default();
        assert_eq!(d.push(&[b'a', 0xff, b'b']), "a\u{FFFD}b");
        assert_eq!(d.push(&[0xe7]), "");
        assert_eq!(d.finish(), "\u{FFFD}");
    }

    #[test]
    fn 登记表拒绝空_id_与重复_id() {
        let table = Arc::new(ProxyTable::default());
        assert!(ProxyTable::begin(&table, "").is_err());
        let g = ProxyTable::begin(&table, "a").unwrap();
        assert!(ProxyTable::begin(&table, "a").is_err());
        drop(g);
        assert!(ProxyTable::begin(&table, "a").is_ok());
    }
}
