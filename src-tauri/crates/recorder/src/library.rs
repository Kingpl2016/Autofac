//! 节目库：列出、重命名、删除录制目录里的 `.artrec` 节目（及其 sidecar）。
//!
//! 所有接收外部路径的函数都先经 [`resolve_in_dir`] 校验：路径必须是录制目录**直接子级**
//! 的 `.artrec` 文件，防止通过 `..` 或任意绝对路径误删 / 误改目录外的文件。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use artrec_core::ArtRecReader;
use serde::Serialize;

use crate::sidecar::{read_sidecar, sidecar_path, write_sidecar};
use crate::store::{sanitize_file_stem, ARTREC_SUFFIX};

/// 节目库中的一条节目（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    /// `.artrec` 绝对路径。
    pub path: String,
    /// 文件名（含扩展名）。
    pub file_name: String,
    /// 显示名（sidecar 的 `name`，缺失时取文件名主干）。
    pub name: String,
    /// 备注。
    pub notes: String,
    /// 文件字节数。
    pub bytes: u64,
    /// 最后修改时间（Unix 毫秒）。
    pub modified_unix_ms: u64,
    /// 时长（微秒）。
    pub duration_us: u64,
    /// 帧数。
    pub frames: u64,
    /// Universe 集合。
    pub universes: Vec<u16>,
    /// 录到数据的来源 IP。
    pub sources: Vec<String>,
    /// 是否由崩溃恢复生成。
    pub recovered: bool,
    /// 文件头是否可解析（false 表示文件损坏或不是 ArtRec）。
    pub valid: bool,
}

/// 库操作错误。
#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    /// 路径不在录制目录内，或不是 `.artrec` 文件。
    #[error("路径不在录制目录内或不是 .artrec 文件")]
    OutsideLibrary,
    /// 目标文件不存在。
    #[error("文件不存在")]
    NotFound,
    /// 目标名称已被占用。
    #[error("同名节目已存在")]
    AlreadyExists,
    /// 文件系统错误。
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
}

/// 校验 `path` 是 `dir` 直接子级的 `.artrec` 文件，返回规整后的路径。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `path` - 外部传入的路径。
///
/// # Returns
///
/// 校验通过时返回 `path` 规范化（`canonicalize`）后的路径。
///
/// # Errors
///
/// - [`LibraryError::OutsideLibrary`]：不在目录内、含 `..` 穿越或扩展名不是 `.artrec`。
/// - [`LibraryError::NotFound`]：文件不存在。
pub fn resolve_in_dir(dir: &Path, path: &Path) -> Result<PathBuf, LibraryError> {
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("artrec"));
    if !ext_ok {
        return Err(LibraryError::OutsideLibrary);
    }
    let file = std::fs::canonicalize(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            LibraryError::NotFound
        } else {
            LibraryError::Io(e)
        }
    })?;
    let root = std::fs::canonicalize(dir)?;
    if file.parent() != Some(root.as_path()) || !file.is_file() {
        return Err(LibraryError::OutsideLibrary);
    }
    Ok(file)
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn entry_for(path: &Path) -> Option<LibraryEntry> {
    let meta = std::fs::metadata(path).ok()?;
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    let stem = file_name
        .strip_suffix(ARTREC_SUFFIX)
        .unwrap_or(&file_name)
        .to_string();
    let mut entry = LibraryEntry {
        path: path.to_string_lossy().into_owned(),
        file_name,
        name: stem,
        notes: String::new(),
        bytes: meta.len(),
        modified_unix_ms: modified_ms(&meta),
        duration_us: 0,
        frames: 0,
        universes: Vec::new(),
        sources: Vec::new(),
        recovered: false,
        valid: false,
    };

    // 事实以 `.artrec` 本体为准（头可解析才算有效）；sidecar 只补充名称与来源等元信息
    if let Ok(reader) = ArtRecReader::open_file(path) {
        entry.valid = true;
        entry.duration_us = reader.header().total_duration_us;
        entry.frames = u64::from(reader.header().frame_count);
        entry.universes = reader.unis().iter().map(|u| u.universe).collect();
    }
    if let Some(meta) = read_sidecar(path) {
        if !meta.name.trim().is_empty() {
            entry.name = meta.name;
        }
        entry.notes = meta.notes;
        entry.sources = meta.sources.iter().map(ToString::to_string).collect();
        entry.recovered = meta.recovered;
    }
    Some(entry)
}

