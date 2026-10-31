//! 回收站：删除的用户数据（技能目录、MCP 服务器配置、记忆…）先挪到这里，30 天内可以恢复。
//!
//! 每个条目一个子目录 `<id>/`：`meta.json` 记种类、显示名与删除时间，内容放在 `payload/`（目录）
//! 或 `payload.json`（一段 JSON）。条目 id 只含小写字母、数字与连字符，前端传入时先校验，不会越出回收站目录。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::SkillError;

/// 回收站条目保留多久（毫秒）：30 天。
pub const KEEP_MS: u64 = 30 * 24 * 3600 * 1000;

/// 一个回收站条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// 条目 id。
    pub id: String,
    /// 种类（`skill` / `mcp` / `memory`…）。
    pub kind: String,
    /// 显示名。
    pub label: String,
    /// 删除时间（Unix 毫秒）。
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub deleted_at_ms: u64,
}

/// 回收站。
pub struct Trash {
    dir: PathBuf,
    seq: AtomicU32,
}

/// 校验条目 id / 种类：只含小写字母、数字与连字符。
fn valid_token(s: &str) -> bool {
    !s.is_empty() && s.len() <= 96 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl Trash {
    /// 打开回收站（目录不存在时在第一次放入时创建）。
    ///
    /// # Arguments
    ///
    /// * `dir` - 回收站目录。
    ///
    /// # Returns
    ///
    /// 回收站。
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, seq: AtomicU32::new(0) }
    }

    /// 条目目录（校验 id）。
    fn entry_dir(&self, id: &str) -> Result<PathBuf, SkillError> {
        if !valid_token(id) {
            return Err(SkillError::NotFound);
        }
        let dir = self.dir.join(id);
        if dir.join("meta.json").is_file() { Ok(dir) } else { Err(SkillError::NotFound) }
    }

    /// 新建一个条目目录并写入元数据。
    fn create(&self, kind: &str, label: &str, now_ms: u64) -> Result<(TrashEntry, PathBuf), SkillError> {
        if !valid_token(kind) {
            return Err(SkillError::Invalid(format!("invalid trash kind '{kind}'")));
        }
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let entry = TrashEntry {
            id: format!("{now_ms}-{kind}-{seq}"),
            kind: kind.to_owned(),
            label: label.chars().take(120).collect(),
            deleted_at_ms: now_ms,
        };
        let dir = self.dir.join(&entry.id);
        std::fs::create_dir_all(&dir)?;
        let meta = serde_json::to_vec(&entry).map_err(|e| SkillError::Invalid(e.to_string()))?;
        fsutil::write_atomic(&dir.join("meta.json"), &meta)?;
        Ok((entry, dir))
    }

    /// 把一个目录挪进回收站。
    ///
    /// # Arguments
    ///
    /// * `kind` - 种类。
    /// * `label` - 显示名。
    /// * `src` - 要挪走的目录（之后不再存在）。
    /// * `now_ms` - 当前时间（Unix 毫秒）。
    ///
    /// # Returns
    ///
    /// 新条目。
    ///
    /// # Errors
    ///
    /// 种类不合规或挪动失败时返回错误。
    pub fn put_dir(&self, kind: &str, label: &str, src: &Path, now_ms: u64) -> Result<TrashEntry, SkillError> {
        let (entry, dir) = self.create(kind, label, now_ms)?;
        if let Err(e) = std::fs::rename(src, dir.join("payload")) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e.into());
        }
        Ok(entry)
    }

    /// 把一段 JSON 放进回收站。
    ///
    /// # Arguments
    ///
    /// * `kind` - 种类。
    /// * `label` - 显示名。
    /// * `json` - 内容（必须是合法 JSON，最多 2 MiB）。
    /// * `now_ms` - 当前时间（Unix 毫秒）。
    ///
    /// # Returns
    ///
    /// 新条目。
    ///
    /// # Errors
    ///
    /// 内容不是 JSON、过大或写盘失败时返回错误。
    pub fn put_json(&self, kind: &str, label: &str, json: &str, now_ms: u64) -> Result<TrashEntry, SkillError> {
        if json.len() > 2 * 1024 * 1024 {
            return Err(SkillError::TooLarge);
        }
        serde_json::from_str::<serde_json::Value>(json).map_err(|e| SkillError::Invalid(e.to_string()))?;
        let (entry, dir) = self.create(kind, label, now_ms)?;
        fsutil::write_atomic(&dir.join("payload.json"), json.as_bytes())?;
        Ok(entry)
    }

    /// 列出条目（新的在前）。
    ///
    /// # Returns
    ///
    /// 条目；损坏的跳过。
    pub fn list(&self) -> Vec<TrashEntry> {
        let Ok(read) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut out: Vec<TrashEntry> = read
            .flatten()
            .filter_map(|e| std::fs::read(e.path().join("meta.json")).ok())
            .filter_map(|b| serde_json::from_slice(&b).ok())
            .collect();
        out.sort_by(|a, b| b.deleted_at_ms.cmp(&a.deleted_at_ms).then_with(|| b.id.cmp(&a.id)));
        out
    }

    /// 读取条目的元数据。
    ///
    /// # Arguments
    ///
    /// * `id` - 条目 id。
    ///
    /// # Returns
    ///
    /// 元数据。
    ///
    /// # Errors
    ///
    /// 不存在时返回 [`SkillError::NotFound`]。
    pub fn entry(&self, id: &str) -> Result<TrashEntry, SkillError> {
        let dir = self.entry_dir(id)?;
        serde_json::from_slice(&std::fs::read(dir.join("meta.json"))?).map_err(|_| SkillError::NotFound)
    }

    /// 取回一个目录条目：挪到 `dest`，并删除条目。
    ///
    /// # Arguments
    ///
    /// * `id` - 条目 id。
    /// * `dest` - 目标目录（不能已存在）。
    ///
    /// # Returns
    ///
    /// 条目的元数据。
    ///
    /// # Errors
    ///
    /// 条目不存在或不是目录条目时返回 [`SkillError::NotFound`]；目标已存在时返回 [`SkillError::Exists`]。
    pub fn take_dir(&self, id: &str, dest: &Path) -> Result<TrashEntry, SkillError> {
        let entry = self.entry(id)?;
        let dir = self.entry_dir(id)?;
        let payload = dir.join("payload");
        if !payload.is_dir() {
            return Err(SkillError::NotFound);
        }
        if dest.exists() {
            return Err(SkillError::Exists);
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&payload, dest)?;
        let _ = std::fs::remove_dir_all(&dir);
        Ok(entry)
    }

    /// 取回一个 JSON 条目，并删除条目。
    ///
    /// # Arguments
    ///
    /// * `id` - 条目 id。
    ///
    /// # Returns
    ///
    /// 元数据与 JSON 文本。
    ///
    /// # Errors
    ///
    /// 条目不存在或不是 JSON 条目时返回 [`SkillError::NotFound`]。
    pub fn take_json(&self, id: &str) -> Result<(TrashEntry, String), SkillError> {
        let entry = self.entry(id)?;
        let dir = self.entry_dir(id)?;
        let text = std::fs::read_to_string(dir.join("payload.json")).map_err(|_| SkillError::NotFound)?;
        let _ = std::fs::remove_dir_all(&dir);
        Ok((entry, text))
    }

    /// 彻底删除一个条目。
    ///
    /// # Arguments
    ///
    /// * `id` - 条目 id。
    ///
    /// # Errors
    ///
    /// 不存在时返回 [`SkillError::NotFound`]；删除失败时返回 [`SkillError::Io`]。
    pub fn remove(&self, id: &str) -> Result<(), SkillError> {
        let dir = self.entry_dir(id)?;
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    /// 清掉过期的条目。
    ///
    /// # Arguments
    ///
    /// * `now_ms` - 当前时间（Unix 毫秒）。
    /// * `keep_ms` - 保留多久（毫秒）。
    ///
    /// # Returns
    ///
    /// 清掉的条目数。
    pub fn purge(&self, now_ms: u64, keep_ms: u64) -> usize {
        let mut n = 0;
        for e in self.list() {
            if now_ms.saturating_sub(e.deleted_at_ms) > keep_ms && self.remove(&e.id).is_ok() {
                n += 1;
            }
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 目录与_json_条目的放入_列出_取回() {
        let tmp = tempfile::tempdir().unwrap();
        let trash = Trash::new(tmp.path().join("trash"));
        let src = tmp.path().join("skill");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "x").unwrap();
        let a = trash.put_dir("skill", "My skill", &src, 1000).unwrap();
        assert!(!src.exists());
        let b = trash.put_json("mcp", "Server", "{\"a\":1}", 2000).unwrap();
        assert_eq!(trash.list().iter().map(|e| e.id.clone()).collect::<Vec<_>>(), vec![b.id.clone(), a.id.clone()]);

        let back = tmp.path().join("restored");
        trash.take_dir(&a.id, &back).unwrap();
        assert_eq!(std::fs::read_to_string(back.join("SKILL.md")).unwrap(), "x");
        let (entry, json) = trash.take_json(&b.id).unwrap();
        assert_eq!((entry.label.as_str(), json.as_str()), ("Server", "{\"a\":1}"));
        assert!(trash.list().is_empty());
    }

    #[test]
    fn 过期清理_非法_id_与非_json() {
        let tmp = tempfile::tempdir().unwrap();
        let trash = Trash::new(tmp.path().to_path_buf());
        trash.put_json("memory", "old", "[]", 0).unwrap();
        let keep = trash.put_json("memory", "new", "[]", KEEP_MS).unwrap();
        assert_eq!(trash.purge(KEEP_MS + 10, KEEP_MS), 1);
        assert_eq!(trash.list(), vec![keep]);
        assert!(matches!(trash.take_json("../x"), Err(SkillError::NotFound)));
        assert!(matches!(trash.put_json("memory", "bad", "{oops", 0), Err(SkillError::Invalid(_))));
        assert!(matches!(trash.put_json("Bad/Kind", "x", "[]", 0), Err(SkillError::Invalid(_))));
    }
}
