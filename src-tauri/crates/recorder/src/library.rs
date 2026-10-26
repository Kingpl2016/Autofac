//! 节目库：列出、重命名、删除录制目录里的 `.artrec` 节目（及其 sidecar 与概览缓存）。
//!
//! 所有接收外部路径的函数都先经 [`resolve_in_dir`] 校验：路径必须是录制目录**直接子级**
//! 的 `.artrec` 文件，防止通过 `..` 或任意绝对路径误删 / 误改目录外的文件。
//!
//! # 列举与缓存
//!
//! 每个条目只读 `.artrec` 的文件头与 Universe 表（不解析帧索引）和 sidecar。
//! [`list_library`] 经进程级 [`LibraryCache`] 只重读"指纹"变化的文件，见 [`LibraryCache`]。

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{File, Metadata};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use artrec_core::{read_header_and_unis, FRAMEINDEX_SIZE};
use serde::Serialize;

use crate::sidecar::{overview_cache_path, read_sidecar, sidecar_path, write_sidecar};
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
    /// 无法移入系统回收站（此时文件保持原样，不会退化为永久删除）。
    #[error("无法移入回收站: {0}")]
    Trash(String),
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

fn modified_ms(meta: &Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// `.artrec` 头部摘要：时长、帧数与 Universe 集合。
struct HeaderSummary {
    /// 总时长（微秒）。
    duration_us: u64,
    /// 帧数（取自文件头）。
    frames: u64,
    /// Universe 编号（B 区顺序）。
    universes: Vec<u16>,
}

/// 只读文件头（A 区）与 Universe 表（B 区）判断节目是否有效，不读帧索引。
///
/// 直接用 `File` 而非 `BufReader`：`read_header_and_unis` 内部的两次 `seek` 会清空
/// `BufReader` 缓冲，缓冲只会让每次读取多读数 KB。
///
/// # Arguments
///
/// * `path` - `.artrec` 路径。
///
/// # Returns
///
/// 文件头与 B 区可解析、且头部声明的帧索引区（C 区）没有越出文件末尾（与完整打开读取器时
/// 的边界判定一致，被截断的文件仍判为无效）时返回摘要；否则返回 `None`。
/// 索引条目是否升序需读出整张索引才能判断，不在此检查。
fn probe_header(path: &Path) -> Option<HeaderSummary> {
    let mut f = File::open(path).ok()?;
    let (len, header, unis) = read_header_and_unis(&mut f).ok()?;
    let c_end = u64::from(header.frame_index_offset)
        + u64::from(header.frame_count) * u64::from(FRAMEINDEX_SIZE);
    if c_end > len {
        return None;
    }
    Some(HeaderSummary {
        duration_us: header.total_duration_us,
        frames: u64::from(header.frame_count),
        universes: unis.iter().map(|u| u.universe).collect(),
    })
}

/// 由 `.artrec` 路径与其元数据构造节目条目。
///
/// # Arguments
///
/// * `path` - `.artrec` 路径。
/// * `meta` - 该文件的元数据（提供字节数与修改时间）。
///
/// # Returns
///
/// 节目条目；路径没有文件名时返回 `None`。
fn entry_from(path: &Path, meta: &Metadata) -> Option<LibraryEntry> {
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
        modified_unix_ms: modified_ms(meta),
        duration_us: 0,
        frames: 0,
        universes: Vec::new(),
        sources: Vec::new(),
        recovered: false,
        valid: false,
    };

    // 事实以 `.artrec` 本体为准（头可解析才算有效）；sidecar 只补充名称与来源等元信息
    if let Some(h) = probe_header(path) {
        entry.valid = true;
        entry.duration_us = h.duration_us;
        entry.frames = h.frames;
        entry.universes = h.universes;
    }
    if let Some(side) = read_sidecar(path) {
        if !side.name.trim().is_empty() {
            entry.name = side.name;
        }
        entry.notes = side.notes;
        entry.sources = side.sources.iter().map(ToString::to_string).collect();
        entry.recovered = side.recovered;
    }
    Some(entry)
}

