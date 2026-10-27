//! 节目编辑器工程在节目库里的保存与读取。
//!
//! 一个编辑器节目在录制目录里由一组文件构成：`名称.artrec.show`（工程，JSON）、
//! `名称.artrec.json`（sidecar，`source` 为 `editor`），以及烘焙得到的 `名称.artrec`。
//! 本模块只负责工程文件与 sidecar；工程内容对这里是不透明的 JSON，结构校验在前端。
//!
//! 写入采用"临时文件 + 重命名"，覆盖前把旧工程留一份 `.show.bak`，写失败时原文件保持原样。

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::library::{resolve_entry, LibraryError};
use crate::sidecar::{
    read_sidecar, show_project_path, write_sidecar, SIDECAR_VERSION, SOURCE_EDITOR,
};
use crate::store::{sanitize_file_stem, unique_stem, ARTREC_SUFFIX};

/// 工程文件大小上限（字节）。超出视为异常数据，既不写入也不读取。
pub const MAX_PROJECT_BYTES: u64 = 64 * 1024 * 1024;

/// 工程文件相对 `.artrec.show` 追加的备份后缀。
const BACKUP_SUFFIX: &str = ".bak";

/// 保存 / 读取工程的错误。
#[derive(Debug, thiserror::Error)]
pub enum ShowError {
    /// 路径校验或文件系统错误（见 [`LibraryError`]）。
    #[error(transparent)]
    Library(#[from] LibraryError),
    /// 工程内容超过 [`MAX_PROJECT_BYTES`]。
    #[error("工程文件过大")]
    TooLarge,
    /// 工程内容不是合法的 JSON。
    #[error("工程内容不是合法的 JSON")]
    InvalidJson,
    /// 库外工程文件的路径不合格：扩展名不是 `.artshow`、是目录，或所在目录不存在。
    #[error("工程文件路径不合法")]
    BadPath,
}

impl From<io::Error> for ShowError {
    fn from(e: io::Error) -> Self {
        Self::Library(LibraryError::Io(e))
    }
}

/// 一次保存请求。
#[derive(Debug, Clone, Copy)]
pub struct SaveRequest<'a> {
    /// 已有节目的 `.artrec` 路径（覆盖保存）；`None` 表示新建。
    pub path: Option<&'a Path>,
    /// 节目显示名（写入 sidecar）。
    pub name: &'a str,
    /// 备注（写入 sidecar）。
    pub notes: &'a str,
    /// 新建时文件名的主干（会规整非法字符，重名时追加 `-2`、`-3`…）；覆盖保存时忽略。
    pub file_stem: &'a str,
    /// 工程 JSON 文本。
    pub json: &'a str,
}

/// 当前时间（Unix 毫秒）。
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// 在路径末尾追加后缀。
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// 原子写入工程文件：存在旧文件时先留一份备份，再写临时文件并重命名覆盖。
///
/// # Arguments
///
/// * `target` - 工程文件路径。
/// * `bytes` - 内容。
///
/// # Errors
///
/// 写临时文件或重命名失败；此时目标文件保持原样（备份失败不算错误）。
fn write_project_file(target: &Path, bytes: &[u8]) -> io::Result<()> {
    if target.is_file() {
        let _ = std::fs::copy(target, with_suffix(target, BACKUP_SUFFIX));
    }
    let tmp = with_suffix(target, ".tmp");
    let result = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, target));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 改写工程文件里一个顶层字符串字段（如 `name`、`notes`），其余内容原样保留。
