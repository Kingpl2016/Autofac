//! Tauri 命令：节目编辑器 Cue 模板的用户配置文件（`data/cue-templates.json`）读写、导入导出与在文件夹中显示。
//!
//! 文件内容由前端解析与校验（模板结构只在前端使用）；这里只负责文件系统：大小上限、必须是 JSON、
//! 原子写入（先写临时文件再改名），以及导入 / 导出时检查扩展名。
//! 错误以字符串错误码返回：`bad_path`、`file_too_large`、`invalid_json`、`io`。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::data_dir::DataRoot;

/// 用户模板文件名（位于数据根目录下）。
pub const TEMPLATES_FILE: &str = "cue-templates.json";

/// 模板文件大小上限（字节）。
pub const MAX_TEMPLATE_BYTES: u64 = 1024 * 1024;

/// 错误码：路径不是 `.json` 文件。
pub const ERR_BAD_PATH: &str = "bad_path";

/// 错误码：文件超过大小上限。
pub const ERR_FILE_TOO_LARGE: &str = "file_too_large";

/// 错误码：内容不是 JSON。
pub const ERR_INVALID_JSON: &str = "invalid_json";

/// 错误码：读写失败。
pub const ERR_IO: &str = "io";

/// 新建用户模板文件时写入的内容（空列表，供用户照着格式添加）。
pub const EMPTY_TEMPLATES: &str = "{\n  \"version\": 1,\n  \"templates\": []\n}\n";

/// 读取文本文件（有大小上限）。
///
/// # Arguments
///
/// * `path` - 文件路径。
/// * `max` - 大小上限（字节）。
///
/// # Returns
///
/// 文件存在时返回 `Some(内容)`，不存在时返回 `None`。
///
/// # Errors
///
/// - 文件超过 `max` 时返回 [`ERR_FILE_TOO_LARGE`]。
/// - 路径不是文件或读取失败时返回 [`ERR_IO`]。
pub fn read_text(path: &Path, max: u64) -> Result<Option<String>, String> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ERR_IO.to_owned()),
    };
    if !meta.is_file() {
        return Err(ERR_IO.to_owned());
    }
    if meta.len() > max {
        return Err(ERR_FILE_TOO_LARGE.to_owned());
    }
    fs::read_to_string(path).map(Some).map_err(|_| ERR_IO.to_owned())
}

/// 检查文本是否在大小上限内且是合法 JSON。
///
/// # Arguments
///
/// * `text` - 要写入的文本。
///
/// # Errors
///
/// - 超过 [`MAX_TEMPLATE_BYTES`] 时返回 [`ERR_FILE_TOO_LARGE`]。
/// - 不是合法 JSON 时返回 [`ERR_INVALID_JSON`]。
pub fn check_json(text: &str) -> Result<(), String> {
    if text.len() as u64 > MAX_TEMPLATE_BYTES {
        return Err(ERR_FILE_TOO_LARGE.to_owned());
    }
    serde_json::from_str::<serde_json::Value>(text)
        .map(|_| ())
        .map_err(|_| ERR_INVALID_JSON.to_owned())
}

/// 原子写入：先写同目录下的临时文件再改名，避免写到一半断电留下损坏的文件。
///
/// # Arguments
///
/// * `path` - 目标文件。
/// * `text` - 内容。
///
/// # Errors
///
/// 创建目录、写临时文件或改名失败时返回底层 IO 错误。
pub fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

/// 检查导入 / 导出路径：必须以 `.json` 结尾。
///
/// # Arguments
///
/// * `path` - 用户在对话框里选择的路径。
///
/// # Returns
///
/// 规整后的路径。
///
/// # Errors
///
/// 扩展名不是 `.json` 时返回 [`ERR_BAD_PATH`]。
pub fn check_json_path(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path.trim());
    let is_json = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if is_json {
        Ok(path.to_path_buf())
    } else {
        Err(ERR_BAD_PATH.to_owned())
    }
}

/// 用户模板文件的完整路径。
fn templates_path(root: &DataRoot) -> PathBuf {
    root.path().join(TEMPLATES_FILE)
}

