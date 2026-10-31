//! Tauri 命令：灯具资源库（`data/fixture-assets`，2D 图标与 3D 模型）。
//!
//! 逻辑在 `fixture-assets` 库；本模块只做“提取 State → 调用库 → 返回 DTO”。
//! 3D 模型与缩略图由前端规整后经原始二进制 IPC 传来（不转成 JSON 数组），元数据放在请求头里：
//! `x-asset-format`、`x-asset-name`（百分号编码）、`x-asset-stats`（百分号编码的 JSON）、`x-asset-hash`。
//!
//! 错误码：`bad_path`、`bad_format`、`too_large`、`unsafe_svg`、`full`、`not_found`、`io`、`bad_request`。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fixture_assets::{max_bytes, AssetError, AssetInfo, AssetKind, AssetStore, ModelStats, ASSET_KINDS};
use parking_lot::Mutex;
use serde::Serialize;
use show_engine::fixture::{is_sha256_hex, AssetFormat, FixtureModel};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

use crate::fixture_commands::FixtureState;
use crate::skills_commands::SkillsState;

/// 资源库目录名（位于数据根目录下）。
const ASSETS_DIR: &str = "fixture-assets";
/// 错误码：请求缺少或带了不合法的元数据。
const ERR_BAD_REQUEST: &str = "bad_request";
/// 错误码：导入路径不是支持的图标文件。
const ERR_BAD_PATH: &str = "bad_path";
/// 回收站里的条目种类。
const TRASH_KIND: &str = "fixture-assets";

/// 应用壳托管的资源库状态。
pub struct FixtureAssetsState {
    store: Mutex<AssetStore>,
}

impl FixtureAssetsState {
    /// 打开数据根目录下的资源库。
    ///
    /// # Arguments
    ///
    /// * `app` - 应用句柄，用于取得数据根目录。
    ///
    /// # Returns
    ///
    /// 资源库状态。
    #[must_use]
    pub fn new(app: &AppHandle) -> Self {
        let dir = app.state::<crate::data_dir::DataRoot>().path().join(ASSETS_DIR);
        Self { store: Mutex::new(AssetStore::open(dir)) }
    }
}

/// 前端看到的一个资源：索引信息加上文件路径（交给 `convertFileSrc`）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AssetView {
    /// 索引信息。
    #[serde(flatten)]
    pub info: AssetInfo,
    /// 文件的绝对路径。
    pub path: String,
    /// 缩略图的绝对路径（3D 模型有缩略图时）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub thumb_path: Option<String>,
}

/// 清理未引用资源的结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AssetCleanupOutcome {
    /// 挪进回收站的资源数。
    pub removed: u32,
    /// 这些资源的总大小（字节）。
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub bytes: u64,
    /// 回收站条目 id（没有挪走任何资源时为空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub trash_id: Option<String>,
}

/// 当前时间（Unix 毫秒）。
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn code(e: &AssetError) -> String {
    e.code().to_owned()
}

fn view_of(store: &AssetStore, info: AssetInfo) -> AssetView {
    let path = store.file_path(&info).to_string_lossy().into_owned();
    let thumb_path = info.thumb.then(|| store.thumb_path(&info.hash).to_string_lossy().into_owned());
    AssetView { info, path, thumb_path }
}

/// 解码百分号编码（`encodeURIComponent` 的结果）；非法编码返回 `None`。
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 解析资源格式名（`svg` / `png` / `webp` / `glb`）。
fn parse_format(s: &str) -> Option<AssetFormat> {
    serde_json::from_value(serde_json::Value::String(s.trim().to_ascii_lowercase())).ok()
}

/// 读一个请求头（UTF-8 文本）。
fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

/// 请求体里的原始二进制。
fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(ERR_BAD_REQUEST.to_owned()),
    }
}

/// 列出资源库。
///
/// # Arguments
///
/// * `state` - 资源库状态。
///
/// # Returns
///
/// 全部资源（按散列排序）。
#[tauri::command]
pub fn fixture_asset_list(state: State<'_, FixtureAssetsState>) -> Vec<AssetView> {
    let store = state.store.lock();
    store.list().into_iter().map(|a| view_of(&store, a)).collect()
}

/// 检查图标文件路径：扩展名是 SVG / PNG / WebP、是文件、不超过该格式的大小上限。
fn check_icon_path(path: &str) -> Result<(PathBuf, AssetFormat), String> {
    let path = Path::new(path.trim());
    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .and_then(parse_format)
        .filter(|f| f.is_image())
        .ok_or_else(|| ERR_BAD_PATH.to_owned())?;
    let meta = std::fs::metadata(path).map_err(|_| ERR_BAD_PATH.to_owned())?;
    if !meta.is_file() {
        return Err(ERR_BAD_PATH.to_owned());
    }
    if meta.len() > max_bytes(format) as u64 {
        return Err(AssetError::TooLarge.code().to_owned());
    }
    Ok((path.to_path_buf(), format))
}

