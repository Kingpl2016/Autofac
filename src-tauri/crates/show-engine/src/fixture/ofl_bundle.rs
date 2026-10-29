//! OFL 整库读取与目录索引：从官方仓库的 zip 或解压后的文件夹里找出全部灯具，
//! 读取 `manufacturers.json` 得到制造商显示名、解析重定向文件，生成可搜索的轻量目录。
//!
//! 目录只记录名称、分类、各模式通道数等摘要，不做完整导入；用户勾选后再按标识读取并导入。
//!
//! 安全限制：灯具数、单个文件大小与解压总量都有上限（防 zip 炸弹）；zip 条目名必须是安全的相对路径；
//! 解压只在内存里进行，不写磁盘。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use zip::ZipArchive;

use super::import::{ImportError, ImportReport, ImportWarning, ImportWarningKind};
use super::ofl::import_ofl_as;

/// 一个包里最多的灯具文件数（OFL 官方库约 1000 余个）。
pub const MAX_BUNDLE_FIXTURES: usize = 20_000;
/// 单个灯具 JSON 的大小上限（字节）。
pub const MAX_FIXTURE_BYTES: u64 = 5 * 1024 * 1024;
/// 一个包里全部 JSON 解压后的总大小上限（字节）。
pub const MAX_BUNDLE_BYTES: u64 = 512 * 1024 * 1024;
/// 重定向链的最大长度。
const MAX_REDIRECT_DEPTH: usize = 8;
/// 遍历文件夹的最大深度。
const MAX_DIR_DEPTH: usize = 6;
/// 目录文件格式版本。
pub const CATALOG_VERSION: u32 = 1;

/// 读取 OFL 包失败。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BundleError {
    /// 路径不存在、不是 zip / 文件夹，或 zip 损坏。
    #[error("无法打开 OFL 包：{0}")]
    Open(String),
    /// 包里没有找到任何灯具 JSON。
    #[error("包里没有找到 OFL 灯具")]
    Empty,
    /// 灯具数、单文件大小或解压总量超过上限。
    #[error("OFL 包超出大小上限")]
    TooLarge,
    /// 包里没有这个灯具。
    #[error("包里没有灯具 {0}")]
    NotFound(String),
    /// 包在建立目录之后被修改或移走，需要重新打开。
    #[error("OFL 包已变化，请重新打开")]
    Stale,
}

impl BundleError {
    /// 机器可读的错误码，前端据此选择本地化文案。
    ///
    /// # Returns
    ///
    /// `bundle_open`、`bundle_empty`、`bundle_too_large`、`bundle_not_found` 或 `catalog_stale`。
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Open(_) => "bundle_open",
            Self::Empty => "bundle_empty",
            Self::TooLarge => "bundle_too_large",
            Self::NotFound(_) => "bundle_not_found",
            Self::Stale => "catalog_stale",
        }
    }
}

/// 包的存放方式。
enum Store {
    Dir(PathBuf),
    Zip(Box<ZipArchive<File>>),
}

/// 打开的 OFL 包。
pub struct OflBundle {
    store: Store,
    /// 灯具标识（`制造商/灯具`）→ 包内路径。
    files: BTreeMap<String, String>,
    /// `manufacturers.json` 的包内路径。
    manufacturers_path: Option<String>,
    /// 包的指纹（大小与修改时间），用于发现包被替换。
    fingerprint: String,
}

impl std::fmt::Debug for OflBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OflBundle")
            .field("files", &self.files.len())
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

/// 包内一个候选文件：路径（`/` 分隔）与大小。
struct Candidate {
    path: String,
    size: u64,
}

