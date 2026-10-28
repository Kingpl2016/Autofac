//! Tauri 命令：节目编辑器特效库的用户配置文件（`data/effects.json`）读写、导入导出与在文件夹中显示。
//!
//! 与 Cue 模板文件（[`crate::cue_template_commands`]）同样的约定：文件内容（声明式特效定义）
//! 只在前端解析与校验，这里只负责文件系统——大小上限、必须是 JSON、原子写入，以及导入 / 导出时检查扩展名。
//! 特效文件只含数据，不含任何可执行脚本。
//! 错误以字符串错误码返回：`bad_path`、`file_too_large`、`invalid_json`、`io`。

use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::cue_template_commands::{
    check_json, check_json_path, read_text, write_atomic, ERR_IO, MAX_TEMPLATE_BYTES,
};
use crate::data_dir::DataRoot;

/// 用户特效文件名（位于数据根目录下）。
pub const EFFECTS_FILE: &str = "effects.json";

/// 新建用户特效文件时写入的内容（空列表，供用户照着格式添加）。
pub const EMPTY_EFFECTS: &str = "{\n  \"version\": 1,\n  \"effects\": []\n}\n";

/// 用户特效文件的完整路径。
///
/// # Arguments
///
/// * `root` - 数据根目录。
///
/// # Returns
///
/// `<数据根目录>/effects.json`。
fn effects_path(root: &DataRoot) -> PathBuf {
    root.path().join(EFFECTS_FILE)
}

/// 读取用户特效文件。
///
/// # Arguments
///
/// * `root` - 数据根目录。
///
/// # Returns
///
/// 文件内容；文件不存在时为 `None`（只有内置特效）。
///
/// # Errors
///
/// 文件过大（`file_too_large`）或读取失败（`io`）。
#[tauri::command]
pub fn effects_read(root: State<'_, DataRoot>) -> Result<Option<String>, String> {
    read_text(&effects_path(&root), MAX_TEMPLATE_BYTES)
}

/// 写入用户特效文件（整份替换，原子写入）。
///
/// # Arguments
///
/// * `root` - 数据根目录。
/// * `text` - 文件内容（JSON）。
///
/// # Errors
///
/// 内容过大（`file_too_large`）、不是 JSON（`invalid_json`）或写入失败（`io`）。
#[tauri::command]
pub fn effects_write(root: State<'_, DataRoot>, text: String) -> Result<(), String> {
    check_json(&text)?;
    write_atomic(&effects_path(&root), &text).map_err(|_| ERR_IO.to_owned())
}

/// 读取用户选择的特效文件（导入）。
///
/// # Arguments
///
/// * `path` - 用户选择的 `.json` 文件。
///
/// # Returns
///
/// 文件内容。
///
/// # Errors
///
/// 扩展名不对（`bad_path`）、文件不存在或读取失败（`io`）、过大（`file_too_large`）、
/// 不是 JSON（`invalid_json`）。
#[tauri::command]
pub fn effects_import(path: String) -> Result<String, String> {
    let path = check_json_path(&path)?;
    let text = read_text(&path, MAX_TEMPLATE_BYTES)?.ok_or_else(|| ERR_IO.to_owned())?;
    check_json(&text)?;
    Ok(text)
}

/// 把特效写到用户选择的位置（导出）。
///
/// # Arguments
///
/// * `path` - 目标 `.json` 文件。
/// * `text` - 文件内容（JSON）。
///
/// # Errors
///
/// 扩展名不对（`bad_path`）、内容不合法（`file_too_large` / `invalid_json`）或写入失败（`io`）。
#[tauri::command]
pub fn effects_export(path: String, text: String) -> Result<(), String> {
    let path = check_json_path(&path)?;
    check_json(&text)?;
    write_atomic(&path, &text).map_err(|_| ERR_IO.to_owned())
}

/// 在系统文件管理器里显示用户特效文件；文件还不存在时先写一个空列表，方便照着格式手改。
///
/// # Arguments
///
/// * `app` - 应用句柄（打开文件管理器）。
/// * `root` - 数据根目录。
///
/// # Returns
///
/// 文件的完整路径。
///
/// # Errors
///
/// 创建文件或打开文件管理器失败时返回 `io`。
#[tauri::command]
pub fn effects_reveal(app: AppHandle, root: State<'_, DataRoot>) -> Result<String, String> {
    let path = effects_path(&root);
    if !path.exists() {
        write_atomic(&path, EMPTY_EFFECTS).map_err(|_| ERR_IO.to_owned())?;
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|_| ERR_IO.to_owned())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空列表模板是合法_json() {
        assert!(check_json(EMPTY_EFFECTS).is_ok());
        let v: serde_json::Value = serde_json::from_str(EMPTY_EFFECTS).unwrap();
        assert_eq!(v["version"], 1);
        assert!(v["effects"].as_array().is_some_and(Vec::is_empty));
    }

    #[test]
    fn 导入导出只接受_json_扩展名() {
        assert_eq!(effects_import("D:/a/特效.txt".to_owned()), Err("bad_path".to_owned()));
        assert_eq!(
            effects_export("D:/a/特效.txt".to_owned(), EMPTY_EFFECTS.to_owned()),
            Err("bad_path".to_owned())
        );
    }

    #[test]
    fn 导出后可再导入() {
        let dir = std::env::temp_dir().join(format!("ans-effects-{}", std::process::id()));
        let path = dir.join("导出.json");
        let text = "{\"version\":1,\"effects\":[]}";
        effects_export(path.to_string_lossy().into_owned(), text.to_owned()).unwrap();
        assert_eq!(effects_import(path.to_string_lossy().into_owned()).as_deref(), Ok(text));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