/// 读取用户模板文件。
///
/// # Arguments
///
/// * `root` - 数据根目录。
///
/// # Returns
///
/// 文件内容；文件不存在时为 `None`（只有内置模板）。
///
/// # Errors
///
/// 文件过大（[`ERR_FILE_TOO_LARGE`]）或读取失败（[`ERR_IO`]）。
#[tauri::command]
pub fn cue_templates_read(root: State<'_, DataRoot>) -> Result<Option<String>, String> {
    read_text(&templates_path(&root), MAX_TEMPLATE_BYTES)
}

/// 写入用户模板文件（整份替换，原子写入）。
///
/// # Arguments
///
/// * `root` - 数据根目录。
/// * `text` - 文件内容（JSON）。
///
/// # Errors
///
/// 内容过大（[`ERR_FILE_TOO_LARGE`]）、不是 JSON（[`ERR_INVALID_JSON`]）或写入失败（[`ERR_IO`]）。
#[tauri::command]
pub fn cue_templates_write(root: State<'_, DataRoot>, text: String) -> Result<(), String> {
    check_json(&text)?;
    write_atomic(&templates_path(&root), &text).map_err(|_| ERR_IO.to_owned())
}

/// 读取用户选择的模板文件（导入）。
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
/// 扩展名不对（[`ERR_BAD_PATH`]）、文件不存在或读取失败（[`ERR_IO`]）、过大（[`ERR_FILE_TOO_LARGE`]）、
/// 不是 JSON（[`ERR_INVALID_JSON`]）。
#[tauri::command]
pub fn cue_templates_import(path: String) -> Result<String, String> {
    let path = check_json_path(&path)?;
    let text = read_text(&path, MAX_TEMPLATE_BYTES)?.ok_or_else(|| ERR_IO.to_owned())?;
    check_json(&text)?;
    Ok(text)
}

/// 把模板写到用户选择的位置（导出）。
///
/// # Arguments
///
/// * `path` - 目标 `.json` 文件。
/// * `text` - 文件内容（JSON）。
///
/// # Errors
///
/// 扩展名不对（[`ERR_BAD_PATH`]）、内容不合法（[`ERR_FILE_TOO_LARGE`] / [`ERR_INVALID_JSON`]）或写入失败（[`ERR_IO`]）。
#[tauri::command]
pub fn cue_templates_export(path: String, text: String) -> Result<(), String> {
    let path = check_json_path(&path)?;
    check_json(&text)?;
    write_atomic(&path, &text).map_err(|_| ERR_IO.to_owned())
}

/// 在系统文件管理器里显示用户模板文件；文件还不存在时先写一个空列表，方便照着格式手改。
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
/// 创建文件或打开文件管理器失败时返回 [`ERR_IO`]。
#[tauri::command]
pub fn cue_templates_reveal(app: AppHandle, root: State<'_, DataRoot>) -> Result<String, String> {
    let path = templates_path(&root);
    if !path.exists() {
        write_atomic(&path, EMPTY_TEMPLATES).map_err(|_| ERR_IO.to_owned())?;
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|_| ERR_IO.to_owned())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的临时目录（结束时删除）。
    struct Tmp(PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("ans-cuetpl-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn 读不存在的文件返回_none_过大的报错() {
        let tmp = Tmp::new("read");
        assert_eq!(read_text(&tmp.0.join("none.json"), 10), Ok(None));
        let big = tmp.0.join("big.json");
        fs::write(&big, "x".repeat(20)).unwrap();
        assert_eq!(read_text(&big, 10), Err(ERR_FILE_TOO_LARGE.to_owned()));
        assert_eq!(read_text(&tmp.0, 10), Err(ERR_IO.to_owned()));
    }

    #[test]
    fn 原子写入后可读回_不留临时文件() {
        let tmp = Tmp::new("write");
        let path = tmp.0.join("sub").join(TEMPLATES_FILE);
        write_atomic(&path, EMPTY_TEMPLATES).unwrap();
        assert_eq!(read_text(&path, MAX_TEMPLATE_BYTES).unwrap().as_deref(), Some(EMPTY_TEMPLATES));
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn 只接受_json_内容与_json_扩展名() {
        assert!(check_json(EMPTY_TEMPLATES).is_ok());
        assert_eq!(check_json("{oops"), Err(ERR_INVALID_JSON.to_owned()));
        assert!(check_json_path("D:/a/模板.JSON").is_ok());
        assert_eq!(check_json_path("D:/a/模板.txt"), Err(ERR_BAD_PATH.to_owned()));
    }
}