///
/// 节目库在编辑器之外改名 / 改备注 / 复制时调用：工程 JSON 里也存着名称与备注，
/// 下次在编辑器里保存会以工程里的值为准，只改 sidecar 会被覆盖回去。
///
/// # Arguments
///
/// * `artrec` - 节目的 `.artrec` 路径（处理其 `.artrec.show`）。
/// * `key` - 顶层字段名。
/// * `value` - 新值。
///
/// # Returns
///
/// 确实改写了工程文件返回 `true`；工程文件不存在、内容不是 JSON 对象或超过
/// [`MAX_PROJECT_BYTES`]（不贸然覆盖）时返回 `false`。
///
/// # Errors
///
/// 读取（不存在除外）或写回失败返回 [`io::Error`]，此时工程文件保持原样。
pub(crate) fn patch_show_string(artrec: &Path, key: &str, value: &str) -> io::Result<bool> {
    let file = show_project_path(artrec);
    let text = match std::fs::metadata(&file) {
        Ok(m) if m.len() > MAX_PROJECT_BYTES => return Ok(false),
        Ok(_) => std::fs::read_to_string(&file)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let Ok(serde_json::Value::Object(mut obj)) = serde_json::from_str::<serde_json::Value>(&text)
    else {
        return Ok(false);
    };
    if obj.get(key).and_then(serde_json::Value::as_str) == Some(value) {
        return Ok(false);
    }
    obj.insert(key.to_owned(), serde_json::Value::String(value.to_owned()));
    let out = serde_json::to_string(&serde_json::Value::Object(obj))
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_project_file(&file, out.as_bytes())?;
    Ok(true)
}

/// 把工程保存进节目库。
///
/// 新建时在目录里选一个不与现有 `.artrec` / `.artrec.show` 冲突的文件名；覆盖保存时沿用原路径。
/// 同时写入（或更新）sidecar：显示名、备注，并把 `source` 标为 `editor`。
///
/// # Arguments
///
/// * `dir` - 录制目录（不存在时创建）。
/// * `req` - 保存请求。
///
/// # Returns
///
/// 该节目的 `.artrec` 路径（文件不一定存在：烘焙之前只有工程）。
///
/// # Errors
///
/// - [`ShowError::TooLarge`] / [`ShowError::InvalidJson`]：工程内容不合格，不会写入任何文件。
/// - [`ShowError::Library`]：覆盖保存时路径不在节目库内或条目不存在，或文件系统失败。
pub fn save_show(dir: &Path, req: SaveRequest<'_>) -> Result<PathBuf, ShowError> {
    if req.json.len() as u64 > MAX_PROJECT_BYTES {
        return Err(ShowError::TooLarge);
    }
    serde_json::from_str::<serde_json::Value>(req.json).map_err(|_| ShowError::InvalidJson)?;

    let artrec = if let Some(path) = req.path {
        resolve_entry(dir, path)?
    } else {
        std::fs::create_dir_all(dir)?;
        let base = if req.file_stem.trim().is_empty() {
            req.name
        } else {
            req.file_stem
        };
        let stem = unique_stem(
            dir,
            &sanitize_file_stem(base),
            &[ARTREC_SUFFIX, ".artrec.show"],
        );
        dir.join(format!("{stem}{ARTREC_SUFFIX}"))
    };

    write_project_file(&show_project_path(&artrec), req.json.as_bytes())?;

    let mut meta = read_sidecar(&artrec).unwrap_or_default();
    meta.version = SIDECAR_VERSION;
    req.name.trim().clone_into(&mut meta.name);
    req.notes.clone_into(&mut meta.notes);
    SOURCE_EDITOR.clone_into(&mut meta.source);
    if meta.created_unix_ms == 0 {
        meta.created_unix_ms = now_ms();
    }
    write_sidecar(&artrec, &meta)?;
    Ok(artrec)
}

/// 读取节目库里某个节目的工程文本。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `path` - 节目的 `.artrec` 路径（文件可以不存在）。
///
/// # Returns
///
/// 工程文件的 JSON 文本。
///
/// # Errors
///
/// - [`ShowError::Library`]：路径不在节目库内，或该节目没有工程文件（录制得到的节目）。
/// - [`ShowError::TooLarge`]：工程文件超过 [`MAX_PROJECT_BYTES`]。
pub fn read_show(dir: &Path, path: &Path) -> Result<String, ShowError> {
    let artrec = resolve_entry(dir, path)?;
    let file = show_project_path(&artrec);
    let meta = std::fs::metadata(&file).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            ShowError::Library(LibraryError::NotFound)
        } else {
            ShowError::from(e)
        }
    })?;
    if meta.len() > MAX_PROJECT_BYTES {
        return Err(ShowError::TooLarge);
    }
    Ok(std::fs::read_to_string(file)?)
}

