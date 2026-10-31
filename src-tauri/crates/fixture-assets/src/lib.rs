//! 灯具资源库：2D 图标与 3D 模型按内容散列存放在 `data/fixture-assets/`。
//!
//! ```text
//! fixture-assets/
//!   index.json              索引：散列 → 种类、格式、大小、原始文件名、三角面数、包围盒、导入时间
//!   icons/<sha256>.svg|png|webp
//!   models/<sha256>.glb      3D 文件在前端规整后统一保存为 GLB
//!   thumbs/<sha256>.webp     3D 模型的缩略图（文件名是模型的散列）
//! ```
//!
//! - 文件名就是内容的 SHA-256（64 位小写十六进制），同样的内容只存一份；灯具模型里只记散列。
//! - 写入前按内容校验格式与大小（见 [`check_content`]），SVG 拒绝脚本、事件属性与外部引用。
//! - 索引丢失或损坏时按磁盘上的文件重建（原始文件名丢失，其余信息可恢复）。
//! - 清理未引用资源时，文件先挪进一个暂存目录交给调用方放进回收站，不直接删除。

mod validate;

use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use show_engine::fixture::{is_sha256_hex, AssetFormat};
use thiserror::Error;

pub use validate::{check_content, max_bytes, MAX_GLB_BYTES, MAX_RASTER_BYTES, MAX_SVG_BYTES, MAX_THUMB_BYTES};

/// 索引文件格式版本。
const INDEX_VERSION: u32 = 1;
/// 索引文件名。
const INDEX_FILE: &str = "index.json";
/// 资源库最多的资源数。
pub const MAX_ASSETS: usize = 4096;
/// 原始文件名最多保留的字符数。
const MAX_NAME_CHARS: usize = 255;

/// 资源库操作失败。
#[derive(Debug, Error)]
pub enum AssetError {
    /// 文件头与声明的格式不符、为空或不是合法文本。
    #[error("资源格式不对")]
    BadFormat,
    /// 超过大小上限。
    #[error("资源文件太大")]
    TooLarge,
    /// SVG 含脚本、事件属性或外部引用。
    #[error("SVG 含不安全的内容")]
    UnsafeSvg,
    /// 资源数达到上限。
    #[error("资源库已满")]
    Full,
    /// 资源不存在。
    #[error("资源不存在")]
    NotFound,
    /// 读写失败。
    #[error("读写资源失败：{0}")]
    Io(#[from] io::Error),
}

impl PartialEq for AssetError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code()
    }
}

impl AssetError {
    /// 机器可读的错误码，前端据此选择本地化文案。
    ///
    /// # Returns
    ///
    /// `bad_format`、`too_large`、`unsafe_svg`、`full`、`not_found` 或 `io`。
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadFormat => "bad_format",
            Self::TooLarge => "too_large",
            Self::UnsafeSvg => "unsafe_svg",
            Self::Full => "full",
            Self::NotFound => "not_found",
            Self::Io(_) => "io",
        }
    }
}

/// 资源的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum AssetKind {
    /// 2D 图标（SVG / PNG / WebP）。
    Icon,
    /// 灯具的 3D 模型（GLB）。
    Model,
    /// 图案（gobo）图片（SVG / PNG / WebP），3D 舞台投射到光束与光斑上。
    Gobo,
    /// 场馆 / 舞台布景的 3D 模型（GLB），作为 3D 舞台的背景。
    Venue,
}

/// 全部种类（重建索引、放行目录时遍历）。
pub const ASSET_KINDS: [AssetKind; 4] = [AssetKind::Icon, AssetKind::Model, AssetKind::Gobo, AssetKind::Venue];

impl AssetKind {
    /// 格式的默认种类（没有声明种类时）。
    ///
    /// # Arguments
    ///
    /// * `format` - 资源格式。
    ///
    /// # Returns
    ///
    /// GLB 为 [`AssetKind::Model`]，其余为 [`AssetKind::Icon`]。
    #[must_use]
    pub fn of(format: AssetFormat) -> Self {
        if format == AssetFormat::Glb { Self::Model } else { Self::Icon }
    }

    /// 这一种资源能不能用这个格式：图标 / 图案是图片，模型 / 场馆是 GLB。
    ///
    /// # Arguments
    ///
    /// * `format` - 资源格式。
    ///
    /// # Returns
    ///
    /// 相符时为 `true`。
    #[must_use]
    pub fn accepts(self, format: AssetFormat) -> bool {
        match self {
            Self::Icon | Self::Gobo => format.is_image(),
            Self::Model | Self::Venue => format == AssetFormat::Glb,
        }
    }

