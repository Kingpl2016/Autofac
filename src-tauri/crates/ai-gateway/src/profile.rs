//! AI 厂商配置：接口地址、模型与生成参数持久化为 JSON，API Key 交给 [`SecretStore`]。

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{AiError, Result};
use crate::secret::SecretStore;

/// 配置名称最大字符数。
const MAX_NAME_CHARS: usize = 40;
/// 模型 id 最大字符数。
const MAX_MODEL_CHARS: usize = 128;
/// 接口地址最大字符数。
const MAX_URL_CHARS: usize = 512;
/// API Key 最大字符数。
const MAX_KEY_CHARS: usize = 512;
/// 温度上限（各家接口的公共范围）。
const MAX_TEMPERATURE: f64 = 2.0;

/// 接口协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    /// OpenAI Chat Completions 兼容接口（OpenAI、DeepSeek、通义千问、GLM、Kimi、Ollama…），`Authorization: Bearer`。
    OpenaiCompatible,
    /// Anthropic Messages 接口，`x-api-key`。
    Anthropic,
    /// Google Gemini 接口，`x-goog-api-key`。
    Google,
}

impl ProviderKind {
    /// 这种接口携带 Key 的请求头。
    ///
    /// # Arguments
    ///
    /// * `key` - 明文 Key。
    ///
    /// # Returns
    ///
    /// `(请求头名, 值)`。
    #[must_use]
    pub fn auth_header(self, key: &str) -> (&'static str, String) {
        match self {
            Self::OpenaiCompatible => ("authorization", format!("Bearer {key}")),
            Self::Anthropic => ("x-api-key", key.to_owned()),
            Self::Google => ("x-goog-api-key", key.to_owned()),
        }
    }
}

/// 一个已保存的 AI 配置（不含 Key）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// 稳定 id（UUID）。
    pub id: String,
    /// 显示名称。
    pub name: String,
    /// 接口协议。
    pub kind: ProviderKind,
    /// 接口地址（不带末尾 `/`），例如 `https://api.deepseek.com/v1`。
    pub base_url: String,
    /// 模型 id，例如 `deepseek-chat`。
    pub model: String,
    /// OpenAI 兼容接口是否支持 `response_format: json_schema`（结构化输出）；其它协议忽略。
    #[serde(default)]
    pub supports_structured_outputs: bool,
    /// 采样温度 0~2；为保证不同模型结果接近，默认 0。
    #[serde(default)]
    pub temperature: f64,
    /// 随机种子（接口支持时传给模型，减少同一模型多次调用的差异）。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub seed: Option<u32>,
}

/// 返回给前端的配置视图：配置加“是否已保存 Key”。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    /// 配置。
    #[serde(flatten)]
    pub profile: Profile,
    /// 凭据库中是否有该配置的 Key。
    pub has_key: bool,
}

/// 新增 / 更新配置的输入。
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    /// 已有配置 id；新增时省略。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub id: Option<String>,
    /// 显示名称；为空时用模型 id。
    #[serde(default)]
    pub name: String,
    /// 接口协议。
    pub kind: ProviderKind,
    /// 接口地址。
    pub base_url: String,
    /// 模型 id。
    pub model: String,
    /// 是否支持结构化输出（仅 OpenAI 兼容接口）。
    #[serde(default)]
    pub supports_structured_outputs: bool,
    /// 采样温度 0~2。
    #[serde(default)]
    pub temperature: f64,
    /// 随机种子。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub seed: Option<u32>,
}

/// 磁盘文件结构。
#[derive(Debug, Default, Serialize, Deserialize)]
struct FileData {
    #[serde(default)]
    profiles: Vec<Profile>,
}

/// 主机是否为本机或局域网地址（允许走 HTTP：本地 Ollama / LM Studio、局域网里的推理服务器）。
///
/// # Arguments
///
/// * `url` - 已解析的地址。
///
/// # Returns
///
/// `localhost`、回环、IPv4 私有网段、链路本地与 IPv6 唯一本地地址为 `true`。
fn is_local(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        // fc00::/7：唯一本地地址
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        None => false,
    }
}

