//! AI 对话记录文件（`<工程名>.artshow.ai.json` 或节目库里的 `<id>.ai.json`）的读写。
//!
//! 文件内容（消息列表）只在前端解析与校验；这里只管文件系统：扩展名、大小上限、必须是 JSON、原子写入。

use std::path::{Path, PathBuf};

use crate::error::{AiError, Result};

/// 对话记录文件的扩展名后缀（小写比较）。
pub const HISTORY_SUFFIX: &str = ".ai.json";

/// 对话记录文件大小上限。
pub const MAX_HISTORY_BYTES: u64 = 8 * 1024 * 1024;

/// 检查路径是对话记录文件。
///
/// # Arguments
///
/// * `path` - 文件路径。
///
/// # Returns
///
/// 路径。
///
/// # Errors
///
/// 不以 `.ai.json` 结尾时返回 [`AiError::BadPath`]。
pub fn check_path(path: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path);
    let ok = p
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.to_lowercase().ends_with(HISTORY_SUFFIX) && n.len() > HISTORY_SUFFIX.len());
    if ok { Ok(p) } else { Err(AiError::BadPath) }
}

/// 读取对话记录。
///
/// # Arguments
///
/// * `path` - 对话记录文件（见 [`check_path`]）。
///
/// # Returns
///
/// 文件内容；文件不存在时为 `None`。
///
/// # Errors
///
/// 路径不合法（[`AiError::BadPath`]）、文件过大（[`AiError::FileTooLarge`]）或读取失败（[`AiError::Io`]）。
pub fn read(path: &Path) -> Result<Option<String>> {
    match std::fs::metadata(path) {
        Ok(m) if m.len() > MAX_HISTORY_BYTES => Err(AiError::FileTooLarge),
        Ok(_) => Ok(Some(std::fs::read_to_string(path)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 写入对话记录（整份替换，原子写入）。
///
/// # Arguments
///
/// * `path` - 对话记录文件。
/// * `text` - 内容（JSON）。
///
/// # Errors
///
/// 内容过大（[`AiError::FileTooLarge`]）、不是 JSON（[`AiError::InvalidJson`]）或写入失败（[`AiError::Io`]）。
pub fn write(path: &Path, text: &str) -> Result<()> {
    if text.len() as u64 > MAX_HISTORY_BYTES {
        return Err(AiError::FileTooLarge);
    }
    serde_json::from_str::<serde::de::IgnoredAny>(text).map_err(|_| AiError::InvalidJson)?;
    fsutil::write_atomic(path, text.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只接受_ai_json_后缀() {
        assert!(check_path("D:/show/演出.artshow.ai.json").is_ok());
        assert!(check_path("D:/show/A.AI.JSON").is_ok());
        assert!(matches!(check_path("D:/show/演出.artshow"), Err(AiError::BadPath)));
        assert!(matches!(check_path("D:/show/.ai.json"), Err(AiError::BadPath)));
        assert!(matches!(check_path("D:/show/settings.json"), Err(AiError::BadPath)));
    }

    #[test]
    fn 读写往返_不存在为空_非_json_与过大被拒() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.artshow.ai.json");
        assert_eq!(read(&path).unwrap(), None);
        write(&path, "{\"version\":1,\"messages\":[]}").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("{\"version\":1,\"messages\":[]}"));
        assert!(matches!(write(&path, "{oops"), Err(AiError::InvalidJson)));
        assert!(matches!(write(&path, &"x".repeat(MAX_HISTORY_BYTES as usize + 1)), Err(AiError::FileTooLarge)));
    }
}