impl OflBundle {
    /// 打开一个 OFL 包（`.zip` 文件或文件夹）。
    ///
    /// # Arguments
    ///
    /// * `path` - zip 文件或文件夹路径；可以是仓库根目录、`fixtures` 目录或其上级。
    ///
    /// # Returns
    ///
    /// 打开的包。
    ///
    /// # Errors
    ///
    /// - 路径不可读或 zip 损坏时返回 [`BundleError::Open`]。
    /// - 没有灯具时返回 [`BundleError::Empty`]。
    /// - 超出数量或大小上限时返回 [`BundleError::TooLarge`]。
    pub fn open(path: &Path) -> Result<Self, BundleError> {
        let meta = std::fs::metadata(path).map_err(|e| BundleError::Open(e.to_string()))?;
        let (store, candidates) = if meta.is_dir() {
            let mut out = Vec::new();
            walk_dir(path, path, 0, &mut out)?;
            (Store::Dir(path.to_path_buf()), out)
        } else {
            let file = File::open(path).map_err(|e| BundleError::Open(e.to_string()))?;
            let mut archive = ZipArchive::new(file).map_err(|e| BundleError::Open(e.to_string()))?;
            let mut out = Vec::new();
            for i in 0..archive.len() {
                let entry = archive.by_index_raw(i).map_err(|e| BundleError::Open(e.to_string()))?;
                if entry.is_dir() {
                    continue;
                }
                // 拒绝绝对路径与 `..`：只接受安全的相对路径
                let Some(safe) = entry.enclosed_name() else { continue };
                let name = safe.to_string_lossy().replace('\\', "/");
                if name.to_ascii_lowercase().ends_with(".json") {
                    out.push(Candidate { path: name, size: entry.size() });
                }
                if out.len() > MAX_BUNDLE_FIXTURES + 1 {
                    return Err(BundleError::TooLarge);
                }
            }
            (Store::Zip(Box::new(archive)), out)
        };
        let total: u64 = candidates.iter().map(|c| c.size).sum();
        if total > MAX_BUNDLE_BYTES {
            return Err(BundleError::TooLarge);
        }
        let (files, manufacturers_path) = pick_fixtures(&candidates);
        if files.is_empty() {
            return Err(BundleError::Empty);
        }
        if files.len() > MAX_BUNDLE_FIXTURES {
            return Err(BundleError::TooLarge);
        }
        let fingerprint = fingerprint_of(path, &meta, total, candidates.len());
        Ok(Self { store, files, manufacturers_path, fingerprint })
    }

    /// 包的指纹：zip 为大小与修改时间，文件夹为 JSON 文件数与总大小。
    ///
    /// # Returns
    ///
    /// 指纹字符串；两次打开得到的指纹不同说明包被修改过。
    #[must_use]
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// 包里的全部灯具标识（`制造商/灯具`，按字母序）。
    ///
    /// # Returns
    ///
    /// 灯具标识迭代器。
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(String::as_str)
    }

    /// 读取一个灯具的 JSON 文本。
    ///
    /// # Arguments
    ///
    /// * `key` - 灯具标识（`制造商/灯具`）。
    ///
    /// # Returns
    ///
    /// JSON 文本。
    ///
    /// # Errors
    ///
    /// - 包里没有这个灯具时返回 [`BundleError::NotFound`]。
    /// - 文件超过 [`MAX_FIXTURE_BYTES`] 时返回 [`BundleError::TooLarge`]。
    /// - 读取失败时返回 [`BundleError::Open`]。
    pub fn read(&mut self, key: &str) -> Result<String, BundleError> {
        let path = self.files.get(key).cloned().ok_or_else(|| BundleError::NotFound(key.to_owned()))?;
        self.read_path(&path)
    }

    /// 制造商标识 → 显示名（来自 `manufacturers.json`；没有该文件时为空）。
    ///
    /// # Returns
    ///
    /// 映射表；文件损坏时为空。
    pub fn manufacturers(&mut self) -> HashMap<String, String> {
        let Some(path) = self.manufacturers_path.clone() else { return HashMap::new() };
        let Ok(text) = self.read_path(&path) else { return HashMap::new() };
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) else { return HashMap::new() };
        map.into_iter()
            .filter(|(k, _)| !k.starts_with('$'))
            .filter_map(|(k, v)| v.get("name").and_then(Value::as_str).map(|n| (k, n.to_owned())))
            .collect()
    }

    fn read_path(&mut self, path: &str) -> Result<String, BundleError> {
        let mut text = String::new();
        match &mut self.store {
            Store::Dir(root) => {
                let file = File::open(root.join(path)).map_err(|e| BundleError::Open(e.to_string()))?;
                file.take(MAX_FIXTURE_BYTES + 1)
                    .read_to_string(&mut text)
                    .map_err(|e| BundleError::Open(e.to_string()))?;
            }
            Store::Zip(archive) => {
                let entry = archive.by_name(path).map_err(|e| BundleError::Open(e.to_string()))?;
                if entry.size() > MAX_FIXTURE_BYTES {
                    return Err(BundleError::TooLarge);
                }
                entry
                    .take(MAX_FIXTURE_BYTES + 1)
                    .read_to_string(&mut text)
                    .map_err(|e| BundleError::Open(e.to_string()))?;
            }
        }
        if text.len() as u64 > MAX_FIXTURE_BYTES {
            return Err(BundleError::TooLarge);
        }
        Ok(text)
    }
}