/// 列出目录下全部节目，按修改时间从新到旧排序。目录不存在时返回空列表。
///
/// # Arguments
///
/// * `dir` - 录制目录。
///
/// # Returns
///
/// 目录下全部节目的 [`LibraryEntry`]，按修改时间从新到旧排序（时间相同按文件名升序）；目录不存在时为空。
#[must_use]
pub fn list_library(dir: &Path) -> Vec<LibraryEntry> {
    let mut out: Vec<LibraryEntry> = crate::store::list_artrec_files(dir)
        .iter()
        .filter_map(|p| entry_for(p))
        .collect();
    out.sort_by(|a, b| {
        b.modified_unix_ms
            .cmp(&a.modified_unix_ms)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
    out
}

/// 重命名节目：同时重命名文件与 sidecar，并把 sidecar 的显示名更新为 `new_name`。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `path` - 节目路径。
/// * `new_name` - 新显示名；文件名由它规整得到。
///
/// # Returns
///
/// 重命名后的新路径。
///
/// # Errors
///
/// 路径非法、目标已存在或文件系统失败。
pub fn rename_recording(
    dir: &Path,
    path: &Path,
    new_name: &str,
) -> Result<PathBuf, LibraryError> {
    let src = resolve_in_dir(dir, path)?;
    let stem = sanitize_file_stem(new_name);
    let dst = src.with_file_name(format!("{stem}{ARTREC_SUFFIX}"));
    if dst != src && dst.exists() {
        return Err(LibraryError::AlreadyExists);
    }
    let mut meta = read_sidecar(&src).unwrap_or_default();
    if dst != src {
        std::fs::rename(&src, &dst)?;
        let _ = std::fs::remove_file(sidecar_path(&src));
    }
    meta.name = new_name.trim().to_string();
    write_sidecar(&dst, &meta)?;
    Ok(dst)
}

/// 删除节目及其 sidecar。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `path` - 待删除节目的路径，须通过 [`resolve_in_dir`] 校验。
///
/// # Errors
///
/// 路径非法或文件系统失败。
pub fn delete_recording(dir: &Path, path: &Path) -> Result<(), LibraryError> {
    let src = resolve_in_dir(dir, path)?;
    std::fs::remove_file(&src)?;
    let _ = std::fs::remove_file(sidecar_path(&src));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use artrec_core::{ArtRecWriter, CompressAlgo, UniDesc};

    use super::{
        delete_recording, list_library, rename_recording, resolve_in_dir, LibraryError,
    };
    use crate::sidecar::{read_sidecar, sidecar_path, write_sidecar, Sidecar};
    use crate::testutil::TempDir;

    /// 写出一个含 `frames` 帧的合法 `.artrec`。
    fn make_artrec(dir: &TempDir, stem: &str, frames: u64) -> std::path::PathBuf {
        let unis = vec![UniDesc::from_universe(3, 512).unwrap()];
        let mut w =
            ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 3, 0, 0).unwrap();
        for i in 0..frames {
            w.add_full_frame(i * 1000, &[vec![i as u8; 512]]).unwrap();
        }
        let bytes = w.finish(frames * 1000).unwrap().into_inner();
        let p = dir.path().join(format!("{stem}.artrec"));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn lists_with_and_without_sidecar() {
        let dir = TempDir::new("lib-list");
        let a = make_artrec(&dir, "a", 3);
        let _b = make_artrec(&dir, "b", 5);
        write_sidecar(
            &a,
            &Sidecar {
                name: "开场".into(),
                notes: "备注".into(),
                sources: vec!["10.0.0.7".parse().unwrap()],
                ..Sidecar::default()
            },
        )
        .unwrap();
        std::fs::write(dir.path().join("junk.artrec"), b"not artrec").unwrap();
        std::fs::write(dir.path().join("other.txt"), b"x").unwrap();

        let list = list_library(dir.path());
        assert_eq!(list.len(), 3);
        let ea = list.iter().find(|e| e.file_name == "a.artrec").unwrap();
        assert_eq!(ea.name, "开场");
        assert_eq!(ea.notes, "备注");
        assert_eq!(ea.frames, 3);
        assert_eq!(ea.universes, vec![3]);
        assert_eq!(ea.sources, vec!["10.0.0.7".to_string()]);
        assert!(ea.valid);
        let eb = list.iter().find(|e| e.file_name == "b.artrec").unwrap();
        assert_eq!(eb.name, "b", "无 sidecar 时回落到文件名主干");
        assert_eq!(eb.frames, 5);
        let junk = list.iter().find(|e| e.file_name == "junk.artrec").unwrap();
        assert!(!junk.valid);
    }

    #[test]
    fn missing_dir_lists_empty() {
        let dir = TempDir::new("lib-missing");
        assert!(list_library(&dir.path().join("nope")).is_empty());
    }

    #[test]
    fn rejects_paths_outside_library() {
        let dir = TempDir::new("lib-safe");
        let other = TempDir::new("lib-other");
        let inside = make_artrec(&dir, "in", 1);
        let outside = make_artrec(&other, "out", 1);
        assert!(resolve_in_dir(dir.path(), &inside).is_ok());
        assert!(matches!(
            resolve_in_dir(dir.path(), &outside),
            Err(LibraryError::OutsideLibrary)
        ));
        // `..` 穿越
        let traversal = dir
            .path()
            .join("..")
            .join(other.path().file_name().unwrap())
            .join("out.artrec");
        assert!(matches!(
            resolve_in_dir(dir.path(), &traversal),
            Err(LibraryError::OutsideLibrary)
        ));
        // 非 .artrec 扩展名
        let txt = dir.path().join("x.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert!(matches!(
            resolve_in_dir(dir.path(), &txt),
            Err(LibraryError::OutsideLibrary)
        ));
        assert!(matches!(
            delete_recording(dir.path(), &outside),
            Err(LibraryError::OutsideLibrary)
        ));
        assert!(outside.exists());
    }

    #[test]
    fn rename_moves_file_and_sidecar() {
        let dir = TempDir::new("lib-rename");
        let p = make_artrec(&dir, "old", 2);
        write_sidecar(&p, &Sidecar { name: "旧名".into(), notes: "n".into(), ..Sidecar::default() })
            .unwrap();

        let np = rename_recording(dir.path(), &p, "新 名/称").unwrap();
        assert_eq!(np.file_name().unwrap(), "新 名_称.artrec");
        assert!(!p.exists());
        assert!(!sidecar_path(&p).exists());
        let meta = read_sidecar(&np).unwrap();
        assert_eq!(meta.name, "新 名/称");
        assert_eq!(meta.notes, "n");
    }

    #[test]
    fn rename_refuses_to_overwrite() {
        let dir = TempDir::new("lib-rename-dup");
        let a = make_artrec(&dir, "a", 1);
        let _b = make_artrec(&dir, "b", 1);
        assert!(matches!(
            rename_recording(dir.path(), &a, "b"),
            Err(LibraryError::AlreadyExists)
        ));
        assert!(a.exists());
    }

    #[test]
    fn delete_removes_sidecar_too() {
        let dir = TempDir::new("lib-del");
        let p = make_artrec(&dir, "d", 1);
        write_sidecar(&p, &Sidecar::default()).unwrap();
        delete_recording(dir.path(), &p).unwrap();
        assert!(!p.exists());
        assert!(!sidecar_path(&p).exists());
        assert!(matches!(
            delete_recording(dir.path(), &p),
            Err(LibraryError::NotFound)
        ));
    }
}
