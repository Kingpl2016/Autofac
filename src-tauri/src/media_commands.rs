//! Tauri 命令：节目编辑器的音视频素材（探测、授权预览、波形峰值）。
//!
//! 素材只被"引用"，不复制进工程。webview 通过 `asset:` 协议读取文件播放，而 asset 协议默认
//! 不放行任何路径，所以每个素材在使用前要先经 [`media_authorize`] 逐个放行（只放行这一个文件，
//! 不放开目录）。波形峰值计算较重，结果按"路径 + 修改时间 + 大小 + 精度"缓存到应用缓存目录。
//!
//! 错误以字符串错误码返回：`not_found`、`unsupported_extension`、`unsupported`、`io`、`decode`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;

use serde::{de::DeserializeOwned, Serialize};
use show_engine::analysis::{self, AudioAnalysis};
use show_engine::beats::BeatAnalysis;
use show_engine::media::{self, MediaError, MediaInfo, Peaks, MAX_PEAKS_PER_SECOND, MIN_PEAKS_PER_SECOND};
use tauri::{AppHandle, Manager};

/// 错误码：文件不存在。
pub const ERR_NOT_FOUND: &str = "not_found";
/// 错误码：扩展名不是支持的音视频类型。
pub const ERR_UNSUPPORTED_EXTENSION: &str = "unsupported_extension";

/// 支持导入的扩展名（小写）。
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "mp4", "m4v", "mov", "webm", "mkv",
];

/// 错误码：只读缓存时没有缓存。
pub const ERR_NOT_CACHED: &str = "not_cached";

/// 峰值缓存文件的版本号；格式变化时递增，旧缓存自然失效。
const CACHE_VERSION: u32 = 1;

/// 校验素材路径：存在、是文件、扩展名受支持。
///
/// # Arguments
///
/// * `path` - 前端传来的素材路径。
///
/// # Returns
///
/// 通过校验的路径。
///
/// # Errors
///
/// 文件不存在（`not_found`）或扩展名不支持（`unsupported_extension`）。
pub fn checked_media_path(path: &str) -> Result<PathBuf, String> {
    checked_path(path, SUPPORTED_EXTENSIONS)
}

/// 舞台背景图允许的扩展名（小写）。
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"];

/// 校验舞台背景图路径：存在、是文件、扩展名是图片。
///
/// # Arguments
///
/// * `path` - 前端传来的图片路径。
///
/// # Returns
///
/// 通过校验的路径。
///
/// # Errors
///
/// 文件不存在（`not_found`）或扩展名不是图片（`unsupported_extension`）。
pub fn checked_image_path(path: &str) -> Result<PathBuf, String> {
    checked_path(path, IMAGE_EXTENSIONS)
}

/// 按扩展名白名单与存在性校验路径。
///
/// # Arguments
///
/// * `path` - 文件路径。
/// * `allowed` - 允许的扩展名（小写，不含点）。
///
/// # Returns
///
/// 通过校验的路径。
///
/// # Errors
///
/// 扩展名不在白名单（`unsupported_extension`）或不是存在的文件（`not_found`）。
fn checked_path(path: &str, allowed: &[&str]) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !allowed.contains(&ext.as_str()) {
        return Err(ERR_UNSUPPORTED_EXTENSION.to_owned());
    }
    if !path.is_file() {
        return Err(ERR_NOT_FOUND.to_owned());
    }
    Ok(path)
}

fn media_err(e: &MediaError) -> String {
    e.code().to_owned()
}