/// 按节目库顺序排序：修改时间从新到旧，相同时按文件名升序。
///
/// # Arguments
///
/// * `list` - 待排序的条目。
fn sort_entries(list: &mut [LibraryEntry]) {
    list.sort_by(|a, b| {
        b.modified_unix_ms
            .cmp(&a.modified_unix_ms)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
}

/// 列出目录下全部节目，按修改时间从新到旧排序。目录不存在时返回空列表。
///
/// 使用进程级 [`LibraryCache`]：只重新读取指纹变化的文件，并剔除已不存在的条目。
/// 缓存是模块级 `static`（`LazyLock`）而非宿主托管状态：宿主层的命令与 host-core 的连播
/// （`next_in_library`）都只调用本函数，全局缓存让它们无需改动即可共享同一份结果。
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
    /// 进程级节目库缓存（见 [`list_library`] 的说明）。
    static GLOBAL: LazyLock<LibraryCache> = LazyLock::new(LibraryCache::new);
    GLOBAL.list(dir)
}

/// 不经缓存、逐个读取文件列出节目库（结果与 [`list_library`] 相同，供基准与测试对照）。
///
/// # Arguments
///
/// * `dir` - 录制目录。
///
/// # Returns
///
/// 同 [`list_library`]。
#[must_use]
pub fn list_library_uncached(dir: &Path) -> Vec<LibraryEntry> {
    let mut out: Vec<LibraryEntry> = crate::store::list_artrec_files(dir)
        .iter()
        .filter_map(|p| {
            let meta = std::fs::metadata(p).ok()?;
            entry_from(p, &meta)
        })
        .collect();
    sort_entries(&mut out);
    out
}

/// 修改时间距"现在"不足该时长的文件不进缓存（每次都重读）。
///
/// 文件系统的修改时间有刻度（NTFS 实际约 1~16ms，exFAT 10ms，FAT32 2s）：同一刻度内写出
/// 等长内容的两次修改指纹相同、无法区分。刚修改过的文件暂不缓存，等它"稳定"后再缓存，
/// 即可排除这种情况（与 git 索引处理 racy 文件的思路相同）。
const RACY_WINDOW: Duration = Duration::from_secs(3);

/// 节目文件指纹：`.artrec` 的 (字节数, 修改时间) + sidecar 的 (是否存在, 字节数, 修改时间)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Fingerprint {
    /// `.artrec` 字节数。
    len: u64,
    /// `.artrec` 修改时间；平台不支持时为 `None`。
    modified: Option<SystemTime>,
    /// sidecar 的 (字节数, 修改时间)；sidecar 不存在时为 `None`。
    sidecar: Option<(u64, Option<SystemTime>)>,
}

impl Fingerprint {
    /// 由元数据构造指纹。
    ///
    /// # Arguments
    ///
    /// * `artrec` - `.artrec` 的元数据。
    /// * `sidecar` - sidecar 的元数据；不存在时为 `None`。
    ///
    /// # Returns
    ///
    /// 对应的指纹。
    fn of(artrec: &Metadata, sidecar: Option<&Metadata>) -> Self {
        Self {
            len: artrec.len(),
            modified: artrec.modified().ok(),
            sidecar: sidecar.map(|m| (m.len(), m.modified().ok())),
        }
    }

    /// 指纹是否"过新"而不可信（见 [`RACY_WINDOW`]）。
    ///
    /// # Arguments
    ///
    /// * `now` - 本次列举开始的时刻。
    ///
    /// # Returns
    ///
    /// 任一修改时间缺失、晚于 `now` 或距 `now` 不足 [`RACY_WINDOW`] 时返回 `true`。
    fn is_racy(&self, now: SystemTime) -> bool {
        let recent = |t: Option<SystemTime>| {
            t.is_none_or(|t| now.duration_since(t).map_or(true, |d| d < RACY_WINDOW))
        };
        recent(self.modified) || self.sidecar.is_some_and(|(_, m)| recent(m))
    }
}

