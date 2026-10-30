//! 查询模型服务提供的模型列表（设置页的模型下拉框用）。
//!
//! 三种接口的格式各不相同，这里统一成 [`ModelInfo`] 列表：
//!
//! - OpenAI 兼容：`GET {base}/models` → `{ "data": [{ "id": … }] }`；
//! - Anthropic：`GET {base}/models?limit=1000`（带 `anthropic-version`）→ `{ "data": [{ "id", "display_name" }], "has_more", "last_id" }`；
//! - Gemini：`GET {base}/models?pageSize=1000` → `{ "models": [{ "name": "models/…", "displayName", "supportedGenerationMethods" }], "nextPageToken" }`，
//!   只保留支持 `generateContent` 的模型。
//!
//! 只读、带超时与响应大小上限；地址经过与代理相同的安全检查。Key 只放在请求头里，不回传。

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{AiError, Result};
use crate::profile::{ProviderKind, check_secure};

/// 单次查询的超时。
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// 单页响应上限。
const MAX_LIST_BYTES: usize = 1024 * 1024;
/// 最多翻几页（防止接口一直返回下一页）。
const MAX_PAGES: usize = 5;
/// Anthropic 接口版本。
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 一个模型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// 调用时用的模型 id。
    pub id: String,
    /// 显示名（接口没给时与 `id` 相同）。
    pub name: String,
}