    /// 存放这一种资源的子目录名。
    fn dir(self) -> &'static str {
        match self {
            Self::Icon => "icons",
            Self::Model => "models",
            Self::Gobo => "gobos",
            Self::Venue => "venues",
        }
    }

    /// 是否有缩略图（3D 文件）。
    fn has_thumb(self) -> bool {
        matches!(self, Self::Model | Self::Venue)
    }
}

/// 3D 模型导入时由前端测得的信息。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ModelStats {
    /// 三角面数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub tris: Option<u32>,
    /// 包围盒 `[宽, 高, 深]`（毫米，规整后）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub bbox_mm: Option<[f64; 3]>,
    /// 模型里有名为 `pan` / `tilt` 的关节节点（摇头灯可按通道转动）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub jointed: bool,
}

/// 资源库里的一个文件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AssetInfo {
    /// 内容散列（SHA-256，64 位小写十六进制）。
    pub hash: String,
    /// 种类。
    pub kind: AssetKind,
    /// 格式。
    pub format: AssetFormat,
    /// 文件大小（字节）。
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub bytes: u64,
    /// 原始文件名（只用于显示；索引重建后为空）。
    #[serde(default)]
    pub name: String,
    /// 导入时间（Unix 毫秒）。
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub created_at_ms: u64,
    /// 3D 模型的信息（图标为空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub stats: Option<ModelStats>,
    /// 有没有缩略图（3D 模型）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub thumb: bool,
}

impl AssetInfo {
    /// 文件名：`<散列>.<扩展名>`。
    fn file_name(&self) -> String {
        format!("{}.{}", self.hash, self.format.extension())
    }
}

/// 索引文件。
#[derive(Debug, Default, Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    assets: Vec<AssetInfo>,
}

/// 清理未引用资源的结果。
#[derive(Debug, Default)]
pub struct Cleanup {
    /// 被挪走的资源。
    pub removed: Vec<AssetInfo>,
    /// 暂存目录（交给调用方放进回收站）；没有挪走任何文件时为 `None`。
    pub staging: Option<PathBuf>,
}

/// 资源库。
pub struct AssetStore {
    dir: PathBuf,
    /// 散列 → 资源（按散列排序，列表稳定）。
    assets: BTreeMap<String, AssetInfo>,
}

/// 内容的 SHA-256（64 位小写十六进制）。
///
/// # Arguments
///
/// * `bytes` - 内容。
///
/// # Returns
///
/// 散列字符串。
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push(char::from(b"0123456789abcdef"[usize::from(b >> 4)]));
        s.push(char::from(b"0123456789abcdef"[usize::from(b & 0x0f)]));
    }
    s
}

/// 按扩展名识别格式（重建索引用）。
fn format_of_ext(ext: &str) -> Option<AssetFormat> {
    match ext {
        "svg" => Some(AssetFormat::Svg),
        "png" => Some(AssetFormat::Png),
        "webp" => Some(AssetFormat::Webp),
        "glb" => Some(AssetFormat::Glb),
        _ => None,
    }
}