/// 检查地址的协议：HTTPS 一律允许；HTTP 只允许本机 / 局域网地址。
///
/// # Arguments
///
/// * `url` - 已解析的地址。
///
/// # Errors
///
/// 其它协议，或公网地址用 HTTP 时返回 [`AiError::InsecureUrl`]。
pub(crate) fn check_secure(url: &Url) -> Result<()> {
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_local(url) => Ok(()),
        _ => Err(AiError::InsecureUrl),
    }
}

/// 规整并校验接口地址：去掉首尾空白与末尾的 `/`，不允许带查询串、片段与用户信息。
///
/// # Arguments
///
/// * `raw` - 用户输入的地址。
///
/// # Returns
///
/// 规整后的地址。
///
/// # Errors
///
/// 地址为空、过长、无法解析、带查询串 / 片段 / 用户信息时返回 [`AiError::InvalidProfile`]；
/// 协议不安全时返回 [`AiError::InsecureUrl`]。
pub fn normalize_base_url(raw: &str) -> Result<String> {
    let s = raw.trim().trim_end_matches('/');
    if s.is_empty() || s.chars().count() > MAX_URL_CHARS {
        return Err(AiError::InvalidProfile("接口地址为空或过长".into()));
    }
    let url = Url::parse(s).map_err(|_| AiError::InvalidProfile("接口地址无法解析".into()))?;
    if url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err(AiError::InvalidProfile("接口地址不能带查询串、片段或用户信息".into()));
    }
    if url.host().is_none() {
        return Err(AiError::InvalidProfile("接口地址缺少主机".into()));
    }
    check_secure(&url)?;
    Ok(s.to_owned())
}

/// 校验 Key 的格式（不校验是否有效）。
///
/// # Arguments
///
/// * `key` - 明文 Key；空串表示清除。
///
/// # Errors
///
/// 过长或含控制字符 / 空白时返回 [`AiError::InvalidProfile`]。
fn check_key(key: &str) -> Result<()> {
    if key.chars().count() > MAX_KEY_CHARS || key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(AiError::InvalidProfile("Key 过长或含空白 / 控制字符".into()));
    }
    Ok(())
}

/// AI 配置表。
pub struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<Profile>>,
    secrets: Arc<dyn SecretStore>,
}