/// 从文件导入一个 2D 图标或图案（SVG / PNG / WebP）。
///
/// # Arguments
///
/// * `state` - 资源库状态。
/// * `path` - 用户选择的图片文件。
/// * `kind` - `icon`（默认）或 `gobo`。
///
/// # Returns
///
/// 存入的资源（内容已存在时为原有条目）。
///
/// # Errors
///
/// 路径不合格（`bad_path`）、内容不合格（`bad_format` / `too_large` / `unsafe_svg`）、库已满或写盘失败。
#[tauri::command]
pub async fn fixture_asset_import_file(
    state: State<'_, FixtureAssetsState>,
    path: String,
    kind: Option<AssetKind>,
) -> Result<AssetView, String> {
    let kind = kind.unwrap_or(AssetKind::Icon);
    if !matches!(kind, AssetKind::Icon | AssetKind::Gobo) {
        return Err(ERR_BAD_REQUEST.to_owned());
    }
    let (path, format) = check_icon_path(&path)?;
    let bytes = tokio::fs::read(&path).await.map_err(|_| ERR_BAD_PATH.to_owned())?;
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_owned();
    let mut store = state.store.lock();
    let info = store.put(&bytes, format, kind, &name, None, now_ms()).map_err(|e| code(&e))?;
    Ok(view_of(&store, info))
}

/// 存入一个资源（前端规整好的 GLB，或前端生成的图标），请求体是原始二进制。
///
/// 请求头：`x-asset-format`（必填）、`x-asset-kind`（`icon` / `model` / `gobo` / `venue`，省略时按格式）、
/// `x-asset-name`（百分号编码，可省）、`x-asset-stats`（百分号编码的 [`ModelStats`] JSON，可省）。
///
/// # Arguments
///
/// * `state` - 资源库状态。
/// * `request` - IPC 请求（原始二进制 + 请求头）。
///
/// # Returns
///
/// 存入的资源。
///
/// # Errors
///
/// 请求不合格（`bad_request`）、内容不合格、库已满或写盘失败。
#[tauri::command]
pub fn fixture_asset_put(state: State<'_, FixtureAssetsState>, request: Request<'_>) -> Result<AssetView, String> {
    let format = header(&request, "x-asset-format").and_then(parse_format).ok_or_else(|| ERR_BAD_REQUEST.to_owned())?;
    let kind = match header(&request, "x-asset-kind") {
        Some(k) => serde_json::from_value::<AssetKind>(serde_json::Value::String(k.trim().to_owned())).map_err(|_| ERR_BAD_REQUEST.to_owned())?,
        None => AssetKind::of(format),
    };
    let name = header(&request, "x-asset-name").and_then(percent_decode).unwrap_or_default();
    let model_stats = match header(&request, "x-asset-stats") {
        Some(raw) => Some(
            percent_decode(raw)
                .and_then(|s| serde_json::from_str::<ModelStats>(&s).ok())
                .ok_or_else(|| ERR_BAD_REQUEST.to_owned())?,
        ),
        None => None,
    };
    let bytes = raw_body(&request)?;
    let mut store = state.store.lock();
    let info = store.put(bytes, format, kind, &name, model_stats, now_ms()).map_err(|e| code(&e))?;
    Ok(view_of(&store, info))
}

/// 保存一个 3D 模型的缩略图（WebP，请求体是原始二进制，请求头 `x-asset-hash` 为模型散列）。
///
/// # Arguments
///
/// * `state` - 资源库状态。
/// * `request` - IPC 请求。
///
/// # Returns
///
/// 更新后的资源。
///
/// # Errors
///
/// 请求不合格（`bad_request`）、模型不存在（`not_found`）、不是 WebP 或超限、写盘失败。
#[tauri::command]
pub fn fixture_asset_put_thumb(state: State<'_, FixtureAssetsState>, request: Request<'_>) -> Result<AssetView, String> {
    let hash = header(&request, "x-asset-hash").ok_or_else(|| ERR_BAD_REQUEST.to_owned())?.to_owned();
    let bytes = raw_body(&request)?;
    let mut store = state.store.lock();
    let info = store.put_thumb(&hash, bytes).map_err(|e| code(&e))?;
    Ok(view_of(&store, info))
}

