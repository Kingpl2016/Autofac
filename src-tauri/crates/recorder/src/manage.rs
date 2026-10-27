//! 节目库的元数据维护与复制：修改备注、创建副本，以及为新节目挑选不冲突的路径。
//!
//! 与 [`crate::library`] 的改名 / 删除一样，一个节目是一组文件（`.artrec`、`.artrec.json`、
//! 可选的 `.artrec.show` 与 `.artrec.ovw`），这里的操作把它们当作整体处理。

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::library::{resolve_entry, LibraryError};
use crate::show_store::patch_show_string;
use crate::sidecar::{overview_cache_path, read_sidecar, show_project_path, write_sidecar, SIDECAR_VERSION};
use crate::store::{sanitize_file_stem, unique_stem, ARTREC_SUFFIX};

/// 当前时间（Unix 毫秒）。
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// 在路径末尾追加后缀（不替换扩展名）。
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// 为一个新节目在录制目录里挑选 `.artrec` 路径：名称规整为文件名主干，
/// 与已有节目（`.artrec` 或只有工程的 `.artrec.show`）冲突时追加 `-2`、`-3`…。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `name` - 新节目的显示名。
///
/// # Returns
///
/// 目录内尚未被占用的 `.artrec` 路径（文件本身尚不存在）。
#[must_use]
pub fn unique_entry_path(dir: &Path, name: &str) -> PathBuf {
    let stem = unique_stem(dir, &sanitize_file_stem(name), &[ARTREC_SUFFIX, ".artrec.show"]);
    dir.join(format!("{stem}{ARTREC_SUFFIX}"))
}

/// 修改节目备注：写入 sidecar；节目带编辑器工程时同步改写工程里的 `notes`，
/// 否则下次在编辑器里保存会把备注覆盖回去。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `path` - 节目的 `.artrec` 路径（只有工程、尚未导出的节目也可以）。
/// * `notes` - 新备注（原样保存，不裁剪空白）。
///
/// # Errors
///
/// - 路径不在录制目录内或条目不存在，见 [`resolve_entry`]。
/// - 写入 sidecar 或工程文件失败返回 [`LibraryError::Io`]。
pub fn set_notes(dir: &Path, path: &Path, notes: &str) -> Result<(), LibraryError> {
    let artrec = resolve_entry(dir, path)?;
    // 先改工程：失败时 sidecar 也保持原样，两边不会不一致
    patch_show_string(&artrec, "notes", notes)?;
    let mut meta = read_sidecar(&artrec).unwrap_or_default();
    meta.version = SIDECAR_VERSION;
    notes.clone_into(&mut meta.notes);
    write_sidecar(&artrec, &meta)?;
    Ok(())
}

