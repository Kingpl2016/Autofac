//! 「关于」页所需的应用元信息命令。
//!
//! 前端关于页展示版本、构建配置与运行环境，并可一键复制为诊断信息。
//! 这些信息全部在编译期或运行时即可确定，因此命令本身不做 I/O，也不会失败。

use serde::Serialize;
use tauri::AppHandle;

/// 构建配置：区分带调试断言的开发构建与发布构建。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildProfile {
    /// 开启了 `debug_assertions` 的开发构建（`tauri dev`）。
    Debug,
    /// 发布构建（`tauri build`）。
    Release,
}

impl BuildProfile {
    /// 返回当前二进制的构建配置。
    ///
    /// # Returns
    ///
    /// 开启 `debug_assertions` 时为 [`BuildProfile::Debug`]，否则为 [`BuildProfile::Release`]。
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(debug_assertions) {
            Self::Debug
        } else {
            Self::Release
        }
    }
}

/// 关于页展示的应用元信息，序列化为 camelCase 以对齐前端类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// 应用名称（`tauri.conf.json` 的 `productName`）。
    pub name: String,
    /// 应用版本号，形如 `"0.1.0"`。
    pub version: String,
    /// 应用标识符（`tauri.conf.json` 的 `identifier`），如 `com.artnetstudio.app`。
    pub identifier: String,
    /// 编译时链接的 Tauri 框架版本。
    pub tauri_version: String,
    /// 操作系统，取自 [`std::env::consts::OS`]，如 `"windows"`。
    pub os: String,
    /// CPU 架构，取自 [`std::env::consts::ARCH`]，如 `"x86_64"`。
    pub arch: String,
    /// 当前二进制的构建配置。
    pub profile: BuildProfile,
}

impl AppInfo {
    /// 由应用自身的名称、版本与标识符，补齐框架版本、系统与构建信息。
    ///
    /// # Arguments
    ///
    /// * `name` - 应用名称。
    /// * `version` - 应用版本号。
    /// * `identifier` - 应用标识符。
    ///
    /// # Returns
    ///
    /// 填好全部字段的 [`AppInfo`]；`tauri_version`、`os`、`arch`、`profile` 取自编译期常量。
    #[must_use]
    pub fn new(name: &str, version: &str, identifier: &str) -> Self {
        Self {
            name: name.to_owned(),
            version: version.to_owned(),
            identifier: identifier.to_owned(),
            tauri_version: tauri::VERSION.to_owned(),
            os: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            profile: BuildProfile::current(),
        }
    }
}

/// 返回关于页所需的应用元信息。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于读取包信息与应用配置。
///
/// # Returns
///
/// 当前应用的 [`AppInfo`]。
#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let package = app.package_info();
    AppInfo::new(
        &package.name,
        &package.version.to_string(),
        &app.config().identifier,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_keeps_app_fields_and_fills_environment() {
        let info = AppInfo::new("Art-Net Studio", "1.2.3", "com.example.app");

        assert_eq!(info.name, "Art-Net Studio");
        assert_eq!(info.version, "1.2.3");
        assert_eq!(info.identifier, "com.example.app");
        assert_eq!(info.tauri_version, tauri::VERSION);
        assert_eq!(info.os, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
        assert!(!info.os.is_empty() && !info.arch.is_empty());
    }

    #[test]
    fn profile_matches_debug_assertions() {
        let expected = if cfg!(debug_assertions) {
            BuildProfile::Debug
        } else {
            BuildProfile::Release
        };
        assert_eq!(BuildProfile::current(), expected);
    }

    #[test]
    fn serializes_with_camel_case_keys_and_lowercase_profile() {
        let value = serde_json::to_value(AppInfo::new("a", "1", "id")).expect("AppInfo 可序列化");

        assert!(
            value.get("tauriVersion").is_some(),
            "缺少 tauriVersion: {value}"
        );
        assert!(
            value.get("tauri_version").is_none(),
            "不应出现 snake_case 键: {value}"
        );
        let profile = value["profile"].as_str().expect("profile 应为字符串");
        assert!(
            matches!(profile, "debug" | "release"),
            "profile = {profile}"
        );
    }
}