/// 库外工程文件（导出的副本、自动存档）的扩展名。
pub const EXTERNAL_EXTENSION: &str = "artshow";

/// 检查库外工程路径：扩展名必须是 `.artshow`。
///
/// # Arguments
///
/// * `path` - 用户在对话框里选择的路径，或自动存档路径。
///
/// # Errors
///
/// 扩展名不对，或路径是已存在的目录时返回 [`ShowError::BadPath`]。
fn check_external(path: &Path) -> Result<(), ShowError> {
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTERNAL_EXTENSION));
    if !ext_ok || path.is_dir() {
        return Err(ShowError::BadPath);
    }
    Ok(())
}

/// 把工程写到库外的 `.artshow` 文件（另存为、导出副本、自动存档）。
///
/// 不放宽节目库的路径校验：这里只接受 `.artshow` 扩展名，原子写入并保留 `.bak` 备份。
///
/// # Arguments
///
/// * `path` - 目标文件路径（所在目录必须已存在）。
/// * `json` - 工程 JSON 文本。
///
/// # Errors
///
/// - [`ShowError::BadPath`]：扩展名不对、目标是目录，或所在目录不存在。
/// - [`ShowError::TooLarge`] / [`ShowError::InvalidJson`]：内容不合格，不写入。
/// - [`ShowError::Library`]：文件系统失败。
pub fn write_external(path: &Path, json: &str) -> Result<(), ShowError> {
    check_external(path)?;
    if json.len() as u64 > MAX_PROJECT_BYTES {
        return Err(ShowError::TooLarge);
    }
    serde_json::from_str::<serde_json::Value>(json).map_err(|_| ShowError::InvalidJson)?;
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err(ShowError::BadPath);
    }
    write_project_file(path, json.as_bytes())?;
    Ok(())
}