/// 递归收集文件夹里的 JSON 文件（跳过隐藏目录与 `node_modules`）。
fn walk_dir(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Candidate>) -> Result<(), BundleError> {
    if depth > MAX_DIR_DEPTH {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| BundleError::Open(e.to_string()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            walk_dir(root, &path, depth + 1, out)?;
        } else if kind.is_file() && name.to_ascii_lowercase().ends_with(".json") {
            let size = entry.metadata().map_or(0, |m| m.len());
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            out.push(Candidate { path: rel, size });
            if out.len() > MAX_BUNDLE_FIXTURES + 1 {
                return Err(BundleError::TooLarge);
            }
        }
    }
    Ok(())
}

/// 从候选文件里挑出灯具：有 `fixtures/` 目录时只取其中的 `制造商/灯具.json`，否则取最后两级路径。
fn pick_fixtures(candidates: &[Candidate]) -> (BTreeMap<String, String>, Option<String>) {
    let segments = |p: &str| p.split('/').filter(|s| !s.is_empty()).map(str::to_owned).collect::<Vec<_>>();
    let in_fixtures = |segs: &[String]| segs.len() >= 3 && segs[segs.len() - 3] == "fixtures";
    // 有多个 `fixtures` 目录时（例如仓库里的测试数据），取灯具最多的那个
    let prefix_of = |segs: &[String]| segs[..segs.len() - 2].join("/");
    let mut prefixes: HashMap<String, usize> = HashMap::new();
    for c in candidates {
        let segs = segments(&c.path);
        if in_fixtures(&segs) {
            *prefixes.entry(prefix_of(&segs)).or_default() += 1;
        }
    }
    let main_prefix = prefixes.into_iter().max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.len().cmp(&a.0.len()))).map(|p| p.0);
    let has_fixtures_dir = main_prefix.is_some();
    let in_main = |segs: &[String]| in_fixtures(segs) && main_prefix.as_deref() == Some(prefix_of(segs).as_str());
    let mut files = BTreeMap::new();
    let mut manufacturers = None;
    for c in candidates {
        let segs = segments(&c.path);
        let file = segs.last().map_or("", String::as_str);
        if file == "manufacturers.json" {
            // 优先取 fixtures/manufacturers.json
            if manufacturers.is_none() || segs.len() >= 2 && segs[segs.len() - 2] == "fixtures" {
                manufacturers = Some(c.path.clone());
            }
            continue;
        }
        if segs.len() < 2 || file == "register.json" || file.starts_with('$') {
            continue;
        }
        if has_fixtures_dir && !in_main(&segs) {
            continue;
        }
        let stem = file.strip_suffix(".json").unwrap_or(file);
        let key = format!("{}/{stem}", segs[segs.len() - 2]);
        files.entry(key).or_insert_with(|| c.path.clone());
    }
    (files, manufacturers)
}

fn fingerprint_of(path: &Path, meta: &std::fs::Metadata, total: u64, count: usize) -> String {
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    if meta.is_dir() {
        format!("dir:{count}:{total}")
    } else {
        format!("zip:{}:{mtime}:{}", meta.len(), path.display())
    }
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

/// 目录里一个模式的摘要。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct CatalogMode {
    /// 模式名。
    pub name: String,
    /// 占用的通道数（矩阵插入块按像素数估算）。
    pub channels: u16,
}

/// 目录里的一个灯具。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct CatalogEntry {
    /// 灯具标识（`制造商/灯具`）。
    pub key: String,
    /// 制造商标识（目录名）。
    pub manufacturer_key: String,
    /// 制造商显示名。
    pub manufacturer: String,
    /// 灯具名。
    pub name: String,
    /// OFL 分类，例如 `Moving Head`。
    #[serde(default)]
    pub categories: Vec<String>,
    /// 各模式摘要。
    #[serde(default)]
    pub modes: Vec<CatalogMode>,
    /// 是否是像素 / 矩阵灯。
    #[serde(default)]
    pub matrix: bool,
    /// 重定向文件：最终指向的灯具标识（已解析整条链）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub redirect_to: Option<String>,
    /// 最后修改日期（OFL `meta.lastModifyDate`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub last_modified: Option<String>,
}

/// 目录里的一个制造商。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct CatalogManufacturer {
    /// 制造商标识（目录名）。
    pub key: String,
    /// 显示名。
    pub name: String,
    /// 灯具数（含重定向）。
    pub count: u32,
}