impl AssetStore {
    /// 打开资源库（目录不存在时在第一次写入时创建）；索引缺失或损坏时按磁盘上的文件重建。
    ///
    /// # Arguments
    ///
    /// * `dir` - 资源库目录（`data/fixture-assets`）。
    ///
    /// # Returns
    ///
    /// 资源库。
    #[must_use]
    pub fn open(dir: PathBuf) -> Self {
        let from_index = std::fs::read(dir.join(INDEX_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice::<IndexFile>(&b).ok())
            .filter(|f| f.version == INDEX_VERSION);
        let mut store = Self { dir, assets: BTreeMap::new() };
        match from_index {
            Some(index) => {
                for a in index.assets {
                    // 索引里有、磁盘上没有的条目丢掉
                    if is_sha256_hex(&a.hash) && store.file_path(&a).is_file() {
                        store.assets.insert(a.hash.clone(), a);
                    }
                }
            }
            None => store.rebuild(),
        }
        store
    }

    /// 按磁盘上的文件重建索引（原始文件名与 3D 信息丢失）。
    fn rebuild(&mut self) {
        for kind in ASSET_KINDS {
            let Ok(read) = std::fs::read_dir(self.dir.join(kind.dir())) else { continue };
            for entry in read.flatten() {
                let path = entry.path();
                let (Some(stem), Some(ext)) = (path.file_stem().and_then(|s| s.to_str()), path.extension().and_then(|s| s.to_str())) else {
                    continue;
                };
                let Some(format) = format_of_ext(ext).filter(|f| kind.accepts(*f)) else { continue };
                if !is_sha256_hex(stem) {
                    continue;
                }
                let bytes = entry.metadata().map_or(0, |m| m.len());
                let thumb = kind.has_thumb() && self.thumb_path(stem).is_file();
                self.assets.insert(
                    stem.to_owned(),
                    AssetInfo { hash: stem.to_owned(), kind, format, bytes, name: String::new(), created_at_ms: 0, stats: None, thumb },
                );
            }
        }
        if !self.assets.is_empty() {
            tracing::warn!(count = self.assets.len(), "资源库索引缺失或损坏，已按文件重建");
            let _ = self.save_index();
        }
    }

    /// 资源库目录。
    ///
    /// # Returns
    ///
    /// 目录路径。
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 存放某一种资源的子目录。
    ///
    /// # Arguments
    ///
    /// * `kind` - 种类。
    ///
    /// # Returns
    ///
    /// `icons/` 或 `models/` 的路径。
    #[must_use]
    pub fn kind_dir(&self, kind: AssetKind) -> PathBuf {
        self.dir.join(kind.dir())
    }

    /// 缩略图目录。
    ///
    /// # Returns
    ///
    /// `thumbs/` 的路径。
    #[must_use]
    pub fn thumbs_dir(&self) -> PathBuf {
        self.dir.join("thumbs")
    }

    /// 资源文件的路径。
    ///
    /// # Arguments
    ///
    /// * `info` - 资源。
    ///
    /// # Returns
    ///
    /// 文件路径。
    #[must_use]
    pub fn file_path(&self, info: &AssetInfo) -> PathBuf {
        self.kind_dir(info.kind).join(info.file_name())
    }

    /// 某个 3D 模型的缩略图路径。
    ///
    /// # Arguments
    ///
    /// * `hash` - 模型散列。
    ///
    /// # Returns
    ///
    /// 缩略图路径（不保证存在）。
    #[must_use]
    pub fn thumb_path(&self, hash: &str) -> PathBuf {
        self.thumbs_dir().join(format!("{hash}.webp"))
    }

    /// 全部资源（按散列排序）。
    ///
    /// # Returns
    ///
    /// 资源列表。
    #[must_use]
    pub fn list(&self) -> Vec<AssetInfo> {
        self.assets.values().cloned().collect()
    }

    /// 按散列查找资源。
    ///
    /// # Arguments
    ///
    /// * `hash` - 内容散列。
    ///
    /// # Returns
    ///
    /// 资源；不存在时为 `None`。
    #[must_use]
    pub fn get(&self, hash: &str) -> Option<&AssetInfo> {
        self.assets.get(hash)
    }

    fn save_index(&self) -> io::Result<()> {
        let file = IndexFile { version: INDEX_VERSION, assets: self.list() };
        let json = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
        fsutil::write_atomic(&self.dir.join(INDEX_FILE), &json)
    }

    /// 存入一个资源：校验内容、按散列写文件（已有同样内容时不重复写）、更新索引。
    ///
    /// # Arguments
    ///
    /// * `bytes` - 文件内容。
    /// * `format` - 声明的格式（按内容核对）。
    /// * `kind` - 种类（图标 / 图案为图片，灯具模型 / 场馆为 GLB）；同样的内容已经存过时沿用原来的种类。
    /// * `name` - 原始文件名（只用于显示，超长截断）。
    /// * `stats` - 3D 文件的信息（图片忽略）。
    /// * `now_ms` - 当前时间（Unix 毫秒）。
    ///
    /// # Returns
    ///
    /// 资源（已存在时为原有条目，原始文件名为空时补上）。
    ///
    /// # Errors
    ///
    /// 内容不合格（[`AssetError::BadFormat`] / [`AssetError::TooLarge`] / [`AssetError::UnsafeSvg`]）、
    /// 资源库已满（[`AssetError::Full`]）或写盘失败（[`AssetError::Io`]）。
    pub fn put(
        &mut self,
        bytes: &[u8],
        format: AssetFormat,
        kind: AssetKind,
        name: &str,
        stats: Option<ModelStats>,
        now_ms: u64,
    ) -> Result<AssetInfo, AssetError> {
        if !kind.accepts(format) {
            return Err(AssetError::BadFormat);
        }
        let limit = if kind == AssetKind::Venue { validate::MAX_VENUE_BYTES } else { max_bytes(format) };
        validate::check_content_within(bytes, format, limit)?;
        let hash = sha256_hex(bytes);
        let name: String = name.trim().chars().take(MAX_NAME_CHARS).collect();
        if let Some(existing) = self.assets.get_mut(&hash) {
            if existing.name.is_empty() && !name.is_empty() {
                existing.name = name;
                let info = existing.clone();
                self.save_index()?;
                return Ok(info);
            }
            return Ok(existing.clone());
        }
        if self.assets.len() >= MAX_ASSETS {
            return Err(AssetError::Full);
        }
        let info = AssetInfo {
            hash: hash.clone(),
            kind,
            format,
            bytes: bytes.len() as u64,
            name,
            created_at_ms: now_ms,
            stats: if kind.has_thumb() { stats } else { None },
            thumb: false,
        };
        fsutil::write_atomic(&self.file_path(&info), bytes)?;
        self.assets.insert(hash, info.clone());
        if let Err(e) = self.save_index() {
            self.assets.remove(&info.hash);
            return Err(e.into());
        }
        Ok(info)
    }

    /// 保存 3D 模型的缩略图（覆盖旧的）。
    ///
    /// # Arguments
    ///
    /// * `hash` - 模型散列。
    /// * `bytes` - WebP 内容。
    ///
    /// # Returns
    ///
    /// 更新后的资源。
    ///
    /// # Errors
    ///
    /// 模型不存在（[`AssetError::NotFound`]）、不是 WebP 或超限、写盘失败。
    pub fn put_thumb(&mut self, hash: &str, bytes: &[u8]) -> Result<AssetInfo, AssetError> {
        validate::check_thumb(bytes)?;
        let path = self.thumb_path(hash);
        let info = self.assets.get_mut(hash).filter(|a| a.kind.has_thumb()).ok_or(AssetError::NotFound)?;
        fsutil::write_atomic(&path, bytes)?;
        info.thumb = true;
        let info = info.clone();
        self.save_index()?;
        Ok(info)
    }

    /// 把没有被引用的资源挪进一个暂存目录（`<库>/.cleanup-<时间>/`），从索引里去掉。
    ///
    /// # Arguments
    ///
    /// * `referenced` - 仍被引用的散列（灯具库与打开的工程）。
    /// * `now_ms` - 当前时间（Unix 毫秒，用于暂存目录名）。
    ///
    /// # Returns
    ///
    /// 挪走的资源与暂存目录（调用方放进回收站）。
    ///
    /// # Errors
    ///
    /// 建暂存目录、挪动文件或写索引失败时返回 [`AssetError::Io`]；已挪走的文件仍在暂存目录里。
    pub fn take_unreferenced(&mut self, referenced: &HashSet<String>, now_ms: u64) -> Result<Cleanup, AssetError> {
        let victims: Vec<AssetInfo> = self.assets.values().filter(|a| !referenced.contains(&a.hash)).cloned().collect();
        if victims.is_empty() {
            return Ok(Cleanup::default());
        }
        let staging = self.dir.join(format!(".cleanup-{now_ms}"));
        std::fs::create_dir_all(&staging)?;
        let mut removed = Vec::new();
        let mut failure = None;
        for a in victims {
            let moved = std::fs::rename(self.file_path(&a), staging.join(a.file_name()));
            if let Err(e) = moved {
                failure = Some(e);
                break;
            }
            if a.thumb {
                let _ = std::fs::rename(self.thumb_path(&a.hash), staging.join(format!("{}.thumb.webp", a.hash)));
            }
            self.assets.remove(&a.hash);
            removed.push(a);
        }
        // 索引与元数据一起写进暂存目录，便于从回收站找回
        let meta = serde_json::to_vec_pretty(&IndexFile { version: INDEX_VERSION, assets: removed.clone() }).map_err(io::Error::other)?;
        fsutil::write_atomic(&staging.join(INDEX_FILE), &meta)?;
        self.save_index()?;
        if let Some(e) = failure {
            return Err(e.into());
        }
        Ok(Cleanup { removed, staging: Some(staging) })
    }
}

#[cfg(test)]
mod tests {
    use super::validate::tests::{tiny_glb, tiny_webp};
    use super::*;