/// 节目库内存缓存：`.artrec` 路径 → (指纹, 条目)。
///
/// 失效规则：
/// - 每次 [`LibraryCache::list`] 都重新列目录并取每个 `.artrec` 与其 sidecar 的元数据，
///   指纹（见 `Fingerprint`）与缓存一致才复用条目，否则重读该文件；
/// - 目录里已不存在的条目被剔除（缓存只反映最近一次列举的目录，切换目录时旧目录条目整体剔除）；
/// - 修改时间距列举时刻不足 3 秒的文件不进缓存（避免同一时间刻度内的等长修改被漏判）。
///
/// 概览缓存 `.artrec.ovw` 不影响条目内容，不参与指纹。读取文件时不持锁，并发列举互不阻塞。
#[derive(Debug, Default)]
pub struct LibraryCache {
    /// `.artrec` 路径 → (指纹, 条目)。
    entries: Mutex<HashMap<PathBuf, (Fingerprint, LibraryEntry)>>,
}

impl LibraryCache {
    /// 创建空缓存。
    ///
    /// # Returns
    ///
    /// 不含任何条目的缓存。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 加锁；锁被毒化（持锁线程 panic）时照常取用——缓存内容总是完整写入的条目。
    fn lock(&self) -> MutexGuard<'_, HashMap<PathBuf, (Fingerprint, LibraryEntry)>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 列出目录下全部节目（只重读指纹变化的文件），排序规则同 [`list_library`]。
    ///
    /// # Arguments
    ///
    /// * `dir` - 录制目录。
    ///
    /// # Returns
    ///
    /// 与 [`list_library_uncached`] 相同的结果；目录不存在时为空（并清空缓存）。
    #[must_use]
    pub fn list(&self, dir: &Path) -> Vec<LibraryEntry> {
        let now = SystemTime::now();
        let scanned = scan_dir(dir);

        // 1. 命中的条目直接取缓存（只在比对时持锁）
        let mut slots: Vec<Option<LibraryEntry>> = {
            let map = self.lock();
            scanned
                .iter()
                .map(|(p, _, fp)| match map.get(p) {
                    Some((cached, e)) if cached == fp => Some(e.clone()),
                    _ => None,
                })
                .collect()
        };

        // 2. 未命中的重新读取（不持锁）
        let mut fresh = Vec::new();
        for ((p, meta, fp), slot) in scanned.iter().zip(&mut slots) {
            if slot.is_some() {
                continue;
            }
            if let Some(e) = entry_from(p, meta) {
                if !fp.is_racy(now) {
                    fresh.push((p.clone(), *fp, e.clone()));
                }
                *slot = Some(e);
            }
        }

        // 3. 回写新条目并剔除目录里已不存在的条目
        {
            let mut map = self.lock();
            let alive: HashSet<&Path> = scanned.iter().map(|(p, ..)| p.as_path()).collect();
            map.retain(|k, _| alive.contains(k.as_path()));
            map.extend(fresh.into_iter().map(|(p, fp, e)| (p, (fp, e))));
        }

        let mut out: Vec<LibraryEntry> = slots.into_iter().flatten().collect();
        sort_entries(&mut out);
        out
    }

    /// 当前缓存的条目数（诊断、测试与基准用）。
    ///
    /// # Returns
    ///
    /// 缓存中的条目数；处在 racy 窗口内的文件不计入。
    #[must_use]
    pub fn cached_count(&self) -> usize {
        self.lock().len()
    }
}

/// 取目录项的元数据：优先用目录枚举自带的信息（Windows 上不需要额外的系统调用），
/// 符号链接回落到 `fs::metadata` 以取得目标文件的信息。
///
/// # Arguments
///
/// * `entry` - 目录项。
/// * `path` - 目录项的完整路径。
///
/// # Returns
///
/// 元数据；取不到时返回 `None`。
fn entry_metadata(entry: &std::fs::DirEntry, path: &Path) -> Option<Metadata> {
    match entry.metadata() {
        Ok(m) if !m.file_type().is_symlink() => Some(m),
        _ => std::fs::metadata(path).ok(),
    }
}