/// 一个 OFL 包的目录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    /// 目录格式版本（[`CATALOG_VERSION`]）。
    pub version: u32,
    /// 包的路径。
    pub source: String,
    /// 包的指纹（见 [`OflBundle::fingerprint`]）。
    pub fingerprint: String,
    /// 制造商，按显示名排序。
    pub manufacturers: Vec<CatalogManufacturer>,
    /// 灯具，按制造商与名称排序。
    pub entries: Vec<CatalogEntry>,
    /// 无法解析或重定向目标缺失的文件（灯具标识）。
    #[serde(default)]
    pub broken: Vec<String>,
}

/// 读取包里全部灯具，建立目录。
///
/// # Arguments
///
/// * `bundle` - 打开的包。
/// * `source` - 包的路径（写入目录，供之后重新打开）。
/// * `progress` - 进度回调：`(已处理, 总数)`。
///
/// # Returns
///
/// 目录。
pub fn build_catalog(bundle: &mut OflBundle, source: &str, progress: &mut dyn FnMut(usize, usize)) -> Catalog {
    let names = bundle.manufacturers();
    let keys: Vec<String> = bundle.keys().map(str::to_owned).collect();
    let total = keys.len();
    let mut entries: Vec<CatalogEntry> = Vec::with_capacity(total);
    let mut broken = Vec::new();
    for (i, key) in keys.iter().enumerate() {
        match bundle.read(key).ok().and_then(|text| catalog_entry(key, &text, &names)) {
            Some(e) => entries.push(e),
            None => broken.push(key.clone()),
        }
        progress(i + 1, total);
    }

    // 重定向：沿链找到最终的真实灯具，并借用它的名称以外的摘要
    let real: HashMap<String, usize> =
        entries.iter().enumerate().filter(|(_, e)| e.redirect_to.is_none()).map(|(i, e)| (e.key.clone(), i)).collect();
    let next: HashMap<String, String> =
        entries.iter().filter_map(|e| e.redirect_to.clone().map(|t| (e.key.clone(), t))).collect();
    let mut resolved: Vec<(usize, Option<String>)> = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        let Some(first) = &e.redirect_to else { continue };
        let mut target = first.clone();
        let mut seen = HashSet::new();
        let mut ok = false;
        for _ in 0..MAX_REDIRECT_DEPTH {
            if real.contains_key(&target) {
                ok = true;
                break;
            }
            if !seen.insert(target.clone()) {
                break;
            }
            match next.get(&target) {
                Some(t) => target.clone_from(t),
                None => break,
            }
        }
        resolved.push((i, ok.then_some(target)));
    }
    let mut drop_idx = HashSet::new();
    for (i, target) in resolved {
        if let Some(t) = target {
            let src = &entries[real[&t]];
            let (categories, modes, matrix) = (src.categories.clone(), src.modes.clone(), src.matrix);
            let e = &mut entries[i];
            e.redirect_to = Some(t);
            e.categories = categories;
            e.modes = modes;
            e.matrix = matrix;
        } else {
            broken.push(entries[i].key.clone());
            drop_idx.insert(i);
        }
    }
    let mut entries: Vec<CatalogEntry> =
        entries.into_iter().enumerate().filter(|(i, _)| !drop_idx.contains(i)).map(|(_, e)| e).collect();
    entries.sort_by(|a, b| {
        a.manufacturer.to_lowercase().cmp(&b.manufacturer.to_lowercase()).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let mut counts: BTreeMap<String, (String, u32)> = BTreeMap::new();
    for e in &entries {
        counts.entry(e.manufacturer_key.clone()).or_insert_with(|| (e.manufacturer.clone(), 0)).1 += 1;
    }
    let mut manufacturers: Vec<CatalogManufacturer> =
        counts.into_iter().map(|(key, (name, count))| CatalogManufacturer { key, name, count }).collect();
    manufacturers.sort_by_key(|m| m.name.to_lowercase());
    broken.sort();
    Catalog {
        version: CATALOG_VERSION,
        source: source.to_owned(),
        fingerprint: bundle.fingerprint().to_owned(),
        manufacturers,
        entries,
        broken,
    }
}

/// 目录项在灯具库里的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum CatalogStatus {
    /// 库里还没有。
    New,
    /// 已导入，且是用当前识别规则导入的。
    Imported,
    /// 已导入，但识别规则比当前旧（或来源不明），可以重新导入。
    Outdated,
}