    const SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>"#;

    #[test]
    fn 同样内容只存一份_索引可重建() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fixture-assets");
        let mut store = AssetStore::open(dir.clone());
        let a = store.put(SVG, AssetFormat::Svg, AssetKind::Icon, "", None, 1).unwrap();
        let b = store.put(SVG, AssetFormat::Svg, AssetKind::Icon, "spot.svg", None, 2).unwrap();
        assert_eq!(a.hash, b.hash);
        assert_eq!(b.name, "spot.svg", "重复导入时补上原始文件名");
        assert_eq!(b.created_at_ms, 1);
        assert_eq!(a.hash, sha256_hex(SVG));
        assert!(dir.join("icons").join(format!("{}.svg", a.hash)).is_file());

        let stats = ModelStats { tris: Some(12), bbox_mm: Some([300.0, 400.0, 200.0]), jointed: true };
        let m = store.put(&tiny_glb(), AssetFormat::Glb, AssetKind::Model, "spot.glb", Some(stats.clone()), 3).unwrap();
        assert_eq!((m.kind, m.stats.as_ref()), (AssetKind::Model, Some(&stats)));
        let m = store.put_thumb(&m.hash, &tiny_webp()).unwrap();
        assert!(m.thumb);
        assert_eq!(store.put_thumb(&a.hash, &tiny_webp()).map(|_| ()), Err(AssetError::NotFound));
        assert_eq!(store.list().len(), 2);

