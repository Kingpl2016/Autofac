//! 配置的加载、保存与导入导出。

use std::path::Path;

use crate::error::Result;
use crate::model::AppSettings;

/// 从指定路径加载配置；文件不存在时返回默认配置。
///
/// # Arguments
///
/// * `path` - 配置文件路径。
///
/// # Returns
///
/// 解析（并规范化）后的配置；文件缺失返回 [`AppSettings::default`]。
///
/// # Errors
///
/// 文件存在但读取或 JSON 解析失败时返回对应 [`crate::SettingsError`]。
pub fn load(path: &Path) -> Result<AppSettings> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let text = std::fs::read_to_string(path)?;
    let mut settings: AppSettings = serde_json::from_str(&text)?;
    settings.migrate();
    settings.normalize();
    Ok(settings)
}

/// 将配置原子化保存到指定路径（先写临时文件再重命名）。
///
/// # Arguments
///
/// * `path` - 目标配置文件路径。
/// * `settings` - 待保存配置。
///
/// # Errors
///
/// 创建目录、序列化或写入失败时返回对应 [`crate::SettingsError`]。
pub fn save(path: &Path, settings: &AppSettings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(settings)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// 从 JSON 文本解析配置（供导入功能使用）。
///
/// # Arguments
///
/// * `json` - 配置 JSON 文本。
///
/// # Returns
///
/// 解析并规范化后的配置。
///
/// # Errors
///
/// JSON 解析失败返回 [`crate::SettingsError::Json`]。
pub fn from_json(json: &str) -> Result<AppSettings> {
    let mut settings: AppSettings = serde_json::from_str(json)?;
    settings.migrate();
    settings.normalize();
    Ok(settings)
}

/// 将配置序列化为美化 JSON 文本（供导出功能使用）。
///
/// # Arguments
///
/// * `settings` - 待导出配置。
///
/// # Returns
///
/// 美化后的 JSON 文本。
///
/// # Errors
///
/// 序列化失败返回 [`crate::SettingsError::Json`]。
pub fn to_json(settings: &AppSettings) -> Result<String> {
    Ok(serde_json::to_string_pretty(settings)?)
}