/// 放行 asset 协议对资源库各子目录（图标、模型、图案、场馆、缩略图）的访问（不递归），供前端加载。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `state` - 资源库状态。
///
/// # Errors
///
/// 建目录或放行失败。
#[tauri::command]
pub fn fixture_assets_authorize(app: AppHandle, state: State<'_, FixtureAssetsState>) -> Result<(), String> {
    let store = state.store.lock();
    let scope = app.asset_protocol_scope();
    for dir in ASSET_KINDS.iter().map(|k| store.kind_dir(*k)).chain(std::iter::once(store.thumbs_dir())) {
        std::fs::create_dir_all(&dir).map_err(|_| "io".to_owned())?;
        scope.allow_directory(&dir, false).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 允许导入的 3D 源文件扩展名。
const MODEL_SOURCE_EXTENSIONS: &[&str] = &["glb", "gltf", "obj"];
/// 3D 源文件的大小上限（字节）：规整前的文件可以比规整后大。
const MAX_MODEL_SOURCE_BYTES: u64 = 256 * 1024 * 1024;

/// 放行 asset 协议对用户选择的一个 3D 源文件的访问（前端在 webview 里读取并规整）。
///
/// `.gltf` 的外部 `.bin` 与贴图通常在同一目录，因此同时放行该目录（不递归）。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `path` - 用户在对话框里选择的文件。
///
/// # Errors
///
/// 扩展名不是 GLB / glTF / OBJ、不是文件（`bad_path`）、超过 256 MiB（`too_large`），或放行失败。
#[tauri::command]
pub fn fixture_asset_source_authorize(app: AppHandle, path: String) -> Result<(), String> {
    let path = Path::new(path.trim());
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !MODEL_SOURCE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(ERR_BAD_PATH.to_owned());
    }
    let meta = std::fs::metadata(path).map_err(|_| ERR_BAD_PATH.to_owned())?;
    if !meta.is_file() {
        return Err(ERR_BAD_PATH.to_owned());
    }
    if meta.len() > MAX_MODEL_SOURCE_BYTES {
        return Err(AssetError::TooLarge.code().to_owned());
    }
    let scope = app.asset_protocol_scope();
    scope.allow_file(path).map_err(|e| e.to_string())?;
    if ext == "gltf"
        && let Some(dir) = path.parent()
    {
        scope.allow_directory(dir, false).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 模型里引用的资源散列（图标、3D 模型、图案槽位）。
fn referenced_by(models: &[FixtureModel], out: &mut HashSet<String>) {
    for m in models {
        if let Some(a) = &m.appearance {
            out.extend(a.icon.iter().chain(a.model3d.iter()).map(|r| r.hash.clone()));
        }
        let layouts = std::iter::once(&m.properties).chain(m.modes.iter().map(|md| &md.properties));
        for p in layouts.flatten() {
            out.extend(p.capabilities.iter().filter_map(|c| c.pattern.as_deref()).filter(|s| is_sha256_hex(s)).map(str::to_owned));
        }
    }
}

/// 把灯具库与打开的工程都没有引用的资源挪进回收站（30 天内可找回）。
///
/// # Arguments
///
/// * `state` - 资源库状态。
/// * `fixtures` - 灯具库（引用来源之一）。
/// * `skills` - 回收站（与技能共用）。
/// * `referenced` - 前端补充的引用（打开的工程里灯具模型快照用到的散列）。
///
/// # Returns
///
/// 挪走的数量、大小与回收站条目。
///
/// # Errors
///
/// 挪动或写索引失败（`io`），或放进回收站失败。
#[tauri::command]
pub fn fixture_asset_cleanup(
    state: State<'_, FixtureAssetsState>,
    fixtures: State<'_, FixtureState>,
    skills: State<'_, SkillsState>,
    referenced: Vec<String>,
) -> Result<AssetCleanupOutcome, String> {
    let mut keep: HashSet<String> = referenced.into_iter().collect();
    referenced_by(&fixtures.with(|lib| lib.list()), &mut keep);
    let cleanup = state.store.lock().take_unreferenced(&keep, now_ms()).map_err(|e| code(&e))?;
    let bytes = cleanup.removed.iter().map(|a| a.bytes).sum();
    let removed = cleanup.removed.len() as u32;
    let trash_id = match cleanup.staging {
        Some(dir) => {
            let label = format!("{removed} 个灯具资源");
            Some(skills.trash_put_dir(TRASH_KIND, &label, &dir)?.id)
        }
        None => None,
    };
    Ok(AssetCleanupOutcome { removed, bytes, trash_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 百分号解码与格式解析() {
        assert_eq!(percent_decode("%E7%81%AF%20a.glb").as_deref(), Some("灯 a.glb"));
        assert_eq!(percent_decode("plain").as_deref(), Some("plain"));
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%e7"), None, "不完整的 UTF-8");
        assert_eq!(parse_format("GLB"), Some(AssetFormat::Glb));
        assert_eq!(parse_format("svg"), Some(AssetFormat::Svg));
        assert_eq!(parse_format("exe"), None);
    }

    #[test]
    fn 图标路径按扩展名与大小检查() {
        let dir = tempfile_dir("icon-path");
        let svg = dir.join("a.svg");
        std::fs::write(&svg, b"<svg/>").expect("写临时文件");
        assert_eq!(check_icon_path(&svg.to_string_lossy()).map(|(_, f)| f), Ok(AssetFormat::Svg));
        let glb = dir.join("a.glb");
        std::fs::write(&glb, b"glTF").expect("写临时文件");
        assert_eq!(check_icon_path(&glb.to_string_lossy()).map(|_| ()), Err(ERR_BAD_PATH.to_owned()));
        assert_eq!(check_icon_path(&dir.join("none.png").to_string_lossy()).map(|_| ()), Err(ERR_BAD_PATH.to_owned()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tempfile_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("asset-cmd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }
}
