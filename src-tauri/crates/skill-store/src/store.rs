//! 用户技能库：`<root>/<name>/SKILL.md`（Agent Skills 格式）加可选的参考文件。
//!
//! 导入（zip、文件夹或单个 `SKILL.md`）先全部读进内存校验——总大小不超过 2 MiB、最多 100 个文件、
//! 没有符号链接、没有越界路径（zip-slip）、`SKILL.md` 前言合规——再写到临时目录、整体改名到位，
//! 失败时不留半成品。`scripts/` 下的文件只保存，应用不会执行它们。

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::SkillError;
use crate::frontmatter::{self, valid_name};
use crate::trash::{Trash, TrashEntry};

/// 一个技能包的总大小上限（字节）。
pub const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024;
/// 一个技能包的文件数上限。
pub const MAX_FILES: usize = 100;
/// 回收站里技能条目的种类。
pub const TRASH_KIND: &str = "skill";

/// 列表里的一个技能。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// 技能名（目录名）。
    pub name: String,
    /// 描述。
    pub description: String,
    /// 显示标题（`metadata.title`）。
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub title: Option<String>,
    /// 触发词（`metadata.triggers`，逗号分隔）。
    pub triggers: Vec<String>,
    /// 文件数。
    pub files: u32,
    /// 总大小（字节）。
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub bytes: u64,
    /// 带 `scripts/`（不会执行，界面里提示）。
    pub has_scripts: bool,
}

/// 内存里的技能包：相对路径 → 内容。
type Package = Vec<(PathBuf, Vec<u8>)>;

/// 用户技能库。
pub struct SkillStore {
    root: PathBuf,
    trash: Trash,
}

/// 只由普通路径段组成的相对路径（拒绝 `..`、根、盘符）。
fn safe_relative(p: &Path) -> Result<PathBuf, SkillError> {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return Err(SkillError::UnsafePath),
        }
    }
    if out.as_os_str().is_empty() { Err(SkillError::UnsafePath) } else { Ok(out) }
}

/// 打包时忽略的系统杂项。
fn is_junk(p: &Path) -> bool {
    p.components().any(|c| matches!(c, Component::Normal(s) if s == "__MACOSX" || s == ".DS_Store" || s == "Thumbs.db"))
}

/// 去掉公共的顶层目录（zip 常见 `name/SKILL.md` 的结构）。
fn strip_top(pkg: Package) -> Result<Package, SkillError> {
    if pkg.iter().any(|(p, _)| p == Path::new("SKILL.md")) {
        return Ok(pkg);
    }
    let tops: BTreeSet<_> = pkg.iter().filter_map(|(p, _)| p.components().next().map(|c| c.as_os_str().to_owned())).collect();
    if tops.len() == 1 {
        let top = PathBuf::from(tops.into_iter().next().unwrap_or_default());
        if pkg.iter().any(|(p, _)| *p == top.join("SKILL.md")) {
            return Ok(pkg
                .into_iter()
                .filter_map(|(p, b)| p.strip_prefix(&top).ok().map(|r| (r.to_path_buf(), b)))
                .filter(|(p, _)| !p.as_os_str().is_empty())
                .collect());
        }
    }
    Err(SkillError::Invalid("the package has no SKILL.md at its top level".into()))
}

/// 按大小 / 文件数上限累加。
fn account(files: &mut usize, bytes: &mut u64, size: u64) -> Result<(), SkillError> {
    *files += 1;
    *bytes += size;
    if *files > MAX_FILES || *bytes > MAX_PACKAGE_BYTES { Err(SkillError::TooLarge) } else { Ok(()) }
}

/// 读一个 zip 技能包。
fn read_zip(path: &Path) -> Result<Package, SkillError> {
    let file = std::fs::File::open(path)?;
    let mut zip = zip::ZipArchive::new(file)?;
    let (mut files, mut bytes) = (0usize, 0u64);
    let mut out = Package::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        if entry.is_symlink() {
            return Err(SkillError::Symlink);
        }
        let rel = entry.enclosed_name().ok_or(SkillError::UnsafePath)?;
        let rel = safe_relative(&rel)?;
        if is_junk(&rel) {
            continue;
        }
        account(&mut files, &mut bytes, entry.size())?;
        // 不信任声明的大小：最多读到上限加 1 个字节
        let mut buf = Vec::new();
        (&mut entry).take(MAX_PACKAGE_BYTES + 1).read_to_end(&mut buf)?;
        if buf.len() as u64 > entry.size() || bytes > MAX_PACKAGE_BYTES {
            return Err(SkillError::TooLarge);
        }
        out.push((rel, buf));
    }
    Ok(out)
}

