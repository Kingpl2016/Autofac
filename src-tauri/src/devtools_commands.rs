//! Tauri 命令：开发者工具（WebView 检查器）的开关。
//!
//! 只在开发构建（`debug_assertions`）里可用：发布构建不启用 tauri 的 `devtools` 特性，
//! 命令返回 `available: false` / 错误码 `unsupported`，界面据此隐藏开关。

use serde::Serialize;
use tauri::AppHandle;

/// 错误码：当前构建不支持开发者工具。
#[cfg_attr(debug_assertions, allow(dead_code))]
pub const ERR_UNSUPPORTED: &str = "unsupported";
/// 错误码：主窗口不存在。
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub const ERR_NO_WINDOW: &str = "no_window";

/// 开发者工具的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevtoolsState {
    /// 当前构建是否支持开发者工具。
    pub available: bool,
    /// 主窗口的开发者工具是否已打开。
    pub open: bool,
}

/// 读取主窗口开发者工具的状态。
///
/// # Arguments
///
/// * `app` - 应用句柄。
///
/// # Returns
///
/// 开发构建里为实际状态；发布构建里恒为 `available: false, open: false`。
#[tauri::command]
pub fn devtools_state(app: AppHandle) -> DevtoolsState {
    #[cfg(debug_assertions)]
    {
        use tauri::Manager;
        let open = app.get_webview_window("main").is_some_and(|w| w.is_devtools_open());
        DevtoolsState { available: true, open }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        DevtoolsState { available: false, open: false }
    }
}

/// 打开或关闭主窗口的开发者工具。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `open` - `true` 打开，`false` 关闭。
///
/// # Returns
///
/// 操作后的状态。
///
/// # Errors
///
/// 发布构建返回 [`ERR_UNSUPPORTED`]；找不到主窗口时返回 [`ERR_NO_WINDOW`]。
#[tauri::command]
pub fn devtools_set(app: AppHandle, open: bool) -> Result<DevtoolsState, String> {
    #[cfg(debug_assertions)]
    {
        use tauri::Manager;
        let window = app.get_webview_window("main").ok_or_else(|| ERR_NO_WINDOW.to_owned())?;
        if open {
            window.open_devtools();
        } else {
            window.close_devtools();
        }
        Ok(DevtoolsState { available: true, open })
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, open);
        Err(ERR_UNSUPPORTED.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 状态按驼峰序列化() {
        let json = serde_json::to_value(DevtoolsState { available: true, open: false }).unwrap();
        assert_eq!(json, serde_json::json!({ "available": true, "open": false }));
        assert_ne!(ERR_UNSUPPORTED, ERR_NO_WINDOW);
    }
}