/// 列出目录下的 `.artrec`（筛选规则与 [`crate::store::list_artrec_files`] 一致），并取元数据与指纹。
///
/// 一次目录枚举同时收集 `.artrec` 与 `.json` 的元数据：sidecar 按 [`sidecar_path`] 生成的
/// 精确文件名查找；查不到（没有 sidecar，或大小写不同的手改文件名）时再用 `fs::metadata`
/// 精确查询，保证指纹里的 sidecar 与 [`read_sidecar`] 打开的是同一个文件。
///
/// # Arguments
///
/// * `dir` - 录制目录。
///
/// # Returns
///
/// 按路径升序的 `(路径, 元数据, 指纹)`；目录不存在或无法读取时为空，取不到元数据的文件被跳过。
fn scan_dir(dir: &Path) -> Vec<(PathBuf, Metadata, Fingerprint)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut programs: Vec<(PathBuf, Metadata)> = Vec::new();
    let mut sidecars: HashMap<OsString, Metadata> = HashMap::new();
    for e in rd.filter_map(Result::ok) {
        let path = e.path();
        let Some(ext) = path.extension().and_then(|x| x.to_str()) else {
            continue;
        };
        if ext.eq_ignore_ascii_case("artrec") {
            if let Some(meta) = entry_metadata(&e, &path) {
                programs.push((path, meta));
            }
        } else if ext == "json" {
            if let Some(meta) = entry_metadata(&e, &path) {
                sidecars.insert(e.file_name(), meta);
            }
        }
    }
    programs.sort_by(|a, b| a.0.cmp(&b.0));
    programs
        .into_iter()
        .map(|(path, meta)| {
            let side_path = sidecar_path(&path);
            let listed = side_path.file_name().and_then(|n| sidecars.get(n));
            let probed = if listed.is_none() {
                std::fs::metadata(&side_path).ok()
            } else {
                None
            };
            let fp = Fingerprint::of(&meta, listed.or(probed.as_ref()));
            (path, meta, fp)
        })
        .collect()
}

/// 重命名节目：同时重命名文件、sidecar 与概览缓存，并把 sidecar 的显示名更新为 `new_name`。
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
pub fn rename_recording(dir: &Path, path: &Path, new_name: &str) -> Result<PathBuf, LibraryError> {
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
        move_overview_cache(&src, &dst);
    }
    meta.name = new_name.trim().to_string();
    write_sidecar(&dst, &meta)?;
    Ok(dst)
}

/// 把概览缓存随节目一起改名；与 sidecar 一样，目标位置上残留的旧缓存被覆盖。
///
/// 缓存可随时重新生成，因此这里的失败都不上报：源缓存不存在或无法移动时，两端可能残留的
/// 缓存都被删除，避免目标名下留着属于别的节目的旧缓存。
///
/// # Arguments
///
/// * `src` - 改名前的 `.artrec` 路径。
/// * `dst` - 改名后的 `.artrec` 路径。
fn move_overview_cache(src: &Path, dst: &Path) {
    let from = overview_cache_path(src);
    let to = overview_cache_path(dst);
    if std::fs::rename(&from, &to).is_err() {
        let _ = std::fs::remove_file(&from);
        let _ = std::fs::remove_file(&to);
    }
}

/// 把一组文件移入系统回收站的函数：成功返回 `Ok`，失败返回描述。
pub type TrashFn<'a> = &'a dyn Fn(&[PathBuf]) -> Result<(), String>;

/// 真实的回收站实现：把给定文件一并移入系统回收站。
///
/// # Arguments
///
/// * `paths` - 要移入回收站的文件（已存在）。
///
/// # Errors
///
/// 系统回收站不可用或移动失败时返回描述。
pub fn trash_paths(paths: &[PathBuf]) -> Result<(), String> {
    trash::delete_all(paths).map_err(|e| e.to_string())
}

/// 把节目及其 sidecar、概览缓存移入系统回收站（可在回收站里恢复）。
///
/// 移动失败时**不会**退化为永久删除：文件保持原样并返回 [`LibraryError::Trash`]。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `path` - 待删除节目的路径，须通过 [`resolve_in_dir`] 校验。
///
/// # Errors
///
/// 路径非法，或无法移入回收站。
pub fn delete_recording(dir: &Path, path: &Path) -> Result<(), LibraryError> {
    delete_recording_with(dir, path, &trash_paths)
}