impl ProfileStore {
    /// 从磁盘加载；文件缺失得到空表，损坏时备份为 `.bad` 后得到空表。
    ///
    /// # Arguments
    ///
    /// * `path` - 配置 JSON 路径。
    /// * `secrets` - Key 存储。
    ///
    /// # Returns
    ///
    /// 已加载的配置表。
    #[must_use]
    pub fn load(path: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        let profiles = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<FileData>(&text) {
                Ok(d) => d.profiles,
                Err(e) => {
                    tracing::warn!(error = %e, "AI 配置文件损坏，已备份并重置");
                    let _ = std::fs::rename(&path, path.with_extension("json.bad"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Self { path, profiles: Mutex::new(profiles), secrets }
    }

    fn persist(&self, profiles: &[Profile]) -> Result<()> {
        let text = serde_json::to_string_pretty(&FileData { profiles: profiles.to_vec() })
            .map_err(|e| AiError::Io(e.to_string()))?;
        fsutil::write_atomic(&self.path, text.as_bytes())?;
        Ok(())
    }

    /// 列出全部配置及其 Key 状态。
    ///
    /// # Returns
    ///
    /// 配置视图；凭据库读取失败的按“无 Key”处理。
    #[must_use]
    pub fn list(&self) -> Vec<ProfileView> {
        let profiles = self.profiles.lock().clone();
        profiles
            .into_iter()
            .map(|profile| {
                let has_key = matches!(self.secrets.get(&profile.id), Ok(Some(_)));
                ProfileView { profile, has_key }
            })
            .collect()
    }

    /// 按 id 取配置。
    ///
    /// # Arguments
    ///
    /// * `id` - 配置 id。
    ///
    /// # Returns
    ///
    /// 配置副本。
    ///
    /// # Errors
    ///
    /// 不存在时返回 [`AiError::UnknownProfile`]。
    pub fn get(&self, id: &str) -> Result<Profile> {
        self.profiles.lock().iter().find(|p| p.id == id).cloned().ok_or(AiError::UnknownProfile)
    }

    /// 读取配置的 Key（只给代理用，不返回给前端）。
    ///
    /// # Arguments
    ///
    /// * `id` - 配置 id。
    ///
    /// # Returns
    ///
    /// Key；没有保存时为 `None`（例如本地 Ollama）。
    ///
    /// # Errors
    ///
    /// 凭据存储不可用时返回 [`AiError::Secret`]。
    pub fn key(&self, id: &str) -> Result<Option<String>> {
        self.secrets.get(id)
    }

    /// 新增或更新配置。
    ///
    /// # Arguments
    ///
    /// * `input` - 配置；带 `id` 表示更新。
    ///
    /// # Returns
    ///
    /// 保存后的配置视图。
    ///
    /// # Errors
    ///
    /// 字段非法时返回 [`AiError::InvalidProfile`] / [`AiError::InsecureUrl`]；
    /// 更新的 id 不存在时返回 [`AiError::UnknownProfile`]；写盘失败时返回 [`AiError::Io`]。
    pub fn save(&self, input: &ProfileInput) -> Result<ProfileView> {
        let base_url = normalize_base_url(&input.base_url)?;
        let model = input.model.trim();
        if model.is_empty() || model.chars().count() > MAX_MODEL_CHARS {
            return Err(AiError::InvalidProfile("模型 id 为空或过长".into()));
        }
        let name = input.name.trim();
        if name.chars().count() > MAX_NAME_CHARS {
            return Err(AiError::InvalidProfile(format!("名称最多 {MAX_NAME_CHARS} 个字符")));
        }
        if !(0.0..=MAX_TEMPERATURE).contains(&input.temperature) {
            return Err(AiError::InvalidProfile("温度应在 0~2 之间".into()));
        }
        let name = if name.is_empty() { model.to_owned() } else { name.to_owned() };
        let mut profiles = self.profiles.lock();
        let saved = Profile {
            id: input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name,
            kind: input.kind,
            base_url,
            model: model.to_owned(),
            supports_structured_outputs: input.supports_structured_outputs,
            temperature: input.temperature,
            seed: input.seed,
        };
        if let Some(id) = &input.id {
            let slot = profiles.iter_mut().find(|p| &p.id == id).ok_or(AiError::UnknownProfile)?;
            *slot = saved.clone();
        } else {
            profiles.push(saved.clone());
        }
        self.persist(&profiles)?;
        drop(profiles);
        let has_key = matches!(self.secrets.get(&saved.id), Ok(Some(_)));
        Ok(ProfileView { profile: saved, has_key })
    }

    /// 删除配置并清除其 Key。
    ///
    /// # Arguments
    ///
    /// * `id` - 配置 id。
    ///
    /// # Errors
    ///
    /// 不存在时返回 [`AiError::UnknownProfile`]；写盘或凭据删除失败时返回对应错误。
    pub fn delete(&self, id: &str) -> Result<()> {
        let mut profiles = self.profiles.lock();
        let before = profiles.len();
        profiles.retain(|p| p.id != id);
        if profiles.len() == before {
            return Err(AiError::UnknownProfile);
        }
        self.persist(&profiles)?;
        drop(profiles);
        self.secrets.delete(id)
    }

    /// 设置或清除配置的 Key。
    ///
    /// # Arguments
    ///
    /// * `id` - 配置 id。
    /// * `key` - 新 Key（首尾空白会去掉）；空串表示清除。
    ///
    /// # Errors
    ///
    /// 配置不存在、Key 格式非法或凭据存储失败时返回对应错误。
    pub fn set_key(&self, id: &str, key: &str) -> Result<()> {
        self.get(id)?;
        let key = key.trim();
        check_key(key)?;
        if key.is_empty() { self.secrets.delete(id) } else { self.secrets.set(id, key) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::MemoryStore;

    fn input(base_url: &str) -> ProfileInput {
        ProfileInput {
            id: None,
            name: String::new(),
            kind: ProviderKind::OpenaiCompatible,
            base_url: base_url.into(),
            model: "deepseek-chat".into(),
            supports_structured_outputs: false,
            temperature: 0.0,
            seed: Some(7),
        }
    }

    fn store() -> (tempfile::TempDir, ProfileStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = ProfileStore::load(dir.path().join("ai-profiles.json"), Arc::new(MemoryStore::default()));
        (dir, s)
    }

    #[test]
    fn 地址规整与协议检查() {
        assert_eq!(normalize_base_url(" https://api.deepseek.com/v1/ ").unwrap(), "https://api.deepseek.com/v1");
        assert!(normalize_base_url("http://localhost:11434/v1").is_ok());
        assert!(normalize_base_url("http://127.0.0.1:1234/v1").is_ok());
        assert!(normalize_base_url("http://192.168.1.20:11434/v1").is_ok());
        assert!(normalize_base_url("http://[::1]:11434/v1").is_ok());
        assert!(matches!(normalize_base_url("http://api.openai.com/v1"), Err(AiError::InsecureUrl)));
        assert!(matches!(normalize_base_url("ftp://x.com"), Err(AiError::InsecureUrl)));
        assert!(normalize_base_url("https://x.com/v1?key=1").is_err());
        assert!(normalize_base_url("https://u:p@x.com/v1").is_err());
        assert!(normalize_base_url("").is_err());
    }

    #[test]
    fn 保存_更新_删除并持久化_key_不落盘() {
        let (dir, s) = store();
        let saved = s.save(&input("https://api.deepseek.com/v1/")).unwrap();
        assert_eq!(saved.profile.name, "deepseek-chat");
        assert_eq!(saved.profile.base_url, "https://api.deepseek.com/v1");
        assert!(!saved.has_key);

        s.set_key(&saved.profile.id, " sk-secret-123 ").unwrap();
        assert_eq!(s.key(&saved.profile.id).unwrap().as_deref(), Some("sk-secret-123"));
        assert!(s.list()[0].has_key);
        let text = std::fs::read_to_string(dir.path().join("ai-profiles.json")).unwrap();
        assert!(!text.contains("sk-secret"), "Key 不能写进配置文件");

        let mut upd = input("https://api.deepseek.com/v1");
        upd.id = Some(saved.profile.id.clone());
        upd.name = "DeepSeek".into();
        upd.temperature = 0.3;
        let updated = s.save(&upd).unwrap();
        assert_eq!(updated.profile.name, "DeepSeek");
        assert!(updated.has_key);
        assert_eq!(s.list().len(), 1);

        // 重新加载得到同样的内容
        let again = ProfileStore::load(dir.path().join("ai-profiles.json"), Arc::new(MemoryStore::default()));
        assert_eq!(again.get(&saved.profile.id).unwrap().name, "DeepSeek");

        s.delete(&saved.profile.id).unwrap();
        assert!(s.list().is_empty());
        assert_eq!(s.key(&saved.profile.id).unwrap(), None);
        assert!(matches!(s.delete(&saved.profile.id), Err(AiError::UnknownProfile)));
    }

    #[test]
    fn 非法字段被拒绝() {
        let (_dir, s) = store();
        let mut bad = input("https://x.com/v1");
        bad.model = "  ".into();
        assert!(s.save(&bad).is_err());
        let mut bad = input("https://x.com/v1");
        bad.temperature = 3.0;
        assert!(s.save(&bad).is_err());
        let mut bad = input("https://x.com/v1");
        bad.id = Some("nope".into());
        assert!(matches!(s.save(&bad), Err(AiError::UnknownProfile)));
        let ok = s.save(&input("https://x.com/v1")).unwrap();
        assert!(s.set_key(&ok.profile.id, "sk with space").is_err());
        assert!(matches!(s.set_key("nope", "sk"), Err(AiError::UnknownProfile)));
    }

    #[test]
    fn 损坏的文件被备份() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai-profiles.json");
        std::fs::write(&path, "{not json").unwrap();
        let s = ProfileStore::load(path.clone(), Arc::new(MemoryStore::default()));
        assert!(s.list().is_empty());
        assert!(path.with_extension("json.bad").exists());
    }

    #[test]
    fn 各协议的认证头() {
        assert_eq!(ProviderKind::OpenaiCompatible.auth_header("k"), ("authorization", "Bearer k".into()));
        assert_eq!(ProviderKind::Anthropic.auth_header("k"), ("x-api-key", "k".into()));
        assert_eq!(ProviderKind::Google.auth_header("k"), ("x-goog-api-key", "k".into()));
    }
}