/// 目录查询条件。
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct CatalogQuery {
    /// 搜索词：按空白分词，每个词都要出现在名称、制造商、标识或分类里（忽略大小写）。
    #[serde(default)]
    pub text: String,
    /// 只看某个制造商（标识）。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub manufacturer: Option<String>,
    /// 只看某个分类。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub category: Option<String>,
    /// 只看某种状态。
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub status: Option<CatalogStatus>,
    /// 分页起点。
    #[serde(default)]
    pub offset: u32,
    /// 每页条数（上限 500）。
    #[serde(default)]
    pub limit: u32,
}

/// 查询结果里的一项。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct CatalogItem {
    /// 目录项。
    #[serde(flatten)]
    pub entry: CatalogEntry,
    /// 导入后的模型编号（重定向项为目标灯具的编号）。
    pub model_id: String,
    /// 在灯具库里的状态。
    pub status: CatalogStatus,
}

/// 一页查询结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct CatalogPage {
    /// 符合条件的总数。
    pub total: u32,
    /// 本页条目。
    pub items: Vec<CatalogItem>,
}

/// 目录概况（打开包之后显示，以及筛选下拉框的选项）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct CatalogSummary {
    /// 包的路径。
    pub source: String,
    /// 灯具数（含重定向）。
    pub entries: u32,
    /// 其中的重定向数。
    pub redirects: u32,
    /// 无法解析的文件数。
    pub broken: u32,
    /// 制造商。
    pub manufacturers: Vec<CatalogManufacturer>,
    /// 全部分类（按字母序）。
    pub categories: Vec<String>,
}

/// 目录项导入后的模型编号（重定向项取目标灯具）。
///
/// # Arguments
///
/// * `entry` - 目录项。
///
/// # Returns
///
/// `ofl:` 开头的模型编号，与 [`super::import_ofl`] 生成的一致。
#[must_use]
pub fn entry_model_id(entry: &CatalogEntry) -> String {
    super::ofl::ofl_model_id(entry.redirect_to.as_deref().unwrap_or(&entry.key))
}

/// 每页条数上限。
const MAX_PAGE: u32 = 500;

impl Catalog {
    /// 目录概况。
    ///
    /// # Returns
    ///
    /// 灯具数、制造商与分类。
    #[must_use]
    pub fn summary(&self) -> CatalogSummary {
        let mut categories: Vec<String> =
            self.entries.iter().flat_map(|e| e.categories.iter().cloned()).collect::<HashSet<_>>().into_iter().collect();
        categories.sort();
        CatalogSummary {
            source: self.source.clone(),
            entries: self.entries.len() as u32,
            redirects: self.entries.iter().filter(|e| e.redirect_to.is_some()).count() as u32,
            broken: self.broken.len() as u32,
            manufacturers: self.manufacturers.clone(),
            categories,
        }
    }

    /// 符合条件的全部条目（不分页）。
    fn matching<'a>(
        &'a self,
        q: &'a CatalogQuery,
        status_of: &'a dyn Fn(&str) -> CatalogStatus,
    ) -> impl Iterator<Item = (&'a CatalogEntry, String, CatalogStatus)> + 'a {
        let words: Vec<String> = q.text.split_whitespace().map(str::to_lowercase).collect();
        self.entries.iter().filter_map(move |e| {
            if q.manufacturer.as_ref().is_some_and(|m| *m != e.manufacturer_key) {
                return None;
            }
            if q.category.as_ref().is_some_and(|c| !e.categories.contains(c)) {
                return None;
            }
            if !words.is_empty() {
                let hay = format!("{} {} {} {}", e.name, e.manufacturer, e.key, e.categories.join(" ")).to_lowercase();
                if !words.iter().all(|w| hay.contains(w.as_str())) {
                    return None;
                }
            }
            let id = entry_model_id(e);
            let status = status_of(&id);
            if q.status.is_some_and(|s| s != status) {
                return None;
            }
            Some((e, id, status))
        })
    }

    /// 分页查询。
    ///
    /// # Arguments
    ///
    /// * `q` - 查询条件。
    /// * `status_of` - 按模型编号判断库里的状态。
    ///
    /// # Returns
    ///
    /// 总数与本页条目。
    #[must_use]
    pub fn search(&self, q: &CatalogQuery, status_of: &dyn Fn(&str) -> CatalogStatus) -> CatalogPage {
        let limit = if q.limit == 0 { 50 } else { q.limit.min(MAX_PAGE) } as usize;
        let mut total = 0u32;
        let mut items = Vec::new();
        for (e, model_id, status) in self.matching(q, status_of) {
            if total as usize >= q.offset as usize && items.len() < limit {
                items.push(CatalogItem { entry: e.clone(), model_id, status });
            }
            total += 1;
        }
        CatalogPage { total, items }
    }

    /// 符合条件的全部灯具标识（“全选当前筛选结果”用，忽略分页）。
    ///
    /// # Arguments
    ///
    /// * `q` - 查询条件。
    /// * `status_of` - 按模型编号判断库里的状态。
    ///
    /// # Returns
    ///
    /// 灯具标识。
    #[must_use]
    pub fn matching_keys(&self, q: &CatalogQuery, status_of: &dyn Fn(&str) -> CatalogStatus) -> Vec<String> {
        self.matching(q, status_of).map(|(e, _, _)| e.key.clone()).collect()
    }
}