/// 经临时文件复制一个文件：先写 `dst.tmp` 再重命名，失败时不留下半个文件。
///
/// # Arguments
///
/// * `src` - 源文件。
/// * `dst` - 目标文件（不应已存在）。
///
/// # Errors
///
/// 复制或重命名失败返回 [`io::Error`]。
fn copy_atomic(src: &Path, dst: &Path) -> io::Result<()> {
    let tmp = with_suffix(dst, ".tmp");
    let result = std::fs::copy(src, &tmp).and_then(|_| std::fs::rename(&tmp, dst));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 创建节目副本：复制 `.artrec`、编辑器工程与概览缓存（存在的都复制），
/// 写入新的 sidecar（名称为 `new_name`、创建时间为现在，其余元数据沿用原节目）。
///
/// 带工程的节目复制后仍可在编辑器里打开；工程里的 `name` 一并改为新名称。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `path` - 源节目的 `.artrec` 路径。
/// * `new_name` - 副本的显示名；文件名由它规整得到，重名时自动追加编号。
///
/// # Returns
///
/// 副本的 `.artrec` 路径（只有工程的节目复制后同样只有工程）。
///
/// # Errors
///
/// - 路径不在录制目录内或条目不存在，见 [`resolve_entry`]。
/// - 复制失败返回 [`LibraryError::Io`]；已复制的文件会被清理。
pub fn duplicate_recording(dir: &Path, path: &Path, new_name: &str) -> Result<PathBuf, LibraryError> {
    let src = resolve_entry(dir, path)?;
    let name = new_name.trim();
    let dst = unique_entry_path(dir, if name.is_empty() { "copy" } else { name });

    let pairs = [
        (src.clone(), dst.clone()),
        (show_project_path(&src), show_project_path(&dst)),
        (overview_cache_path(&src), overview_cache_path(&dst)),
    ];
    let mut copied: Vec<&Path> = Vec::new();
    for (from, to) in &pairs {
        if !from.is_file() {
            continue;
        }
        if let Err(e) = copy_atomic(from, to) {
            for p in copied {
                let _ = std::fs::remove_file(p);
            }
            return Err(e.into());
        }
        copied.push(to);
    }

    let finish = || -> Result<(), LibraryError> {
        patch_show_string(&dst, "name", name)?;
        let mut meta = read_sidecar(&src).unwrap_or_default();
        meta.version = SIDECAR_VERSION;
        name.clone_into(&mut meta.name);
        meta.created_unix_ms = now_ms();
        meta.recovered = false;
        write_sidecar(&dst, &meta)?;
        Ok(())
    };
    if let Err(e) = finish() {
        for p in copied {
            let _ = std::fs::remove_file(p);
        }
        let _ = std::fs::remove_file(crate::sidecar::sidecar_path(&dst));
        return Err(e);
    }
    Ok(dst)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use artrec_core::{ArtRecWriter, CompressAlgo, UniDesc};

    use super::*;
    use crate::library::list_library_uncached;
    use crate::show_store::{save_show, SaveRequest};
    use crate::sidecar::{write_overview_cache, Sidecar};
    use crate::testutil::TempDir;

    fn make_artrec(dir: &Path, stem: &str, frames: u64) -> PathBuf {
        let unis = vec![UniDesc::from_universe(1, 512).unwrap()];
        let mut w =
            ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 3, 0, 0).unwrap();
        for i in 0..frames {
            w.add_full_frame(i * 1000, &[vec![i as u8; 512]]).unwrap();
        }
        let p = dir.join(format!("{stem}.artrec"));
        std::fs::write(&p, w.finish(frames * 1000).unwrap().into_inner()).unwrap();
        p
    }

    #[test]
    fn 新节目路径避开已有的节目与只有工程的条目() {
        let dir = TempDir::new("mg-unique");
        make_artrec(dir.path(), "秀", 1);
        std::fs::write(dir.path().join("秀-2.artrec.show"), "{}").unwrap();
        assert_eq!(unique_entry_path(dir.path(), "新的").file_name().unwrap(), "新的.artrec");
        assert_eq!(unique_entry_path(dir.path(), "秀").file_name().unwrap(), "秀-3.artrec");
        assert_eq!(unique_entry_path(dir.path(), "a/b").file_name().unwrap(), "a_b.artrec");
    }

    #[test]
    fn 录制节目改备注只写_sidecar_其余字段不变() {
        let dir = TempDir::new("mg-notes");
        let p = make_artrec(dir.path(), "a", 2);
        write_sidecar(&p, &Sidecar { name: "开场".into(), notes: "旧".into(), ..Sidecar::default() }).unwrap();
        set_notes(dir.path(), &p, "新备注\n第二行").unwrap();
        let meta = read_sidecar(&p).unwrap();
        assert_eq!((meta.name.as_str(), meta.notes.as_str()), ("开场", "新备注\n第二行"));
        assert!(!show_project_path(&p).exists(), "录制节目不会凭空生成工程文件");
    }

    #[test]
    fn 编辑器节目改备注同步改写工程且保留其余字段() {
        let dir = TempDir::new("mg-notes-show");
        let json = r#"{"version":1,"name":"秀","notes":"旧","cues":[1,2]}"#;
        let p = save_show(dir.path(), SaveRequest { path: None, name: "秀", notes: "旧", file_stem: "秀", json }).unwrap();
        set_notes(dir.path(), &p, "新").unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(show_project_path(&p)).unwrap()).unwrap();
        assert_eq!(v["notes"], "新");
        assert_eq!(v["name"], "秀");
        assert_eq!(v["cues"], serde_json::json!([1, 2]));
        assert_eq!(read_sidecar(&p).unwrap().notes, "新");
    }

    #[test]
    fn 改备注拒绝库外路径与不存在的节目() {
        let dir = TempDir::new("mg-notes-bad");
        let other = TempDir::new("mg-notes-other");
        let outside = make_artrec(other.path(), "x", 1);
        assert!(matches!(set_notes(dir.path(), &outside, "n"), Err(LibraryError::OutsideLibrary)));
        let missing = dir.path().join("无.artrec");
        assert!(matches!(set_notes(dir.path(), &missing, "n"), Err(LibraryError::NotFound)));
    }

    #[test]
    fn 复制录制节目_文件与元数据齐全且自动避开重名() {
        let dir = TempDir::new("mg-dup");
        let p = make_artrec(dir.path(), "开场", 3);
        write_sidecar(&p, &Sidecar { name: "开场".into(), notes: "备注".into(), created_unix_ms: 1, ..Sidecar::default() }).unwrap();
        write_overview_cache(&p, b"ovw").unwrap();
        make_artrec(dir.path(), "开场 副本", 1);

        let copy = duplicate_recording(dir.path(), &p, "开场 副本").unwrap();
        assert_eq!(copy.file_name().unwrap(), "开场 副本-2.artrec");
        assert_eq!(std::fs::read(&copy).unwrap(), std::fs::read(&p).unwrap());
        assert_eq!(std::fs::read(overview_cache_path(&copy)).unwrap(), b"ovw");
        let meta = read_sidecar(&copy).unwrap();
        assert_eq!((meta.name.as_str(), meta.notes.as_str()), ("开场 副本", "备注"));
        assert!(meta.created_unix_ms > 1);
        let tmp_left = std::fs::read_dir(dir.path()).unwrap().any(|e| {
            e.unwrap().file_name().to_string_lossy().ends_with(".tmp")
        });
        assert!(!tmp_left, "不留临时文件");
        assert_eq!(list_library_uncached(dir.path()).len(), 3);
    }

    #[test]
    fn 复制编辑器节目后仍可编辑_工程里的名称改为新名称() {
        let dir = TempDir::new("mg-dup-show");
        let json = r#"{"version":1,"name":"秀","notes":""}"#;
        let p = save_show(dir.path(), SaveRequest { path: None, name: "秀", notes: "", file_stem: "秀", json }).unwrap();
        // 只有工程（还没导出）的节目也能复制
        let copy = duplicate_recording(dir.path(), &p, "秀 副本").unwrap();
        assert!(!copy.exists());
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(show_project_path(&copy)).unwrap()).unwrap();
        assert_eq!(v["name"], "秀 副本");
        let list = list_library_uncached(dir.path());
        let entry = list.iter().find(|e| e.name == "秀 副本").unwrap();
        assert!(entry.editable);
    }
}