/// 前端的查询参数。
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ModelListInput {
    /// 已保存的配置（用它在凭据库里的 Key）；新建配置时省略。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub profile_id: Option<String>,
    /// 接口协议。
    pub kind: ProviderKind,
    /// 接口地址（表单里当前填的）。
    pub base_url: String,
    /// 表单里刚填、还没保存的 Key；省略时用已保存配置的 Key。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub key: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiList {
    #[serde(default)]
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Deserialize)]
struct AnthropicList {
    #[serde(default)]
    data: Vec<AnthropicModel>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    last_id: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicModel {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiList {
    #[serde(default)]
    models: Vec<GeminiModel>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModel {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    supported_generation_methods: Vec<String>,
}

/// `Url` 的主机、端口与协议是否相同。
///
/// # Arguments
///
/// * `a` - 一个地址。
/// * `b` - 另一个地址。
///
/// # Returns
///
/// 两者都能解析且协议、主机（不区分大小写）、端口相同时为 `true`。
#[must_use]
pub fn same_origin(a: &str, b: &str) -> bool {
    match (Url::parse(a), Url::parse(b)) {
        (Ok(a), Ok(b)) => {
            a.scheme() == b.scheme()
                && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
                && a.port_or_known_default() == b.port_or_known_default()
        }
        _ => false,
    }
}

/// 组装请求头：认证头与接口需要的固定头。
fn headers(kind: ProviderKind, key: Option<&str>) -> Result<HeaderMap> {
    let mut map = HeaderMap::new();
    map.insert(HeaderName::from_static("accept"), HeaderValue::from_static("application/json"));
    if kind == ProviderKind::Anthropic {
        map.insert(HeaderName::from_static("anthropic-version"), HeaderValue::from_static(ANTHROPIC_VERSION));
    }
    if let Some(key) = key.map(str::trim).filter(|k| !k.is_empty()) {
        let (name, value) = kind.auth_header(key);
        let mut value = HeaderValue::from_str(&value).map_err(|_| AiError::InvalidProfile("Key 含非法字符".into()))?;
        value.set_sensitive(true);
        map.insert(HeaderName::from_static(name), value);
    }
    Ok(map)
}

/// 发一次 GET，读回有大小上限的 JSON。
async fn get_json<T: for<'de> Deserialize<'de>>(client: &Client, url: Url, headers: HeaderMap) -> Result<T> {
    let response = client.get(url).headers(headers).timeout(LIST_TIMEOUT).send().await?;
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err(AiError::Unauthorized);
    }
    if !(200..300).contains(&status) {
        return Err(AiError::Http { status });
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len() + chunk.len() > MAX_LIST_BYTES {
            return Err(AiError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|e| AiError::BadResponse(e.to_string()))
}

/// `{base}/models`，带查询参数。
fn models_url(base: &str, query: &[(&str, &str)]) -> Result<Url> {
    let mut url = Url::parse(&format!("{}/models", base.trim_end_matches('/'))).map_err(|_| AiError::UrlNotAllowed)?;
    check_secure(&url)?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Ok(url)
}

/// 查询模型列表。
///
/// # Arguments
///
/// * `client` - HTTP 客户端（见 [`crate::build_client`]）。
/// * `kind` - 接口协议。
/// * `base_url` - 接口地址（已规整，见 [`crate::profile::normalize_base_url`]）。
/// * `key` - API Key；`None` 时不带认证头（本机服务）。
///
/// # Returns
///
/// 按 `id` 排序、去重后的模型。
///
/// # Errors
///
/// - 地址不安全：[`AiError::InsecureUrl`]；
/// - Key 被拒绝：[`AiError::Unauthorized`]；其它非 2xx：[`AiError::Http`]；
/// - 网络错误 / 超时：[`AiError::Network`] / [`AiError::Timeout`]；
/// - 响应过大或格式不对：[`AiError::ResponseTooLarge`] / [`AiError::BadResponse`]。
pub async fn list_models(client: &Client, kind: ProviderKind, base_url: &str, key: Option<&str>) -> Result<Vec<ModelInfo>> {
    let mut out: Vec<ModelInfo> = Vec::new();
    match kind {
        ProviderKind::OpenaiCompatible => {
            let list: OpenAiList = get_json(client, models_url(base_url, &[])?, headers(kind, key)?).await?;
            out.extend(list.data.into_iter().map(|m| ModelInfo { name: m.id.clone(), id: m.id }));
        }
        ProviderKind::Anthropic => {
            let mut after: Option<String> = None;
            for _ in 0..MAX_PAGES {
                let mut query = vec![("limit", "1000")];
                if let Some(a) = after.as_deref() {
                    query.push(("after_id", a));
                }
                let page: AnthropicList = get_json(client, models_url(base_url, &query)?, headers(kind, key)?).await?;
                out.extend(page.data.into_iter().map(|m| ModelInfo { name: m.display_name.unwrap_or_else(|| m.id.clone()), id: m.id }));
                match (page.has_more, page.last_id) {
                    (true, Some(last)) => after = Some(last),
                    _ => break,
                }
            }
        }
        ProviderKind::Google => {
            let mut token: Option<String> = None;
            for _ in 0..MAX_PAGES {
                let mut query = vec![("pageSize", "1000")];
                if let Some(t) = token.as_deref() {
                    query.push(("pageToken", t));
                }
                let page: GeminiList = get_json(client, models_url(base_url, &query)?, headers(kind, key)?).await?;
                out.extend(
                    page.models
                        .into_iter()
                        .filter(|m| m.supported_generation_methods.iter().any(|g| g == "generateContent"))
                        .map(|m| {
                            let id = m.name.strip_prefix("models/").unwrap_or(&m.name).to_owned();
                            ModelInfo { name: m.display_name.unwrap_or_else(|| id.clone()), id }
                        }),
                );
                match page.next_page_token.filter(|t| !t.is_empty()) {
                    Some(t) => token = Some(t),
                    None => break,
                }
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::build_client;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn openai_兼容接口_带_bearer_排序去重() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(header("authorization", "Bearer sk-1"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"data":[{"id":"b"},{"id":"a"},{"id":"b"}]}"#))
            .mount(&server)
            .await;
        let client = build_client("t").unwrap();
        let list = list_models(&client, ProviderKind::OpenaiCompatible, &format!("{}/v1", server.uri()), Some("sk-1")).await.unwrap();
        assert_eq!(list.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }

    #[tokio::test]
    async fn anthropic_翻页并带版本头() {
        let server = MockServer::start().await;
        Mock::given(path("/v1/models"))
            .and(header("x-api-key", "ak"))
            .and(header("anthropic-version", ANTHROPIC_VERSION))
            .and(query_param("after_id", "m1"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"data":[{"id":"m2"}],"has_more":false}"#))
            .mount(&server)
            .await;
        Mock::given(path("/v1/models"))
            .and(header("x-api-key", "ak"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"data":[{"id":"m1","display_name":"Model 1"}],"has_more":true,"last_id":"m1"}"#))
            .mount(&server)
            .await;
        let client = build_client("t").unwrap();
        let list = list_models(&client, ProviderKind::Anthropic, &format!("{}/v1", server.uri()), Some("ak")).await.unwrap();
        assert_eq!(list, vec![ModelInfo { id: "m1".into(), name: "Model 1".into() }, ModelInfo { id: "m2".into(), name: "m2".into() }]);
    }

    #[tokio::test]
    async fn gemini_只保留能生成文本的模型() {
        let server = MockServer::start().await;
        Mock::given(path("/v1beta/models"))
            .and(header("x-goog-api-key", "gk"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"models":[{"name":"models/gemini-2.5-flash","displayName":"Gemini 2.5 Flash","supportedGenerationMethods":["generateContent"]},{"name":"models/embedding-001","supportedGenerationMethods":["embedContent"]}]}"#,
            ))
            .mount(&server)
            .await;
        let client = build_client("t").unwrap();
        let list = list_models(&client, ProviderKind::Google, &format!("{}/v1beta", server.uri()), Some("gk")).await.unwrap();
        assert_eq!(list, vec![ModelInfo { id: "gemini-2.5-flash".into(), name: "Gemini 2.5 Flash".into() }]);
    }

    #[tokio::test]
    async fn 错误状态与格式() {
        let server = MockServer::start().await;
        Mock::given(path("/a/models")).respond_with(ResponseTemplate::new(401)).mount(&server).await;
        Mock::given(path("/b/models")).respond_with(ResponseTemplate::new(404)).mount(&server).await;
        Mock::given(path("/c/models")).respond_with(ResponseTemplate::new(200).set_body_string("<html>")).mount(&server).await;
        let client = build_client("t").unwrap();
        let k = ProviderKind::OpenaiCompatible;
        assert!(matches!(list_models(&client, k, &format!("{}/a", server.uri()), None).await, Err(AiError::Unauthorized)));
        assert!(matches!(list_models(&client, k, &format!("{}/b", server.uri()), None).await, Err(AiError::Http { status: 404 })));
        assert!(matches!(list_models(&client, k, &format!("{}/c", server.uri()), None).await, Err(AiError::BadResponse(_))));
        assert!(matches!(list_models(&client, k, "http://api.example.com/v1", None).await, Err(AiError::InsecureUrl)));
    }

    #[test]
    fn 同源判断() {
        assert!(same_origin("https://api.x.com/v1", "https://API.x.com:443/v2"));
        assert!(!same_origin("https://api.x.com/v1", "https://evil.com/v1"));
        assert!(!same_origin("https://api.x.com", "http://api.x.com"));
    }
}