        // 重新打开读索引；删掉索引后按文件重建（名字丢失，缩略图仍在）
        let reopened = AssetStore::open(dir.clone());
        assert_eq!(reopened.list(), store.list());
        std::fs::remove_file(dir.join(INDEX_FILE)).unwrap();
        let rebuilt = AssetStore::open(dir.clone());
        assert_eq!(rebuilt.list().len(), 2);
        let model = rebuilt.get(&m.hash).unwrap();
        assert!(model.thumb && model.name.is_empty());
    }

    #[test]
    fn 拒绝不合格的内容() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = AssetStore::open(tmp.path().to_path_buf());
        assert_eq!(store.put(b"<svg onload=\"x()\"/>", AssetFormat::Svg, AssetKind::Icon, "", None, 0).map(|_| ()), Err(AssetError::UnsafeSvg));
        assert_eq!(store.put(SVG, AssetFormat::Png, AssetKind::Icon, "", None, 0).map(|_| ()), Err(AssetError::BadFormat));
        assert!(store.list().is_empty());
        assert!(!tmp.path().join("icons").exists());
        // 种类与格式要相符：图案是图片，场馆是 GLB
        assert_eq!(store.put(SVG, AssetFormat::Svg, AssetKind::Venue, "", None, 0).map(|_| ()), Err(AssetError::BadFormat));
        assert_eq!(store.put(&tiny_glb(), AssetFormat::Glb, AssetKind::Gobo, "", None, 0).map(|_| ()), Err(AssetError::BadFormat));
    }

    #[test]
    fn 图案与场馆放在各自的目录_重建时按目录识别种类() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let mut store = AssetStore::open(dir.clone());
        let gobo = store.put(SVG, AssetFormat::Svg, AssetKind::Gobo, "dots.svg", None, 0).unwrap();
        let venue = store.put(&tiny_glb(), AssetFormat::Glb, AssetKind::Venue, "hall.glb", None, 0).unwrap();
        assert!(dir.join("gobos").join(format!("{}.svg", gobo.hash)).is_file());
        assert!(dir.join("venues").join(format!("{}.glb", venue.hash)).is_file());
        assert!(store.put_thumb(&venue.hash, &tiny_webp()).is_ok());
        std::fs::remove_file(dir.join(INDEX_FILE)).unwrap();
        let rebuilt = AssetStore::open(dir);
        assert_eq!(rebuilt.get(&gobo.hash).map(|a| a.kind), Some(AssetKind::Gobo));
        assert_eq!(rebuilt.get(&venue.hash).map(|a| (a.kind, a.thumb)), Some((AssetKind::Venue, true)));
    }

    #[test]
    fn 清理只挪走未引用的资源() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let mut store = AssetStore::open(dir.clone());
        let keep = store.put(SVG, AssetFormat::Svg, AssetKind::Icon, "keep.svg", None, 0).unwrap();
        let drop = store.put(&tiny_glb(), AssetFormat::Glb, AssetKind::Model, "drop.glb", None, 0).unwrap();
        store.put_thumb(&drop.hash, &tiny_webp()).unwrap();
        let referenced: HashSet<String> = [keep.hash.clone()].into();
        let out = store.take_unreferenced(&referenced, 42).unwrap();
        assert_eq!(out.removed.iter().map(|a| a.hash.clone()).collect::<Vec<_>>(), vec![drop.hash.clone()]);
        let staging = out.staging.unwrap();
        assert!(staging.join(format!("{}.glb", drop.hash)).is_file());
        assert!(staging.join(format!("{}.thumb.webp", drop.hash)).is_file());
        assert!(staging.join(INDEX_FILE).is_file());
        assert!(store.file_path(&keep).is_file());
        assert_eq!(AssetStore::open(dir).list(), vec![keep]);
        // 没有要清理的时不建暂存目录
        let again = store.take_unreferenced(&referenced, 43).unwrap();
        assert!(again.removed.is_empty() && again.staging.is_none());
    }
}