/// 读一个文件夹技能包（不跟随符号链接）。
fn read_dir(root: &Path) -> Result<Package, SkillError> {
    let (mut files, mut bytes) = (0usize, 0u64);
    let mut out = Package::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let meta = std::fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                return Err(SkillError::Symlink);
            }
            let rel = safe_relative(entry.path().strip_prefix(root).map_err(|_| SkillError::UnsafePath)?)?;
            if is_junk(&rel) {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                account(&mut files, &mut bytes, meta.len())?;
                out.push((rel, std::fs::read(entry.path())?));
            }
        }
    }
    Ok(out)
}

/// 技能包的统计信息与前言。
fn info_of(pkg: &[(PathBuf, Vec<u8>)]) -> Result<SkillInfo, SkillError> {
    let skill = pkg
        .iter()
        .find(|(p, _)| p == Path::new("SKILL.md"))
        .ok_or_else(|| SkillError::Invalid("missing SKILL.md".into()))?;
    let text = std::str::from_utf8(&skill.1).map_err(|_| SkillError::Invalid("SKILL.md is not UTF-8".into()))?;
    let (fm, _) = frontmatter::parse(text)?;
    Ok(SkillInfo {
        triggers: fm
            .metadata
            .get("triggers")
            .map(|t| t.split([',', '，']).map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).take(20).collect())
            .unwrap_or_default(),
        title: fm.metadata.get("title").cloned().filter(|s| !s.is_empty()),
        name: fm.name,
        description: fm.description,
        files: pkg.len() as u32,
        bytes: pkg.iter().map(|(_, b)| b.len() as u64).sum(),
        has_scripts: pkg.iter().any(|(p, _)| p.starts_with("scripts")),
    })
}

impl SkillStore {
    /// 打开技能库。
    ///
    /// # Arguments
    ///
    /// * `root` - 技能目录（`data/skills`）。
    /// * `trash` - 回收站。
    ///
    /// # Returns
    ///
    /// 技能库。
    pub fn new(root: PathBuf, trash: Trash) -> Self {
        Self { root, trash }
    }

    /// 回收站。
    ///
    /// # Returns
    ///
    /// 与技能库共用的回收站。
    pub fn trash(&self) -> &Trash {
        &self.trash
    }

    /// 技能目录（校验名称）。
    ///
    /// # Arguments
    ///
    /// * `name` - 技能名。
    ///
    /// # Returns
    ///
    /// 目录路径。
    ///
    /// # Errors
    ///
    /// 名称不合规或技能不存在时返回 [`SkillError::NotFound`]。
    pub fn dir_of(&self, name: &str) -> Result<PathBuf, SkillError> {
        if !valid_name(name) {
            return Err(SkillError::NotFound);
        }
        let dir = self.root.join(name);
        if dir.join("SKILL.md").is_file() { Ok(dir) } else { Err(SkillError::NotFound) }
    }