/// 由灯具 JSON 生成目录项；不是合法的灯具或重定向文件时为 `None`。
fn catalog_entry(key: &str, text: &str, names: &HashMap<String, String>) -> Option<CatalogEntry> {
    let root: Value = serde_json::from_str(text).ok()?;
    let root = root.as_object()?;
    let manufacturer_key = key.split('/').next().unwrap_or_default().to_owned();
    let manufacturer = names.get(&manufacturer_key).cloned().unwrap_or_else(|| manufacturer_key.clone());
    let name = root.get("name").and_then(Value::as_str).unwrap_or(key).to_owned();
    let redirect_to = root.get("redirectTo").and_then(Value::as_str).map(str::to_owned);
    if redirect_to.is_none() && !root.contains_key("modes") {
        return None;
    }
    let categories = root
        .get("categories")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let matrix = root.get("matrix").and_then(Value::as_object);
    let pixel_count = matrix.map_or(0, matrix_pixels);
    let group_count = matrix.and_then(|m| m.get("pixelGroups")).and_then(Value::as_object).map_or(0, Map::len);
    let modes = root
        .get("modes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|m| CatalogMode {
            name: m.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
            channels: mode_channels(m, pixel_count, group_count),
        })
        .collect();
    let last_modified =
        root.get("meta").and_then(|m| m.get("lastModifyDate")).and_then(Value::as_str).map(str::to_owned);
    Some(CatalogEntry {
        key: key.to_owned(),
        manufacturer_key,
        manufacturer,
        name,
        categories,
        modes,
        matrix: matrix.is_some(),
        redirect_to,
        last_modified,
    })
}