/// 读取库外的 `.artshow` 文件。
///
/// # Arguments
///
/// * `path` - 文件路径。
///
/// # Returns
///
/// 工程 JSON 文本。
///
/// # Errors
///
/// - [`ShowError::BadPath`]：扩展名不对，或不是文件。
/// - [`ShowError::TooLarge`]：超过 [`MAX_PROJECT_BYTES`]。
/// - [`ShowError::Library`]：文件不存在或读取失败。
pub fn read_external(path: &Path) -> Result<String, ShowError> {
    check_external(path)?;
    let meta = std::fs::metadata(path).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            ShowError::Library(LibraryError::NotFound)
        } else {
            ShowError::from(e)
        }
    })?;
    if !meta.is_file() {
        return Err(ShowError::BadPath);
    }
    if meta.len() > MAX_PROJECT_BYTES {
        return Err(ShowError::TooLarge);
    }
    Ok(std::fs::read_to_string(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{
        delete_recording_with, list_library_uncached, rename_recording, LibraryCache,
    };
    use crate::sidecar::{overview_cache_path, sidecar_path, write_overview_cache};
    use crate::testutil::TempDir;

    const JSON: &str = r#"{"version":1,"name":"演出"}"#;

    fn req<'a>(path: Option<&'a Path>, name: &'a str, stem: &'a str, json: &'a str) -> SaveRequest<'a> {
        SaveRequest { path, name, notes: "备注", file_stem: stem, json }
    }

    #[test]
    fn 首次保存创建工程与sidecar_此时节目还没有artrec() {
        let dir = TempDir::new("show-new");
        let artrec = save_show(dir.path(), req(None, "开场秀", "开场秀", JSON)).unwrap();
        assert_eq!(artrec.file_name().unwrap(), "开场秀.artrec");
        assert!(!artrec.exists(), "烘焙之前不存在 .artrec");
        assert_eq!(std::fs::read_to_string(show_project_path(&artrec)).unwrap(), JSON);
        let meta = read_sidecar(&artrec).unwrap();
        assert_eq!((meta.name.as_str(), meta.notes.as_str(), meta.source.as_str()), ("开场秀", "备注", "editor"));
        assert!(meta.created_unix_ms > 0);
    }

    #[test]
    fn 重名时自动追加序号_且不覆盖已有文件() {
        let dir = TempDir::new("show-dup");
        let a = save_show(dir.path(), req(None, "秀", "秀", JSON)).unwrap();
        let b = save_show(dir.path(), req(None, "秀", "秀", JSON)).unwrap();
        // 已有的同名 .artrec（例如录制得到的节目）同样占用名字
        std::fs::write(dir.path().join("秀-3.artrec"), b"x").unwrap();
        let c = save_show(dir.path(), req(None, "秀", "秀", JSON)).unwrap();
        assert_eq!(a.file_name().unwrap(), "秀.artrec");
        assert_eq!(b.file_name().unwrap(), "秀-2.artrec");
        assert_eq!(c.file_name().unwrap(), "秀-4.artrec");
    }

    #[test]
    fn 文件名主干为空时用显示名_非法字符被规整() {
        let dir = TempDir::new("show-stem");
        let a = save_show(dir.path(), req(None, "a/b:c", "", JSON)).unwrap();
        assert_eq!(a.file_name().unwrap(), "a_b_c.artrec");
        assert_eq!(read_sidecar(&a).unwrap().name, "a/b:c");
    }

    #[test]
    fn 覆盖保存保留备份_更新sidecar_沿用创建时间() {
        let dir = TempDir::new("show-over");
        let a = save_show(dir.path(), req(None, "秀", "秀", JSON)).unwrap();
        let created = read_sidecar(&a).unwrap().created_unix_ms;
        let v2 = r#"{"version":1,"name":"第二版"}"#;
        let again = save_show(dir.path(), SaveRequest { path: Some(&a), name: "新名字", notes: "新备注", file_stem: "忽略", json: v2 }).unwrap();
        assert_eq!(std::fs::canonicalize(&a).unwrap_or(a.clone()).file_name(), again.file_name());
        assert_eq!(std::fs::read_to_string(show_project_path(&a)).unwrap(), v2);
        assert_eq!(std::fs::read_to_string(with_suffix(&show_project_path(&a), ".bak")).unwrap(), JSON);
        let meta = read_sidecar(&a).unwrap();
        assert_eq!((meta.name.as_str(), meta.notes.as_str()), ("新名字", "新备注"));
        assert_eq!(meta.created_unix_ms, created);
        assert!(!with_suffix(&show_project_path(&a), ".tmp").exists(), "不留临时文件");
    }

    #[test]
    fn 非法内容不会写入任何文件() {
        let dir = TempDir::new("show-bad");
        assert!(matches!(
            save_show(dir.path(), req(None, "秀", "秀", "{坏的")),
            Err(ShowError::InvalidJson)
        ));
        let huge = format!("\"{}\"", "x".repeat(MAX_PROJECT_BYTES as usize));
        assert!(matches!(
            save_show(dir.path(), req(None, "秀", "秀", &huge)),
            Err(ShowError::TooLarge)
        ));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn 覆盖保存拒绝库外路径与不存在的条目() {
        let dir = TempDir::new("show-safe");
        let other = TempDir::new("show-other");
        let outside = other.path().join("x.artrec");
        std::fs::write(&outside, b"x").unwrap();
        assert!(matches!(
            save_show(dir.path(), req(Some(&outside), "x", "x", JSON)),
            Err(ShowError::Library(LibraryError::OutsideLibrary))
        ));
        assert!(matches!(
            save_show(dir.path(), req(Some(&dir.path().join("ghost.artrec")), "x", "x", JSON)),
            Err(ShowError::Library(LibraryError::NotFound))
        ));
        let wrong_ext = dir.path().join("a.txt");
        assert!(matches!(
            save_show(dir.path(), req(Some(&wrong_ext), "x", "x", JSON)),
            Err(ShowError::Library(LibraryError::OutsideLibrary))
        ));
    }

    #[test]
    fn 读取工程_录制得到的节目没有工程() {
        let dir = TempDir::new("show-read");
        let a = save_show(dir.path(), req(None, "秀", "秀", JSON)).unwrap();
        assert_eq!(read_show(dir.path(), &a).unwrap(), JSON);
        let recorded = dir.path().join("rec.artrec");
        std::fs::write(&recorded, b"x").unwrap();
        assert!(matches!(
            read_show(dir.path(), &recorded),
            Err(ShowError::Library(LibraryError::NotFound))
        ));
        let other = TempDir::new("show-read-other");
        let outside = other.path().join("o.artrec");
        std::fs::write(&outside, b"x").unwrap();
        assert!(matches!(
            read_show(dir.path(), &outside),
            Err(ShowError::Library(LibraryError::OutsideLibrary))
        ));
    }

    #[test]
    fn 节目库列出只有工程的条目_可编辑但不可播放() {
        let dir = TempDir::new("show-list");
        let a = save_show(dir.path(), req(None, "未导出", "未导出", JSON)).unwrap();
        let list = list_library_uncached(dir.path());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].file_name, "未导出.artrec");
        assert_eq!(list[0].name, "未导出");
        assert!(list[0].editable && !list[0].exported && !list[0].valid);
        assert_eq!(list[0].path, a.to_string_lossy());
        assert_eq!(list[0].frames, 0);
        // 缓存版结果一致
        assert_eq!(LibraryCache::new().list(dir.path()), list);
    }

    #[test]
    fn 导出后同一条目变为已导出_并随工程可编辑() {
        let dir = TempDir::new("show-exported");
        let a = save_show(dir.path(), req(None, "秀", "秀", JSON)).unwrap();
        // 模拟烘焙：写出合法 .artrec
        let unis = vec![artrec_core::UniDesc::from_universe(0, 512).unwrap()];
        let mut w = artrec_core::ArtRecWriter::new(std::io::Cursor::new(Vec::new()), unis, artrec_core::CompressAlgo::Zstd, 3, 0, 0).unwrap();
        w.add_full_frame(0, &[vec![1u8; 512]]).unwrap();
        std::fs::write(&a, w.finish(1000).unwrap().into_inner()).unwrap();
        let list = list_library_uncached(dir.path());
        assert_eq!(list.len(), 1, "同一个节目只有一个条目");
        assert!(list[0].editable && list[0].exported && list[0].valid);
        assert_eq!(list[0].frames, 1);
    }

    #[test]
    fn 缓存感知工程文件的出现与消失() {
        let dir = TempDir::new("show-cache");
        let a = save_show(dir.path(), req(None, "秀", "秀", JSON)).unwrap();
        for p in [show_project_path(&a), sidecar_path(&a)] {
            let t = SystemTime::now() - std::time::Duration::from_secs(3600);
            std::fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
        }
        let cache = LibraryCache::new();
        assert!(cache.list(dir.path())[0].editable);
        assert_eq!(cache.cached_count(), 1);
        std::fs::remove_file(show_project_path(&a)).unwrap();
        assert!(cache.list(dir.path()).is_empty(), "工程与 .artrec 都不在了，条目消失");
    }

    #[test]
    fn 重命名把工程_sidecar_概览一起改名_孤立工程也可以() {
        let dir = TempDir::new("show-rename");
        let a = save_show(dir.path(), req(None, "旧", "旧", JSON)).unwrap();
        write_overview_cache(&a, b"ovw").unwrap();
        let b = rename_recording(dir.path(), &a, "新名").unwrap();
        assert_eq!(b.file_name().unwrap(), "新名.artrec");
        assert!(!show_project_path(&a).exists() && show_project_path(&b).exists());
        assert!(!sidecar_path(&a).exists() && sidecar_path(&b).exists());
        assert!(!overview_cache_path(&a).exists());
        let meta = read_sidecar(&b).unwrap();
        assert_eq!((meta.name.as_str(), meta.source.as_str()), ("新名", "editor"));
        assert_eq!(read_show(dir.path(), &b).unwrap(), JSON);
    }

    #[test]
    fn 重命名拒绝覆盖已有工程() {
        let dir = TempDir::new("show-rename-dup");
        let a = save_show(dir.path(), req(None, "甲", "甲", JSON)).unwrap();
        let _b = save_show(dir.path(), req(None, "乙", "乙", JSON)).unwrap();
        assert!(matches!(
            rename_recording(dir.path(), &a, "乙"),
            Err(LibraryError::AlreadyExists)
        ));
        assert!(show_project_path(&a).exists());
    }

    #[test]
    fn 重命名已导出的节目时工程跟着改名() {
        let dir = TempDir::new("show-rename-exported");
        let a = save_show(dir.path(), req(None, "旧", "旧", JSON)).unwrap();
        std::fs::write(&a, b"stub").unwrap();
        let b = rename_recording(dir.path(), &a, "新").unwrap();
        assert!(b.exists() && show_project_path(&b).exists());
        assert!(!a.exists() && !show_project_path(&a).exists());
    }

    #[test]
    fn 删除把工程也交给回收站() {
        use std::cell::RefCell;
        let dir = TempDir::new("show-del");
        let a = save_show(dir.path(), req(None, "秀", "秀", JSON)).unwrap();
        let calls: RefCell<Vec<Vec<PathBuf>>> = RefCell::new(Vec::new());
        delete_recording_with(dir.path(), &a, &|items: &[PathBuf]| {
            calls.borrow_mut().push(items.to_vec());
            Ok(())
        })
        .unwrap();
        let calls = calls.into_inner();
        assert_eq!(calls.len(), 1, "一次操作");
        let names: Vec<String> = calls[0].iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["秀.artrec.json", "秀.artrec.show"], "未导出时没有 .artrec，其余文件一起移走");
    }

    #[test]
    fn 库外读写只接受artshow扩展名_且写入是原子的() {
        let dir = TempDir::new("show-ext");
        let file = dir.path().join("备份.artshow");
        write_external(&file, JSON).unwrap();
        assert_eq!(read_external(&file).unwrap(), JSON);
        write_external(&file, r#"{"version":1,"name":"v2"}"#).unwrap();
        assert_eq!(std::fs::read_to_string(with_suffix(&file, ".bak")).unwrap(), JSON);
        assert!(!with_suffix(&file, ".tmp").exists());
        // 扩展名大小写不敏感
        write_external(&dir.path().join("大写.ARTSHOW"), JSON).unwrap();
    }

    #[test]
    fn 库外路径不合格被拒绝() {
        let dir = TempDir::new("show-ext-bad");
        for bad in ["a.txt", "a.artrec", "a", "a.artshow.exe"] {
            assert!(matches!(write_external(&dir.path().join(bad), JSON), Err(ShowError::BadPath)), "{bad}");
            std::fs::write(dir.path().join(bad), JSON).unwrap();
            assert!(matches!(read_external(&dir.path().join(bad)), Err(ShowError::BadPath)), "{bad}");
        }
        // 目录冒充 .artshow
        let as_dir = dir.path().join("dir.artshow");
        std::fs::create_dir(&as_dir).unwrap();
        assert!(matches!(write_external(&as_dir, JSON), Err(ShowError::BadPath)));
        assert!(matches!(read_external(&as_dir), Err(ShowError::BadPath)));
        // 所在目录不存在：不会替用户建目录
        assert!(matches!(
            write_external(&dir.path().join("不存在的目录").join("a.artshow"), JSON),
            Err(ShowError::BadPath)
        ));
        assert!(matches!(
            read_external(&dir.path().join("ghost.artshow")),
            Err(ShowError::Library(LibraryError::NotFound))
        ));
    }

    #[test]
    fn 库外写入同样校验内容() {
        let dir = TempDir::new("show-ext-content");
        let file = dir.path().join("a.artshow");
        assert!(matches!(write_external(&file, "不是json"), Err(ShowError::InvalidJson)));
        assert!(!file.exists());
    }
}