/// 探测素材的类型、时长与音轨信息。
///
/// # Arguments
///
/// * `path` - 素材文件路径。
///
/// # Returns
///
/// 探测结果；无音轨的视频时长为空，由前端从元数据补上。
///
/// # Errors
///
/// 路径不合格，或容器无法识别（`unsupported`）、文件无法打开（`io`）。
#[tauri::command]
pub async fn media_probe(path: String) -> Result<MediaInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_media_path(&path)?;
        media::probe(&path).map_err(|e| media_err(&e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 放行 asset 协议对这个素材文件的访问，使 webview 能用 `<audio>` / `<video>` 播放它。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `path` - 素材文件路径。
///
/// # Errors
///
/// 路径不合格，或放行失败。
#[tauri::command]
pub fn media_authorize(app: AppHandle, path: String) -> Result<(), String> {
    let path = checked_media_path(&path)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())
}

/// 放行 asset 协议对一张舞台背景图的访问（只放行这一个文件），供舞台监视器绘制。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `path` - 图片文件路径。
///
/// # Errors
///
/// 路径不合格（`not_found` / `unsupported_extension`），或放行失败。
#[tauri::command]
pub fn stage_image_authorize(app: AppHandle, path: String) -> Result<(), String> {
    let path = checked_image_path(&path)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())
}