/// 矩阵的像素数（`pixelCount` 之积或 `pixelKeys` 里非空的格子数）。
fn matrix_pixels(m: &Map<String, Value>) -> usize {
    if let Some(c) = m.get("pixelCount").and_then(Value::as_array) {
        return c.iter().filter_map(Value::as_u64).map(|v| v.max(1) as usize).product();
    }
    m.get("pixelKeys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(Value::as_array)
        .flatten()
        .filter(|v| v.is_string())
        .count()
}

/// 模式的通道数（矩阵插入块 = 模板数 × 重复次数）。
fn mode_channels(mode: &Map<String, Value>, pixels: usize, groups: usize) -> u16 {
    let mut n = 0usize;
    for ch in mode.get("channels").and_then(Value::as_array).into_iter().flatten() {
        n += match ch {
            Value::Object(ins) => {
                let templates = ins.get("templateChannels").and_then(Value::as_array).map_or(0, Vec::len);
                let repeat = match ins.get("repeatFor") {
                    Some(Value::Array(a)) => a.len(),
                    Some(Value::String(s)) if s == "eachPixelGroup" => groups,
                    Some(Value::String(_)) => pixels,
                    _ => 0,
                };
                templates * repeat
            }
            _ => 1,
        };
    }
    u16::try_from(n).unwrap_or(u16::MAX)
}

// ---------------------------------------------------------------------------
// 批量导入
// ---------------------------------------------------------------------------

/// 批量导入的结果：解析出的模型、警告，以及每个失败灯具的错误码。
#[derive(Debug, Default)]
pub struct BundleImport {
    /// 合并前的导入结果（模型与警告）。
    pub report: ImportReport,
    /// `(灯具标识, 错误码)`。
    pub failed: Vec<(String, String)>,
}

/// 从包里导入若干灯具；重定向项导入它最终指向的灯具（同一目标只导入一次）。
///
/// # Arguments
///
/// * `bundle` - 打开的包（应与 `catalog` 指纹一致）。
/// * `catalog` - 包的目录（解析重定向与制造商名）。
/// * `keys` - 要导入的灯具标识。
/// * `progress` - 进度回调：`(已处理, 总数)`。
///
/// # Returns
///
/// 全部模型与警告；单个灯具失败不影响其它灯具。
pub fn import_from_bundle(
    bundle: &mut OflBundle,
    catalog: &Catalog,
    keys: &[String],
    progress: &mut dyn FnMut(usize, usize),
) -> BundleImport {
    let by_key: HashMap<&str, &CatalogEntry> = catalog.entries.iter().map(|e| (e.key.as_str(), e)).collect();
    let mut out = BundleImport::default();
    let mut done: HashSet<String> = HashSet::new();
    for (i, key) in keys.iter().enumerate() {
        progress(i + 1, keys.len());
        let entry = by_key.get(key.as_str());
        let target = entry.and_then(|e| e.redirect_to.clone()).unwrap_or_else(|| key.clone());
        if !done.insert(target.clone()) {
            continue;
        }
        let manufacturer = by_key.get(target.as_str()).map(|e| e.manufacturer.clone());
        let result = bundle
            .read(&target)
            .map_err(|e| e.code().to_owned())
            .and_then(|text| import_ofl_as(&text, &target, manufacturer.as_deref()).map_err(|e| e.code()));
        match result {
            Ok(report) => {
                out.report.models.extend(report.models);
                out.report.warnings.extend(report.warnings);
            }
            Err(code) => {
                if code == ImportError::NoModels.code() {
                    out.report.warnings.push(ImportWarning {
                        kind: ImportWarningKind::InvalidModel,
                        sheet: "OFL".into(),
                        row: None,
                        model_id: Some(target.clone()),
                        detail: Some("no_modes".into()),
                    });
                }
                out.failed.push((key.clone(), code));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;

    use super::*;

    const SPOT: &str = r#"{"name":"Spot","categories":["Moving Head"],"meta":{"lastModifyDate":"2024-01-02"},
      "matrix":{"pixelCount":[3,1,1]},
      "availableChannels":{"Dim":{"capability":{"type":"Intensity"}}},
      "templateChannels":{"Red $pixelKey":{"capability":{"type":"ColorIntensity","color":"Red"}}},
      "modes":[{"name":"4ch","channels":["Dim",{"insert":"matrixChannels","repeatFor":"eachPixelXYZ","channelOrder":"perPixel","templateChannels":["Red $pixelKey"]}]}]}"#;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ofl-bundle-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn write_zip(path: &Path, files: &[(&str, &str)]) {
        let mut zip = zip::ZipWriter::new(File::create(path).expect("建 zip"));
        for (name, text) in files {
            zip.start_file(*name, SimpleFileOptions::default()).expect("写条目");
            zip.write_all(text.as_bytes()).expect("写内容");
        }
        zip.finish().expect("完成 zip");
    }

    fn sample_files() -> Vec<(&'static str, &'static str)> {
        vec![
            ("ofl-master/fixtures/manufacturers.json", r#"{"$schema":"x","acme":{"name":"ACME Lighting"}}"#),
            ("ofl-master/fixtures/acme/spot.json", SPOT),
            ("ofl-master/fixtures/acme/old-spot.json", r#"{"name":"Old Spot","redirectTo":"acme/older","reason":"FixtureRenamed"}"#),
            ("ofl-master/fixtures/acme/older.json", r#"{"name":"Older","redirectTo":"acme/spot","reason":"FixtureRenamed"}"#),
            ("ofl-master/fixtures/acme/loop-a.json", r#"{"name":"A","redirectTo":"acme/loop-b"}"#),
            ("ofl-master/fixtures/acme/loop-b.json", r#"{"name":"B","redirectTo":"acme/loop-a"}"#),
            ("ofl-master/fixtures/acme/broken.json", "{nope"),
            ("ofl-master/tests/fixtures/acme/ignored.json", SPOT),
        ]
    }

    #[test]
    fn zip_包建目录_制造商名与重定向链() {
        let dir = temp_dir("zip");
        let path = dir.join("ofl.zip");
        write_zip(&path, &sample_files());
        let mut bundle = OflBundle::open(&path).expect("应能打开");
        let keys: Vec<&str> = bundle.keys().collect();
        assert!(!keys.contains(&"acme/ignored"), "fixtures 目录之外的文件不算灯具");
        let catalog = build_catalog(&mut bundle, &path.to_string_lossy(), &mut |_, _| {});
        let spot = catalog.entries.iter().find(|e| e.key == "acme/spot").expect("spot");
        assert_eq!(spot.manufacturer, "ACME Lighting");
        assert_eq!(spot.modes, vec![CatalogMode { name: "4ch".into(), channels: 4 }]);
        assert!(spot.matrix);
        assert_eq!(spot.last_modified.as_deref(), Some("2024-01-02"));
        let old = catalog.entries.iter().find(|e| e.key == "acme/old-spot").expect("old");
        assert_eq!(old.redirect_to.as_deref(), Some("acme/spot"), "两级重定向解析到最终灯具");
        assert_eq!(old.modes.len(), 1);
        assert_eq!(catalog.broken, vec!["acme/broken", "acme/loop-a", "acme/loop-b"]);
        assert_eq!(catalog.manufacturers, vec![CatalogManufacturer { key: "acme".into(), name: "ACME Lighting".into(), count: 3 }]);

        let keys = vec!["acme/old-spot".to_owned(), "acme/spot".to_owned(), "acme/broken".to_owned()];
        let result = import_from_bundle(&mut bundle, &catalog, &keys, &mut |_, _| {});
        assert_eq!(result.report.models.len(), 1, "重定向与原灯具只导入一次");
        let m = &result.report.models[0];
        assert_eq!((m.id.as_str(), m.manufacturer.as_str()), ("ofl:acme/spot", "ACME Lighting"));
        assert_eq!(result.failed, vec![("acme/broken".to_owned(), "import_failed:open".to_owned())]);

        // 查询：搜索词、状态与分页
        let status = |id: &str| if id == "ofl:acme/spot" { CatalogStatus::Outdated } else { CatalogStatus::New };
        let page = catalog.search(&CatalogQuery { text: "acme spot".into(), limit: 1, ..CatalogQuery::default() }, &status);
        assert_eq!(page.total, 2, "Spot 与指向它的 Old Spot");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].model_id, "ofl:acme/spot");
        assert_eq!(page.items[0].status, CatalogStatus::Outdated);
        let outdated = CatalogQuery { status: Some(CatalogStatus::Outdated), ..CatalogQuery::default() };
        assert_eq!(catalog.matching_keys(&outdated, &status).len(), 3, "三个条目都指向同一模型");
        let none = CatalogQuery { category: Some("Laser".into()), ..CatalogQuery::default() };
        assert_eq!(catalog.search(&none, &status).total, 0);
        let summary = catalog.summary();
        assert_eq!((summary.entries, summary.redirects, summary.broken), (3, 2, 3));
        assert_eq!(summary.categories, vec!["Moving Head"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 文件夹包与指纹() {
        let dir = temp_dir("dir");
        std::fs::create_dir_all(dir.join("acme")).expect("建目录");
        std::fs::write(dir.join("acme/spot.json"), SPOT).expect("写文件");
        std::fs::write(dir.join("manufacturers.json"), r#"{"acme":{"name":"ACME"}}"#).expect("写文件");
        let mut bundle = OflBundle::open(&dir).expect("应能打开");
        assert_eq!(bundle.keys().collect::<Vec<_>>(), vec!["acme/spot"]);
        assert_eq!(bundle.manufacturers().get("acme").map(String::as_str), Some("ACME"));
        let before = bundle.fingerprint().to_owned();
        std::fs::write(dir.join("acme/bar.json"), SPOT).expect("写文件");
        assert_ne!(OflBundle::open(&dir).expect("应能打开").fingerprint(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 空包与非法路径() {
        let dir = temp_dir("empty");
        let path = dir.join("e.zip");
        write_zip(&path, &[("readme.txt", "x")]);
        assert_eq!(OflBundle::open(&path).err(), Some(BundleError::Empty));
        assert!(matches!(OflBundle::open(&dir.join("missing.zip")), Err(BundleError::Open(_))));
        std::fs::write(dir.join("bad.zip"), b"not a zip").expect("写文件");
        assert!(matches!(OflBundle::open(&dir.join("bad.zip")), Err(BundleError::Open(_))));
        let mut b = OflBundle::open(&{
            let p = dir.join("one.zip");
            write_zip(&p, &[("x/acme/spot.json", SPOT)]);
            p
        })
        .expect("应能打开");
        assert_eq!(b.read("acme/nope").err(), Some(BundleError::NotFound("acme/nope".into())));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