    /// 列出技能（按名称排序；格式不对的跳过并记日志）。
    ///
    /// # Returns
    ///
    /// 技能。
    pub fn list(&self) -> Vec<SkillInfo> {
        let Ok(read) = std::fs::read_dir(&self.root) else { return Vec::new() };
        let mut out: Vec<SkillInfo> = read
            .flatten()
            .filter(|e| e.file_name().to_str().is_some_and(valid_name))
            .filter_map(|e| match read_dir(&e.path()).and_then(|p| info_of(&p)) {
                Ok(info) if e.file_name().to_str() == Some(info.name.as_str()) => Some(info),
                Ok(_) => None,
                Err(err) => {
                    tracing::warn!(dir = %e.path().display(), error = %err, "跳过格式不对的技能");
                    None
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// 读取技能的 `SKILL.md`。
    ///
    /// # Arguments
    ///
    /// * `name` - 技能名。
    ///
    /// # Returns
    ///
    /// 全文。
    ///
    /// # Errors
    ///
    /// 不存在时返回 [`SkillError::NotFound`]；读取失败或不是 UTF-8 时返回 [`SkillError::Io`] / [`SkillError::Invalid`]。
    pub fn read(&self, name: &str) -> Result<String, SkillError> {
        let bytes = std::fs::read(self.dir_of(name)?.join("SKILL.md"))?;
        String::from_utf8(bytes).map_err(|_| SkillError::Invalid("SKILL.md is not UTF-8".into()))
    }

    /// 导入技能包。
    ///
    /// # Arguments
    ///
    /// * `src` - `.zip` 文件、技能文件夹或单个 `SKILL.md`。
    /// * `replace` - 同名技能已存在时替换（旧的进回收站）。
    /// * `now_ms` - 当前时间（Unix 毫秒，替换时记进回收站）。
    ///
    /// # Returns
    ///
    /// 导入的技能。
    ///
    /// # Errors
    ///
    /// 包不合规（[`SkillError::Invalid`] / [`SkillError::TooLarge`] / [`SkillError::Symlink`] / [`SkillError::UnsafePath`]），
    /// 同名已存在且未要求替换（[`SkillError::Exists`]），或读写失败。
    pub fn import(&self, src: &Path, replace: bool, now_ms: u64) -> Result<SkillInfo, SkillError> {
        let meta = std::fs::symlink_metadata(src)?;
        if meta.file_type().is_symlink() {
            return Err(SkillError::Symlink);
        }
        let pkg = if meta.is_dir() {
            read_dir(src)?
        } else if src.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
            read_zip(src)?
        } else if src.file_name().is_some_and(|n| n.eq_ignore_ascii_case("SKILL.md")) {
            if meta.len() > MAX_PACKAGE_BYTES {
                return Err(SkillError::TooLarge);
            }
            vec![(PathBuf::from("SKILL.md"), std::fs::read(src)?)]
        } else {
            return Err(SkillError::Invalid("choose a .zip file, a folder or a SKILL.md file".into()));
        };
        let pkg = strip_top(pkg)?;
        let info = info_of(&pkg)?;
        let dest = self.root.join(&info.name);
        if dest.exists() && !replace {
            return Err(SkillError::Exists);
        }
        // 先写到临时目录，整体改名到位
        let staging = self.root.join(format!(".import-{now_ms}-{}", info.name));
        let _ = std::fs::remove_dir_all(&staging);
        let write = || -> Result<(), SkillError> {
            for (rel, bytes) in &pkg {
                let path = staging.join(rel);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(path, bytes)?;
            }
            if dest.exists() {
                self.trash.put_dir(TRASH_KIND, &info.name, &dest, now_ms)?;
            }
            std::fs::rename(&staging, &dest)?;
            Ok(())
        };
        if let Err(e) = write() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
        Ok(info)
    }

    /// 把技能导出成 zip（顶层目录为技能名）。
    ///
    /// # Arguments
    ///
    /// * `name` - 技能名。
    /// * `dest` - 目标 `.zip` 路径（已存在时覆盖）。
    ///
    /// # Errors
    ///
    /// 技能不存在或读写失败时返回错误。
    pub fn export(&self, name: &str, dest: &Path) -> Result<(), SkillError> {
        let dir = self.dir_of(name)?;
        let pkg = read_dir(&dir)?;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (rel, bytes) in &pkg {
                let path = Path::new(name).join(rel);
                let entry = path.to_string_lossy().replace('\\', "/");
                zip.start_file(entry, opts)?;
                zip.write_all(bytes)?;
            }
            zip.finish()?;
        }
        fsutil::write_atomic(dest, buf.get_ref())?;
        Ok(())
    }

    /// 删除技能（挪进回收站）。
    ///
    /// # Arguments
    ///
    /// * `name` - 技能名。
    /// * `now_ms` - 当前时间（Unix 毫秒）。
    ///
    /// # Returns
    ///
    /// 回收站条目。
    ///
    /// # Errors
    ///
    /// 技能不存在或挪动失败时返回错误。
    pub fn delete(&self, name: &str, now_ms: u64) -> Result<TrashEntry, SkillError> {
        let dir = self.dir_of(name)?;
        self.trash.put_dir(TRASH_KIND, name, &dir, now_ms)
    }

    /// 从回收站恢复技能。
    ///
    /// # Arguments
    ///
    /// * `trash_id` - 回收站条目 id。
    ///
    /// # Returns
    ///
    /// 恢复的技能。
    ///
    /// # Errors
    ///
    /// 条目不存在或不是技能（[`SkillError::NotFound`]）、同名技能已存在（[`SkillError::Exists`]）或读写失败。
    pub fn restore(&self, trash_id: &str) -> Result<SkillInfo, SkillError> {
        let entry = self.trash.entry(trash_id)?;
        if entry.kind != TRASH_KIND || !valid_name(&entry.label) {
            return Err(SkillError::NotFound);
        }
        let dest = self.root.join(&entry.label);
        self.trash.take_dir(trash_id, &dest)?;
        info_of(&read_dir(&dest)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SKILL: &str = "---\nname: beat-flash\ndescription: Flash on beats\nmetadata:\n  title: Beat flash\n  triggers: beat, 节拍，flash\n---\nDo it.\n";

    fn store(tmp: &Path) -> SkillStore {
        SkillStore::new(tmp.join("skills"), Trash::new(tmp.join("trash")))
    }

    fn zip_of(path: &Path, files: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, body) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn 导入文件夹_列出_读取_导出_再导入() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path());
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("scripts")).unwrap();
        std::fs::write(src.join("SKILL.md"), SKILL).unwrap();
        std::fs::write(src.join("scripts").join("run.py"), "print(1)").unwrap();
        let info = s.import(&src, false, 1).unwrap();
        assert_eq!(info.name, "beat-flash");
        assert_eq!(info.title.as_deref(), Some("Beat flash"));
        assert_eq!(info.triggers, vec!["beat", "节拍", "flash"]);
        assert!(info.has_scripts);
        assert_eq!(info.files, 2);
        assert_eq!(s.list(), vec![info.clone()]);
        assert_eq!(s.read("beat-flash").unwrap(), SKILL);

        assert!(matches!(s.import(&src, false, 2), Err(SkillError::Exists)));
        let zip = tmp.path().join("out.zip");
        s.export("beat-flash", &zip).unwrap();
        // 替换：旧的进回收站
        let again = s.import(&zip, true, 3).unwrap();
        assert_eq!(again, info);
        assert_eq!(s.trash().list().len(), 1);
    }

    #[test]
    fn zip_去掉顶层目录_忽略系统杂项() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path());
        let zip = tmp.path().join("a.zip");
        zip_of(&zip, &[("pkg/SKILL.md", SKILL.as_bytes()), ("pkg/ref/notes.md", b"n"), ("__MACOSX/pkg/._SKILL.md", b"x")]);
        let info = s.import(&zip, false, 1).unwrap();
        assert_eq!(info.files, 2);
        assert!(tmp.path().join("skills/beat-flash/ref/notes.md").is_file());
    }

    #[test]
    fn 越界路径_过大_文件过多_没有_skill_md_都被拒绝() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path());
        let slip = tmp.path().join("slip.zip");
        zip_of(&slip, &[("SKILL.md", SKILL.as_bytes()), ("../evil.txt", b"x")]);
        assert!(matches!(s.import(&slip, false, 1), Err(SkillError::UnsafePath)));
        assert!(!tmp.path().join("evil.txt").exists());

        let big = tmp.path().join("big.zip");
        let blob = vec![b'a'; (MAX_PACKAGE_BYTES + 1) as usize];
        zip_of(&big, &[("SKILL.md", SKILL.as_bytes()), ("blob.bin", &blob)]);
        assert!(matches!(s.import(&big, false, 1), Err(SkillError::TooLarge)));

        let many = tmp.path().join("many.zip");
        let names: Vec<String> = (0..=MAX_FILES).map(|i| format!("f{i}.txt")).collect();
        let mut files: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), b"x".as_slice())).collect();
        files.push(("SKILL.md", SKILL.as_bytes()));
        zip_of(&many, &files);
        assert!(matches!(s.import(&many, false, 1), Err(SkillError::TooLarge)));

        let none = tmp.path().join("none.zip");
        zip_of(&none, &[("readme.md", b"x")]);
        assert!(matches!(s.import(&none, false, 1), Err(SkillError::Invalid(_))));
        assert!(s.list().is_empty());
        // 没有留下临时目录
        assert_eq!(std::fs::read_dir(tmp.path().join("skills")).map_or(0, Iterator::count), 0);
    }

    #[cfg(unix)]
    #[test]
    fn 文件夹里的符号链接被拒绝() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path());
        let src = tmp.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), SKILL).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", src.join("link")).unwrap();
        assert!(matches!(s.import(&src, false, 1), Err(SkillError::Symlink)));
    }

    #[test]
    fn 单个_skill_md_删除进回收站后恢复() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(tmp.path());
        let file = tmp.path().join("SKILL.md");
        std::fs::write(&file, SKILL).unwrap();
        s.import(&file, false, 1).unwrap();
        let entry = s.delete("beat-flash", 5).unwrap();
        assert!(s.list().is_empty());
        assert!(matches!(s.read("beat-flash"), Err(SkillError::NotFound)));
        let back = s.restore(&entry.id).unwrap();
        assert_eq!(back.name, "beat-flash");
        assert!(s.trash().list().is_empty());
        assert!(matches!(s.dir_of("../x"), Err(SkillError::NotFound)));
    }
}