/// [`delete_recording`] 的实现体，回收站操作可替换（测试用，避免弄脏真实回收站）。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `path` - 待删除节目的路径，须通过 [`resolve_in_dir`] 校验。
/// * `trash` - 把文件移入回收站的函数；节目与其存在的 sidecar、概览缓存（依此顺序）会在
///   **一次**调用里交给它。
///
/// # Errors
///
/// 路径非法，或 `trash` 返回错误（`LibraryError::Trash`）。
pub fn delete_recording_with(
    dir: &Path,
    path: &Path,
    trash: TrashFn<'_>,
) -> Result<(), LibraryError> {
    let src = resolve_in_dir(dir, path)?;
    let mut items = vec![src.clone()];
    items.extend(
        [sidecar_path(&src), overview_cache_path(&src)]
            .into_iter()
            .filter(|p| p.exists()),
    );
    trash(&items).map_err(LibraryError::Trash)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime};

    use artrec_core::{ArtRecWriter, CompressAlgo, UniDesc};

    use super::{
        delete_recording, delete_recording_with, list_library, list_library_uncached,
        rename_recording, resolve_in_dir, LibraryCache, LibraryError,
    };
    use crate::sidecar::{
        overview_cache_path, read_overview_cache, read_sidecar, sidecar_path, write_overview_cache,
        write_sidecar, Sidecar,
    };
    use crate::testutil::TempDir;

    /// 生成一个含 `frames` 帧的合法 `.artrec` 的字节。
    fn artrec_bytes(frames: u64) -> Vec<u8> {
        let unis = vec![UniDesc::from_universe(3, 512).unwrap()];
        let mut w =
            ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 3, 0, 0).unwrap();
        for i in 0..frames {
            w.add_full_frame(i * 1000, &[vec![i as u8; 512]]).unwrap();
        }
        w.finish(frames * 1000).unwrap().into_inner()
    }

    /// 写出一个含 `frames` 帧的合法 `.artrec`。
    fn make_artrec(dir: &TempDir, stem: &str, frames: u64) -> std::path::PathBuf {
        let p = dir.path().join(format!("{stem}.artrec"));
        std::fs::write(&p, artrec_bytes(frames)).unwrap();
        p
    }

    /// 把文件的修改时间设为"现在之前 `ago_secs` 秒"（越过缓存的 racy 窗口）。
    fn set_age(path: &Path, ago_secs: u64) {
        let t = SystemTime::now() - Duration::from_secs(ago_secs);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    /// 读取文件的修改时间。
    fn mtime(path: &Path) -> SystemTime {
        std::fs::metadata(path).unwrap().modified().unwrap()
    }

    /// 原样保留修改时间改写文件内容（模拟"指纹相同"的修改）。
    fn overwrite_keeping_mtime(path: &Path, bytes: &[u8]) {
        let t = mtime(path);
        std::fs::write(path, bytes).unwrap();
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
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
        assert_eq!(ea.duration_us, 3000);
        assert_eq!(ea.universes, vec![3]);
        assert_eq!(ea.sources, vec!["10.0.0.7".to_string()]);
        assert!(ea.valid);
        let eb = list.iter().find(|e| e.file_name == "b.artrec").unwrap();
        assert_eq!(eb.name, "b", "无 sidecar 时回落到文件名主干");
        assert_eq!(eb.frames, 5);
        let junk = list.iter().find(|e| e.file_name == "junk.artrec").unwrap();
        assert!(!junk.valid);
        assert_eq!(
            list,
            list_library_uncached(dir.path()),
            "缓存版与直读版结果一致"
        );
    }

    #[test]
    fn truncated_index_is_invalid_without_reading_it() {
        let dir = TempDir::new("lib-trunc");
        let bytes = artrec_bytes(20);
        // 头与 Universe 表完好，但帧索引区（文件末尾）被截掉一部分
        std::fs::write(dir.path().join("cut.artrec"), &bytes[..bytes.len() - 8]).unwrap();
        let list = list_library_uncached(dir.path());
        assert_eq!(list.len(), 1);
        assert!(!list[0].valid, "帧索引越界与完整打开读取器时一样判为无效");
    }

    #[test]
    fn missing_dir_lists_empty() {
        let dir = TempDir::new("lib-missing");
        assert!(list_library(&dir.path().join("nope")).is_empty());
        assert!(list_library_uncached(&dir.path().join("nope")).is_empty());
    }

    #[test]
    fn list_order_is_newest_first_then_file_name() {
        let dir = TempDir::new("lib-order");
        for (stem, age) in [("old", 300), ("mid-b", 200), ("mid-a", 200), ("new", 100)] {
            set_age(&make_artrec(&dir, stem, 1), age);
        }
        let names = |l: Vec<super::LibraryEntry>| -> Vec<String> {
            l.into_iter().map(|e| e.file_name).collect()
        };
        let cache = LibraryCache::new();
        let want = ["new.artrec", "mid-a.artrec", "mid-b.artrec", "old.artrec"];
        assert_eq!(names(cache.list(dir.path())), want);
        assert_eq!(names(cache.list(dir.path())), want, "命中缓存时顺序不变");
        assert_eq!(names(list_library_uncached(dir.path())), want);
    }

    #[test]
    fn cache_reuses_entries_while_fingerprint_is_unchanged() {
        let dir = TempDir::new("lib-cache-hit");
        let a = make_artrec(&dir, "a", 3);
        set_age(&a, 3600);
        let cache = LibraryCache::new();
        assert!(cache.list(dir.path())[0].valid);
        assert_eq!(cache.cached_count(), 1);

        // 等长改写且保留修改时间：指纹不变，说明第二次列举没有重读文件
        let junk = vec![0xEEu8; std::fs::metadata(&a).unwrap().len() as usize];
        overwrite_keeping_mtime(&a, &junk);
        let hit = cache.list(dir.path());
        assert!(hit[0].valid && hit[0].frames == 3, "应命中缓存: {hit:?}");
        assert!(
            !list_library_uncached(dir.path())[0].valid,
            "直读版看到的是新内容"
        );
    }

    #[test]
    fn cache_invalidates_when_program_changes() {
        let dir = TempDir::new("lib-cache-mod");
        let a = make_artrec(&dir, "a", 3);
        set_age(&a, 3600);
        let cache = LibraryCache::new();
        assert_eq!(cache.list(dir.path())[0].frames, 3);

        // 内容与长度都变
        std::fs::write(&a, artrec_bytes(7)).unwrap();
        set_age(&a, 1800);
        assert_eq!(cache.list(dir.path())[0].frames, 7);

        // 只改修改时间：同样视为变化（条目的修改时间随之更新）
        set_age(&a, 900);
        let e = &cache.list(dir.path())[0];
        assert_eq!(
            e.modified_unix_ms,
            super::modified_ms(&std::fs::metadata(&a).unwrap())
        );
    }

    #[test]
    fn cache_invalidates_when_sidecar_appears_changes_or_is_renamed() {
        let dir = TempDir::new("lib-cache-side");
        let a = make_artrec(&dir, "a", 1);
        set_age(&a, 3600);
        let cache = LibraryCache::new();
        assert_eq!(cache.list(dir.path())[0].name, "a");

        // sidecar 出现
        write_sidecar(
            &a,
            &Sidecar {
                name: "开场".into(),
                ..Sidecar::default()
            },
        )
        .unwrap();
        set_age(&sidecar_path(&a), 3000);
        assert_eq!(cache.list(dir.path())[0].name, "开场");

        // sidecar 等长改写、只有修改时间不同
        write_sidecar(
            &a,
            &Sidecar {
                name: "终场".into(),
                ..Sidecar::default()
            },
        )
        .unwrap();
        set_age(&sidecar_path(&a), 2000);
        assert_eq!(cache.list(dir.path())[0].name, "终场");

        // sidecar 被改名移走：回落到文件名主干
        let moved = dir.path().join("a.artrec.json.bak");
        std::fs::rename(sidecar_path(&a), &moved).unwrap();
        assert_eq!(cache.list(dir.path())[0].name, "a");
        // 改回来：再次生效
        std::fs::rename(&moved, sidecar_path(&a)).unwrap();
        assert_eq!(cache.list(dir.path())[0].name, "终场");
    }

    #[test]
    fn cache_drops_deleted_and_renamed_programs() {
        let dir = TempDir::new("lib-cache-del");
        let a = make_artrec(&dir, "a", 1);
        let b = make_artrec(&dir, "b", 2);
        set_age(&a, 3600);
        set_age(&b, 3600);
        let cache = LibraryCache::new();
        assert_eq!(cache.list(dir.path()).len(), 2);
        assert_eq!(cache.cached_count(), 2);

        std::fs::remove_file(&b).unwrap();
        let list = cache.list(dir.path());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].file_name, "a.artrec");
        assert_eq!(cache.cached_count(), 1, "已删除的条目应被剔除");

        let np = rename_recording(dir.path(), &a, "c").unwrap();
        let list = cache.list(dir.path());
        assert_eq!(list.len(), 1);
        assert_eq!(
            std::ffi::OsStr::new(&list[0].file_name),
            np.file_name().unwrap()
        );
        // 旧路径被剔除；新 sidecar 刚写出（处在 racy 窗口内），暂不进缓存
        assert_eq!(cache.cached_count(), 0);
        set_age(&sidecar_path(&np), 3600);
        assert_eq!(cache.list(dir.path()).len(), 1);
        assert_eq!(cache.cached_count(), 1);

        // 切换到另一个目录：旧目录的条目整体剔除
        let other = TempDir::new("lib-cache-other");
        assert!(cache.list(other.path()).is_empty());
        assert_eq!(cache.cached_count(), 0);
    }

    #[test]
    fn freshly_modified_files_are_not_cached() {
        let dir = TempDir::new("lib-cache-racy");
        let a = make_artrec(&dir, "a", 3);
        let cache = LibraryCache::new();
        assert!(cache.list(dir.path())[0].valid);
        assert_eq!(
            cache.cached_count(),
            0,
            "刚写出的文件处在 racy 窗口内，不进缓存"
        );
        // 同一时间刻度内的等长修改也能被看到
        let junk = vec![0xEEu8; std::fs::metadata(&a).unwrap().len() as usize];
        overwrite_keeping_mtime(&a, &junk);
        assert!(!cache.list(dir.path())[0].valid);
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
    fn rename_moves_file_sidecar_and_overview_cache() {
        let dir = TempDir::new("lib-rename");
        let p = make_artrec(&dir, "old", 2);
        write_sidecar(
            &p,
            &Sidecar {
                name: "旧名".into(),
                notes: "n".into(),
                ..Sidecar::default()
            },
        )
        .unwrap();
        write_overview_cache(&p, b"ovw").unwrap();

        let np = rename_recording(dir.path(), &p, "新 名/称").unwrap();
        assert_eq!(np.file_name().unwrap(), "新 名_称.artrec");
        assert!(!p.exists());
        assert!(!sidecar_path(&p).exists());
        assert!(!overview_cache_path(&p).exists());
        let meta = read_sidecar(&np).unwrap();
        assert_eq!(meta.name, "新 名/称");
        assert_eq!(meta.notes, "n");
        assert_eq!(read_overview_cache(&np).as_deref(), Some(&b"ovw"[..]));
    }

    #[test]
    fn rename_replaces_stale_caches_left_under_the_target_name() {
        let dir = TempDir::new("lib-rename-stale");
        let a = make_artrec(&dir, "a", 1);
        // 目标名下残留着别的节目的 sidecar 与概览缓存（本体已不在）
        let ghost = dir.path().join("b.artrec");
        write_sidecar(
            &ghost,
            &Sidecar {
                notes: "别人的".into(),
                ..Sidecar::default()
            },
        )
        .unwrap();
        write_overview_cache(&ghost, b"stale").unwrap();

        // 源没有概览缓存：目标名下的旧缓存被删除
        let np = rename_recording(dir.path(), &a, "b").unwrap();
        assert_eq!(
            np,
            std::fs::canonicalize(dir.path()).unwrap().join("b.artrec")
        );
        assert!(
            !overview_cache_path(&np).exists(),
            "不能沿用别的节目的旧缓存"
        );
        assert_eq!(read_sidecar(&np).unwrap().notes, "", "sidecar 同样被覆盖");

        // 源有概览缓存：覆盖目标名下的旧缓存
        let c = make_artrec(&dir, "c", 1);
        write_overview_cache(&c, b"mine").unwrap();
        write_overview_cache(&dir.path().join("d.artrec"), b"stale").unwrap();
        let nd = rename_recording(dir.path(), &c, "d").unwrap();
        assert_eq!(read_overview_cache(&nd).as_deref(), Some(&b"mine"[..]));
        assert!(!overview_cache_path(&c).exists());
    }

    #[test]
    fn rename_refuses_to_overwrite() {
        let dir = TempDir::new("lib-rename-dup");
        let a = make_artrec(&dir, "a", 1);
        let _b = make_artrec(&dir, "b", 1);
        write_overview_cache(&a, b"ovw").unwrap();
        assert!(matches!(
            rename_recording(dir.path(), &a, "b"),
            Err(LibraryError::AlreadyExists)
        ));
        assert!(a.exists());
        assert!(overview_cache_path(&a).exists(), "拒绝时概览缓存原样保留");
    }

    #[test]
    fn delete_hands_program_sidecar_and_overview_to_trash_together() {
        use std::cell::RefCell;
        let dir = TempDir::new("lib-del");
        let p = make_artrec(&dir, "d", 1);
        write_sidecar(&p, &Sidecar::default()).unwrap();
        write_overview_cache(&p, b"ovw").unwrap();
        let calls: RefCell<Vec<Vec<PathBuf>>> = RefCell::new(Vec::new());
        delete_recording_with(dir.path(), &p, &|items: &[PathBuf]| {
            calls.borrow_mut().push(items.to_vec());
            Ok(())
        })
        .unwrap();
        let calls = calls.into_inner();
        assert_eq!(
            calls.len(),
            1,
            "节目、sidecar 与概览缓存应在一次回收站操作里交出"
        );
        assert_eq!(calls[0].len(), 3);
        assert!(calls[0][0].ends_with("d.artrec"));
        assert_eq!(calls[0][1], sidecar_path(&calls[0][0]));
        assert_eq!(calls[0][2], overview_cache_path(&calls[0][0]));
    }

    #[test]
    fn delete_only_includes_companions_that_exist() {
        let dir = TempDir::new("lib-del-nosc");
        let p = make_artrec(&dir, "d", 1);
        let seen = std::cell::RefCell::new(Vec::new());
        let probe = |items: &[PathBuf]| {
            *seen.borrow_mut() = items.to_vec();
            Ok(())
        };
        delete_recording_with(dir.path(), &p, &probe).unwrap();
        assert_eq!(seen.borrow().len(), 1, "只有节目本体");

        // 只有概览缓存、没有 sidecar
        write_overview_cache(&p, b"ovw").unwrap();
        delete_recording_with(dir.path(), &p, &probe).unwrap();
        let items = seen.into_inner();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1], overview_cache_path(&items[0]));
    }

    /// 回收站失败时必须保留文件，绝不退化为永久删除。
    #[test]
    fn trash_failure_keeps_files_and_reports_error() {
        let dir = TempDir::new("lib-del-fail");
        let p = make_artrec(&dir, "d", 1);
        write_sidecar(&p, &Sidecar::default()).unwrap();
        write_overview_cache(&p, b"ovw").unwrap();
        let err =
            delete_recording_with(dir.path(), &p, &|_: &[PathBuf]| Err("回收站不可用".into()))
                .unwrap_err();
        assert!(
            matches!(err, LibraryError::Trash(ref m) if m == "回收站不可用"),
            "{err:?}"
        );
        assert!(
            p.exists() && sidecar_path(&p).exists() && overview_cache_path(&p).exists(),
            "失败后文件必须原样保留"
        );
    }

    #[test]
    fn delete_validates_path_before_touching_trash() {
        let dir = TempDir::new("lib-del-guard");
        let p = make_artrec(&dir, "d", 1);
        std::fs::remove_file(&p).unwrap();
        let called = std::cell::RefCell::new(false);
        let probe = |_: &[PathBuf]| {
            *called.borrow_mut() = true;
            Ok(())
        };
        assert!(matches!(
            delete_recording_with(dir.path(), &p, &probe),
            Err(LibraryError::NotFound)
        ));
        let outside = std::env::temp_dir().join("elsewhere.artrec");
        assert!(delete_recording_with(dir.path(), &outside, &probe).is_err());
        assert!(!*called.borrow(), "非法路径不应触达回收站");
    }
}
