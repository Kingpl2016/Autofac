//! Tauri 命令：节目编辑器工程的保存、打开与自动存档。
//!
//! 命令只做"提取 → 调用领域 → 返回 DTO"；文件规则（路径校验、原子写入、备份、大小上限）位于
//! `recorder::show_store`。错误以字符串错误码返回：节目库路径相关的沿用
//! [`crate::recording_commands`] 的错误码（`outside_library`、`not_found`…），另有
//! `project_too_large`、`invalid_project`、`bad_path`。

use std::path::{Path, PathBuf};

use recorder::{SaveRequest, ShowError};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::recording_commands::{lib_err, resolved_dir};

/// 错误码：工程内容超过大小上限。
pub const ERR_TOO_LARGE: &str = "project_too_large";

/// 错误码：工程内容不是合法 JSON。
pub const ERR_INVALID_PROJECT: &str = "invalid_project";

/// 错误码：库外工程文件的路径不合法。
pub const ERR_BAD_PATH: &str = "bad_path";

/// 自动存档的文件名（位于应用数据目录）。
const AUTOSAVE_FILE: &str = "show-autosave.artshow";

/// 把工程文件错误转换为前端可翻译的错误码。
///
/// # Arguments
///
/// * `e` - 工程文件错误。
///
/// # Returns
///
/// 错误码字符串。
fn show_err(e: ShowError) -> String {
    match e {
        ShowError::Library(inner) => lib_err(inner),
        ShowError::TooLarge => ERR_TOO_LARGE.to_owned(),
        ShowError::InvalidJson => ERR_INVALID_PROJECT.to_owned(),
        ShowError::BadPath => ERR_BAD_PATH.to_owned(),
    }
}

/// 保存到节目库的参数（前端字段名为 camelCase）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowSaveArgs {
    /// 已有节目的 `.artrec` 路径（覆盖保存）；省略表示新建。
    pub path: Option<String>,
    /// 节目显示名。
    pub name: String,
    /// 备注。
    #[serde(default)]
    pub notes: String,
    /// 新建时的文件名主干。
    #[serde(default)]
    pub file_stem: String,
    /// 工程 JSON 文本。
    pub json: String,
}

/// 把工程保存进节目库（新建或覆盖）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析当前录制目录。
/// * `args` - 保存参数。
///
/// # Returns
///
/// 该节目的 `.artrec` 路径（烘焙完成之前文件可能还不存在，只有工程；烘焙在后台进行）。
///
/// # Errors
///
/// 路径不在节目库内（`outside_library`）、条目不存在（`not_found`）、内容过大
/// （`project_too_large`）或不是 JSON（`invalid_project`），以及文件系统错误描述。
#[tauri::command]
pub async fn show_project_save(app: AppHandle, args: ShowSaveArgs) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = resolved_dir(&app);
        let path = args.path.as_deref().map(Path::new);
        recorder::save_show(
            &dir,
            SaveRequest {
                path,
                name: &args.name,
                notes: &args.notes,
                file_stem: &args.file_stem,
                json: &args.json,
            },
        )
        .map(|p| {
            // 工程已落盘即保存成功；.artrec 在后台烘焙，结果经 `show:bake` 事件通知
            crate::show_bake::schedule(&app, p.clone());
            p.to_string_lossy().into_owned()
        })
        .map_err(show_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取节目库里某个节目的工程。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `path` - 节目的 `.artrec` 路径。
///
/// # Returns
///
/// 工程 JSON 文本。
///
/// # Errors
///
/// 路径不在节目库内（`outside_library`）、该节目没有工程（`not_found`）或文件过大。
#[tauri::command]
pub async fn show_project_open(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        recorder::read_show(&resolved_dir(&app), Path::new(&path)).map_err(show_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把工程保存到库外的 `.artshow` 文件（另存为 / 导出副本）。
///
/// # Arguments
///
/// * `path` - 用户在对话框里选择的目标路径。
/// * `json` - 工程 JSON 文本。
///
/// # Errors
///
/// 路径不合法（`bad_path`）、内容不合格，或文件系统错误描述。
#[tauri::command]
pub async fn show_external_save(path: String, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        recorder::write_external(Path::new(&path), &json).map_err(show_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取库外的 `.artshow` 文件。
///
/// # Arguments
///
/// * `path` - 用户在对话框里选择的文件路径。
///
/// # Returns
///
/// 工程 JSON 文本。
///
/// # Errors
///
/// 路径不合法（`bad_path`）、文件不存在（`not_found`）或过大。
#[tauri::command]
pub async fn show_external_read(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        recorder::read_external(Path::new(&path)).map_err(show_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 自动存档文件的路径。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 数据根目录下的自动存档路径。
fn autosave_path(app: &AppHandle) -> PathBuf {
    app.state::<crate::data_dir::DataRoot>()
        .path()
        .to_path_buf()
        .join(AUTOSAVE_FILE)
}

/// 写入自动存档（覆盖上一份）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `json` - 工程 JSON 文本。
///
/// # Errors
///
/// 内容不合格，或文件系统错误描述。
#[tauri::command]
pub async fn show_autosave_write(app: AppHandle, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = autosave_path(&app);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        recorder::write_external(&path, &json).map_err(show_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取自动存档。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Returns
///
/// 存档的工程 JSON 文本；没有存档时为 `None`。
///
/// # Errors
///
/// 存档存在但无法读取时返回错误码。
#[tauri::command]
pub async fn show_autosave_read(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match recorder::read_external(&autosave_path(&app)) {
            Ok(text) => Ok(Some(text)),
            Err(ShowError::Library(recorder::LibraryError::NotFound)) => Ok(None),
            Err(e) => Err(show_err(e)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除自动存档（已保存或用户放弃恢复时）。不存在时什么都不做。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
#[tauri::command]
pub fn show_autosave_clear(app: AppHandle) {
    let _ = std::fs::remove_file(autosave_path(&app));
}

#[cfg(test)]
mod tests {
    use super::*;
    use recorder::LibraryError;

    #[test]
    fn 错误码映射() {
        assert_eq!(show_err(ShowError::TooLarge), "project_too_large");
        assert_eq!(show_err(ShowError::InvalidJson), "invalid_project");
        assert_eq!(show_err(ShowError::BadPath), "bad_path");
        assert_eq!(show_err(ShowError::Library(LibraryError::OutsideLibrary)), "outside_library");
        assert_eq!(show_err(ShowError::Library(LibraryError::NotFound)), "not_found");
    }

    #[test]
    fn 保存参数使用驼峰字段名且备注与文件名主干可省略() {
        let args: ShowSaveArgs =
            serde_json::from_str(r#"{"name":"秀","json":"{}"}"#).expect("最小参数可解析");
        assert!(args.path.is_none() && args.notes.is_empty() && args.file_stem.is_empty());
        let full: ShowSaveArgs = serde_json::from_str(
            r#"{"path":"D:/a.artrec","name":"秀","notes":"n","fileStem":"stem","json":"{}"}"#,
        )
        .expect("完整参数可解析");
        assert_eq!(full.file_stem, "stem");
    }
}