/// 计算素材的波形峰值（带磁盘缓存）。
///
/// # Arguments
///
/// * `app` - 应用句柄（取缓存目录）。
/// * `path` - 素材文件路径。
/// * `per_second` - 每秒桶数，夹取到 10~200。
///
/// # Returns
///
/// 峰值数据。
///
/// # Errors
///
/// 路径不合格，或解码失败（`unsupported` / `decode` / `io`）。
#[tauri::command]
pub async fn media_peaks(app: AppHandle, path: String, per_second: u32) -> Result<Peaks, String> {
    let cache_dir = Some(app.state::<crate::data_dir::DataRoot>().cache_dir().join("media-peaks"));
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_media_path(&path)?;
        let per_second = per_second.clamp(MIN_PEAKS_PER_SECOND, MAX_PEAKS_PER_SECOND);
        let cache_file = cache_dir.as_deref().and_then(|d| cache_path(d, &path, per_second));
        if let Some(hit) = cache_file.as_deref().and_then(read_cache) {
            return Ok(hit);
        }
        let peaks = media::compute_peaks(&path, per_second, &AtomicBool::new(false))
            .map_err(|e| media_err(&e))?;
        if let Some(file) = cache_file.as_deref() {
            write_cache(file, &peaks);
        }
        Ok(peaks)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 节拍分析算法的版本号；算法变化时递增，旧缓存自然失效。
const BEATS_VERSION: u32 = 1;

/// 分析素材的节拍（速度、强拍偏移、逐拍时刻与能量段落，带磁盘缓存）。
///
/// # Arguments
///
/// * `app` - 应用句柄（取缓存目录）。
/// * `path` - 素材文件路径。
///
/// # Returns
///
/// 节拍分析结果。
///
/// # Errors
///
/// 路径不合格，或解码失败（`unsupported` / `decode` / `io`），或没有稳定的节拍（`no_beat`）。
#[tauri::command]
pub async fn media_analyze_beats(app: AppHandle, path: String) -> Result<BeatAnalysis, String> {
    let cache_dir = Some(app.state::<crate::data_dir::DataRoot>().cache_dir().join("media-beats"));
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_media_path(&path)?;
        let cache_file = cache_dir.as_deref().and_then(|d| cache_path(d, &path, BEATS_VERSION));
        if let Some(hit) = cache_file.as_deref().and_then(read_cache::<BeatAnalysis>) {
            return Ok(hit);
        }
        let result = media::analyze_beats(&path, &AtomicBool::new(false)).map_err(|e| media_err(&e))?;
        if let Some(file) = cache_file.as_deref() {
            write_cache(file, &result);
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 进行中的分析：请求 id → 取消标志（[`media_cancel`] 置位）。
static RUNNING: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 登记一个可取消的请求；离开作用域时注销。
struct Running {
    id: Option<String>,
    flag: Arc<AtomicBool>,
}

impl Running {
    fn new(id: Option<String>) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        if let Some(id) = &id {
            RUNNING.lock().insert(id.clone(), Arc::clone(&flag));
        }
        Self { id, flag }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            RUNNING.lock().remove(id);
        }
    }
}

/// 音乐结构分析（每小节特征、段落标签、渐强 / 爆点 / 断层 / 冲击事件，带磁盘缓存，可取消）。
///
/// # Arguments
///
/// * `app` - 应用句柄（取缓存目录）。
/// * `path` - 素材文件路径。
/// * `sensitivity` - 灵敏度 0.5~2（越大事件越多），缓存按灵敏度区分。
/// * `request_id` - 请求 id（可选），[`media_cancel`] 用它取消。
/// * `cached_only` - 为 `true` 时只读缓存，没有缓存时返回 `not_cached` 而不分析。
///
/// # Returns
///
/// 分析结果（素材内时刻）。
///
/// # Errors
///
/// 路径不合格、解码失败（`unsupported` / `decode` / `io`）、没有稳定的节拍（`no_beat`）、被取消（`cancelled`），
/// 或只读缓存时没有缓存（`not_cached`）。
#[tauri::command]
pub async fn media_analyze(
    app: AppHandle,
    path: String,
    sensitivity: f64,
    request_id: Option<String>,
    cached_only: Option<bool>,
) -> Result<AudioAnalysis, String> {
    let cache_dir = Some(app.state::<crate::data_dir::DataRoot>().cache_dir().join("media-analysis"));
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_media_path(&path)?;
        let sensitivity = analysis::clamp_sensitivity(sensitivity);
        // 缓存键：算法版本 + 灵敏度（百分数）
        let key = analysis::ANALYSIS_VERSION * 1000 + (sensitivity * 100.0).round() as u32;
        let cache_file = cache_dir.as_deref().and_then(|d| cache_path(d, &path, key));
        if let Some(hit) = cache_file.as_deref().and_then(read_cache::<AudioAnalysis>) {
            return Ok(hit);
        }
        // 只查缓存（打开工程、显示参考线时用）：没有缓存就不分析，避免导入素材后后台占用 CPU
        if cached_only == Some(true) {
            return Err(ERR_NOT_CACHED.to_owned());
        }
        let running = Running::new(request_id);
        let result = media::analyze_audio(&path, sensitivity, &running.flag).map_err(|e| media_err(&e))?;
        if let Some(file) = cache_file.as_deref() {
            write_cache(file, &result);
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 取消一个进行中的分析（[`media_analyze`] / [`media_excerpt`]）。没有这个请求时什么也不做。
///
/// # Arguments
///
/// * `request_id` - 请求 id。
#[tauri::command]
pub fn media_cancel(request_id: String) {
    if let Some(flag) = RUNNING.lock().get(&request_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// 一段音频片段（[`media_excerpt`] 的输入）。
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ExcerptRange {
    /// 起点（毫秒，素材内）。
    pub start_ms: u64,
    /// 长度（毫秒，最长 20 秒）。
    pub length_ms: u64,
}

/// 截取若干段音频，转成 16 kHz 单声道 WAV 并 Base64 编码（发给支持音频输入的模型做标注；前端要先征得用户同意）。
///
/// # Arguments
///
/// * `path` - 素材文件路径。
/// * `ranges` - 片段（最多 16 段，每段最长 20 秒）。
/// * `request_id` - 请求 id（可选），[`media_cancel`] 用它取消。
///
/// # Returns
///
/// 与 `ranges` 一一对应的 Base64 WAV；落在音轨之外的片段为空串。
///
/// # Errors
///
/// 路径不合格、片段数不对（`unsupported`）、解码失败或被取消。
#[tauri::command]
pub async fn media_excerpt(path: String, ranges: Vec<ExcerptRange>, request_id: Option<String>) -> Result<Vec<String>, String> {
    use base64::Engine as _;
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_media_path(&path)?;
        let pairs: Vec<(u64, u64)> = ranges.iter().map(|r| (r.start_ms, r.length_ms)).collect();
        let running = Running::new(request_id);
        let wavs = media::excerpt_wavs(&path, &pairs, 16_000, &running.flag).map_err(|e| media_err(&e))?;
        Ok(wavs.iter().map(|w| if w.is_empty() { String::new() } else { base64::engine::general_purpose::STANDARD.encode(w) }).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 前端可写的分析缓存种类（白名单，同时是缓存子目录名）与各自的版本号。
const FRONT_CACHE_KINDS: &[(&str, u32)] = &[("video", 1)];

/// 前端分析缓存单条的上限（字节）。
const MAX_FRONT_CACHE_BYTES: usize = 2 * 1024 * 1024;

/// 错误码：缓存种类不在白名单，或内容超过上限 / 不是 JSON。
const ERR_INVALID: &str = "invalid";

/// 前端分析缓存的文件路径（按素材的路径、修改时间、大小与种类区分）。
///
/// # Arguments
///
/// * `app` - 应用句柄（取缓存目录）。
/// * `path` - 素材文件路径（已校验）。
/// * `kind` - 缓存种类（白名单）。
///
/// # Returns
///
/// 缓存文件路径；读不到素材元数据时为 `None`。
///
/// # Errors
///
/// 种类不在白名单时返回 `invalid`。
fn front_cache_file(app: &AppHandle, path: &Path, kind: &str) -> Result<Option<PathBuf>, String> {
    let (name, version) = FRONT_CACHE_KINDS
        .iter()
        .find(|(k, _)| *k == kind)
        .ok_or_else(|| ERR_INVALID.to_owned())?;
    let dir = app.state::<crate::data_dir::DataRoot>().cache_dir().join("media-front").join(name);
    Ok(cache_path(&dir, path, *version))
}

/// 读取前端算出的素材分析缓存（例如视频画面分析，由 webview 解码计算）。
///
/// # Arguments
///
/// * `app` - 应用句柄（取缓存目录）。
/// * `path` - 素材文件路径。
/// * `kind` - 缓存种类（目前只有 `video`）。
///
/// # Returns
///
/// 缓存的 JSON 文本；没有缓存（或素材已修改）时为 `None`。
///
/// # Errors
///
/// 路径不合格（`not_found` / `unsupported_extension`）或种类不在白名单（`invalid`）。
#[tauri::command]
pub async fn media_cache_get(app: AppHandle, path: String, kind: String) -> Result<Option<String>, String> {
    let path = checked_media_path(&path)?;
    let Some(file) = front_cache_file(&app, &path, &kind)? else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || Ok(std::fs::read_to_string(file).ok()))
        .await
        .map_err(|e| e.to_string())?
}

/// 写入前端算出的素材分析缓存（先校验是 JSON、不超过 2 MiB，再原子写入）。
///
/// # Arguments
///
/// * `app` - 应用句柄（取缓存目录）。
/// * `path` - 素材文件路径。
/// * `kind` - 缓存种类（目前只有 `video`）。
/// * `data` - JSON 文本。
///
/// # Errors
///
/// 路径不合格、种类不在白名单或内容不合格（`invalid`）；写盘失败时返回 `io`。
#[tauri::command]
pub async fn media_cache_put(app: AppHandle, path: String, kind: String, data: String) -> Result<(), String> {
    let path = checked_media_path(&path)?;
    if data.len() > MAX_FRONT_CACHE_BYTES || serde_json::from_str::<serde_json::Value>(&data).is_err() {
        return Err(ERR_INVALID.to_owned());
    }
    let Some(file) = front_cache_file(&app, &path, &kind)? else { return Ok(()) };
    tauri::async_runtime::spawn_blocking(move || fsutil::write_atomic(&file, data.as_bytes()).map_err(|_| "io".to_owned()))
        .await
        .map_err(|e| e.to_string())?
}

/// FNV-1a 64 位哈希（缓存文件名用，只需稳定、不需要抗碰撞）。
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// 峰值缓存文件路径：文件被修改（修改时间 / 大小变化）后自然换一个文件名。
///
/// # Arguments
///
/// * `dir` - 缓存目录。
/// * `media` - 素材路径。
/// * `per_second` - 每秒桶数。
///
/// # Returns
///
/// 缓存文件路径；读不到素材元数据时为 `None`（此时不缓存）。
fn cache_path(dir: &Path, media: &Path, per_second: u32) -> Option<PathBuf> {
    let meta = std::fs::metadata(media).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    let key = format!(
        "v{CACHE_VERSION}|{}|{modified}|{}|{per_second}",
        media.to_string_lossy(),
        meta.len()
    );
    Some(dir.join(format!("{:016x}.json", fnv1a(&key))))
}

/// 读取缓存；缺失或损坏时返回 `None`。
fn read_cache<T: DeserializeOwned>(file: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

/// 写入缓存（先写临时文件再重命名）；失败只记日志，不影响结果。
fn write_cache<T: Serialize>(file: &Path, value: &T) {
    let write = || -> std::io::Result<()> {
        let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
        fsutil::write_atomic(file, &bytes)
    };
    if let Err(e) = write() {
        tracing::warn!(error = %e, "写入素材分析缓存失败");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("ans-mediacmd-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn 路径校验_扩展名与存在性() {
        let tmp = Tmp::new("check");
        let wav = tmp.0.join("a.WAV");
        std::fs::write(&wav, b"x").unwrap();
        assert_eq!(checked_media_path(&wav.to_string_lossy()).unwrap(), wav);
        let txt = tmp.0.join("a.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert_eq!(checked_media_path(&txt.to_string_lossy()).unwrap_err(), ERR_UNSUPPORTED_EXTENSION);
        assert_eq!(
            checked_media_path(&tmp.0.join("ghost.mp3").to_string_lossy()).unwrap_err(),
            ERR_NOT_FOUND
        );
        // 目录冒充文件
        let dir = tmp.0.join("dir.mp3");
        std::fs::create_dir(&dir).unwrap();
        assert_eq!(checked_media_path(&dir.to_string_lossy()).unwrap_err(), ERR_NOT_FOUND);
    }

    #[test]
    fn 背景图路径校验_只放行图片() {
        let tmp = Tmp::new("image");
        let png = tmp.0.join("stage.PNG");
        std::fs::write(&png, b"x").unwrap();
        assert_eq!(checked_image_path(&png.to_string_lossy()).unwrap(), png);
        let mp3 = tmp.0.join("a.mp3");
        std::fs::write(&mp3, b"x").unwrap();
        assert_eq!(checked_image_path(&mp3.to_string_lossy()).unwrap_err(), ERR_UNSUPPORTED_EXTENSION);
        assert_eq!(checked_media_path(&png.to_string_lossy()).unwrap_err(), ERR_UNSUPPORTED_EXTENSION);
        assert_eq!(
            checked_image_path(&tmp.0.join("ghost.jpg").to_string_lossy()).unwrap_err(),
            ERR_NOT_FOUND
        );
    }

    #[test]
    fn 缓存文件名随素材变化而变化() {
        let tmp = Tmp::new("cache-key");
        let media = tmp.0.join("a.wav");
        std::fs::write(&media, b"1234").unwrap();
        let cache = tmp.0.join("cache");
        let a = cache_path(&cache, &media, 50).unwrap();
        assert_eq!(a, cache_path(&cache, &media, 50).unwrap());
        assert_ne!(a, cache_path(&cache, &media, 100).unwrap(), "精度不同");
        std::fs::write(&media, b"12345678").unwrap();
        assert_ne!(a, cache_path(&cache, &media, 50).unwrap(), "大小变化");
        assert!(cache_path(&cache, &tmp.0.join("ghost.wav"), 50).is_none());
    }

    #[test]
    fn 缓存读写往返_损坏的缓存被忽略() {
        let tmp = Tmp::new("cache-rw");
        let file = tmp.0.join("sub").join("p.json");
        let peaks = Peaks { per_second: 10, duration_ms: 1000, peaks: vec![-3, 4, -5, 6] };
        write_cache(&file, &peaks);
        assert_eq!(read_cache(&file), Some(peaks));
        assert!(!file.with_extension("tmp").exists());
        std::fs::write(&file, b"{broken").unwrap();
        assert_eq!(read_cache::<Peaks>(&file), None);
        assert_eq!(read_cache::<Peaks>(&tmp.0.join("none.json")), None);
    }

    #[test]
    fn 哈希稳定() {
        assert_eq!(fnv1a("abc"), fnv1a("abc"));
        assert_ne!(fnv1a("abc"), fnv1a("abd"));
        assert_eq!(fnv1a(""), 0xcbf2_9ce4_8422_2325);
    }
}
