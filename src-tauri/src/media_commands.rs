//! Tauri 命令：节目编辑器的音视频素材（探测、授权预览、波形峰值）。
//!
//! 素材只被"引用"，不复制进工程。webview 通过 `asset:` 协议读取文件播放，而 asset 协议默认
//! 不放行任何路径，所以每个素材在使用前要先经 [`media_authorize`] 逐个放行（只放行这一个文件，
//! 不放开目录）。波形峰值计算较重，结果按"路径 + 修改时间 + 大小 + 精度"缓存到应用缓存目录。
//!
//! 错误以字符串错误码返回：`not_found`、`unsupported_extension`、`unsupported`、`io`、`decode`。

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

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
    let path = PathBuf::from(path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
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
fn read_cache(file: &Path) -> Option<Peaks> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

/// 写入缓存（先写临时文件再重命名）；失败只记日志，不影响结果。
fn write_cache(file: &Path, peaks: &Peaks) {
    let write = || -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = file.with_extension("tmp");
        let bytes = serde_json::to_vec(peaks).map_err(std::io::Error::other)?;
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, file)
    };
    if let Err(e) = write() {
        tracing::warn!(error = %e, "写入波形缓存失败");
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
        assert_eq!(read_cache(&file), None);
        assert_eq!(read_cache(&tmp.0.join("none.json")), None);
    }

    #[test]
    fn 哈希稳定() {
        assert_eq!(fnv1a("abc"), fnv1a("abc"));
        assert_ne!(fnv1a("abc"), fnv1a("abd"));
        assert_eq!(fnv1a(""), 0xcbf2_9ce4_8422_2325);
    }
}
