//! Tauri 命令：回放控制、时间线概览与通道曲线查询。
//!
//! 命令只做"提取 → 校验路径 → 调用领域 → 返回 DTO"；回放控制器位于 `host-core` 插件
//! （经 [`host_core::ArtnetCoreExt`] 访问），回放逻辑位于 `player` crate。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use artrec_core::ArtRecReader;
use player::{Overview, SeriesError};
use tauri::{AppHandle, Emitter as _};

use host_core::playback::{PlaybackStatus, RepeatMode};
use host_core::recording::Emitter;
use host_core::{ArtnetCoreExt, DispatchTarget};

use crate::recording_commands::resolved_dir;

/// 错误码：录制目录里找不到该节目或路径非法。
pub const ERR_BAD_PATH: &str = "bad_path";
/// 错误码：节目中不存在所请求的 Universe。
pub const ERR_UNKNOWN_UNIVERSE: &str = "unknown_universe";
/// 错误码：回放进行中，不能开始录制。
pub const ERR_PLAYBACK_ACTIVE: &str = "playback_active";

/// 解析并校验节目路径：必须是录制目录直接子级的 `.artrec`。
fn checked_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let dir = resolved_dir(app);
    recorder::resolve_in_dir(&dir, Path::new(path)).map_err(|_| ERR_BAD_PATH.to_string())
}

/// 打开节目并进入回放模式（暂停实时接收）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于校验路径、访问运行时与发射事件。
/// * `path` - 节目路径，须为录制目录直接子级的 `.artrec`。
/// * `target` - 输出目标；为 `None` 时使用默认的转发表目标。
///
/// # Returns
///
/// 节目刚打开时的初始 [`PlaybackStatus`]。
///
/// # Errors
///
/// 录制进行中（`recording_active`）、路径非法（`bad_path`）、目标 IP 非法（`bad_target`）
/// 或文件无法解析。
#[tauri::command]
pub fn player_open(
    app: AppHandle,
    path: String,
    target: Option<DispatchTarget>,
) -> Result<PlaybackStatus, String> {
    let file = checked_path(&app, &path)?;
    let name = recorder::read_sidecar(&file)
        .map(|m| m.name)
        .filter(|n| !n.trim().is_empty())
        .or_else(|| file.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let emit: Emitter = Arc::new({
        let app = app.clone();
        move |name, payload| {
            let _ = app.emit(name, payload);
        }
    });
    let library_dir = resolved_dir(&app);
    app.artnet_core()
        .open_playback(emit, file, name, target.unwrap_or_default(), library_dir)
}

/// 播放 / 继续。
///
/// # Errors
///
/// 没有已打开的节目（`no_player`）。
#[tauri::command]
pub fn player_play(app: AppHandle) -> Result<(), String> {
    app.artnet_core().playback().play()
}

/// 暂停。
///
/// # Errors
///
/// 没有已打开的节目（`no_player`）。
#[tauri::command]
pub fn player_pause(app: AppHandle) -> Result<(), String> {
    app.artnet_core().playback().pause()
}

/// 停止并回到开头（节目保持打开）。
///
/// # Errors
///
/// 没有已打开的节目（`no_player`）。
#[tauri::command]
pub fn player_stop(app: AppHandle) -> Result<(), String> {
    app.artnet_core().playback().stop()
}

/// 关闭节目并退出回放模式（恢复实时接收）。
#[tauri::command]
pub fn player_close(app: AppHandle) {
    app.artnet_core().playback().close();
}

/// 跳转到指定位置（微秒）。
///
/// # Errors
///
/// 没有已打开的节目（`no_player`）。
#[tauri::command]
pub fn player_seek(app: AppHandle, pos_us: u64) -> Result<(), String> {
    app.artnet_core().playback().seek(pos_us)
}

/// 设置倍速（千分之一，1000 = 1.0x）。
///
/// # Errors
///
/// 没有已打开的节目（`no_player`）。
#[tauri::command]
pub fn player_set_speed(app: AppHandle, speed_milli: u32) -> Result<(), String> {
    app.artnet_core().playback().set_speed(speed_milli)
}

/// 设置重复模式（关闭 / 循环 / 连播）。
///
/// 模式会被记住并沿用到之后打开的节目；没有节目时也可设置，不报错。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `mode` - 新的重复模式。
#[tauri::command]
pub fn player_set_repeat(app: AppHandle, mode: RepeatMode) {
    app.artnet_core().playback().set_repeat(mode);
}

/// 切换输出目标（转发表 / 指定 IP）。
///
/// # Errors
///
/// 目标 IP 非法（`bad_target`）或没有已打开的节目（`no_player`）。
#[tauri::command]
pub fn player_set_target(app: AppHandle, target: DispatchTarget) -> Result<(), String> {
    app.artnet_core().playback().set_target(target)
}

/// 设置前端正在查看的 Universe（决定推送哪些 `player:channels`）。
#[tauri::command]
pub fn player_set_viewed(app: AppHandle, universes: Vec<u16>) {
    app.artnet_core().playback().set_viewed(universes);
}

/// 当前回放状态快照。
///
/// # Returns
///
/// 当前的 [`PlaybackStatus`]。
#[tauri::command]
pub fn player_status(app: AppHandle) -> PlaybackStatus {
    app.artnet_core().playback().status()
}

/// 读取（必要时生成并缓存）节目的时间线概览。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于校验节目路径。
/// * `path` - 节目路径，须为录制目录直接子级的 `.artrec`。
/// * `buckets` - 期望的时间桶数；为 `None` 时使用默认桶数，并钳制到允许范围。
///
/// # Returns
///
/// 节目的时间线 [`Overview`]。
///
/// # Errors
///
/// 路径非法（`bad_path`）或文件无法解析。
#[tauri::command]
pub async fn player_overview(
    app: AppHandle,
    path: String,
    buckets: Option<u32>,
) -> Result<Overview, String> {
    let file = checked_path(&app, &path)?;
    let buckets = buckets.unwrap_or(player::DEFAULT_BUCKETS);
    tauri::async_runtime::spawn_blocking(move || load_overview(&file, buckets))
        .await
        .map_err(|e| e.to_string())?
}

/// 命中缓存直接返回，否则扫描生成并写回 sidecar。
fn load_overview(file: &Path, buckets: u32) -> Result<Overview, String> {
    let reader = ArtRecReader::open_file(file).map_err(|e| e.to_string())?;
    let frames = reader.index().len() as u64;
    let want = buckets.clamp(player::overview::MIN_BUCKETS, player::overview::MAX_BUCKETS);

    let mut meta = recorder::read_sidecar(file).unwrap_or_default();
    if let Some(cached) = meta
        .overview
        .as_ref()
        .and_then(|v| serde_json::from_value::<Overview>(v.clone()).ok())
    {
        if cached.matches(reader.file_len(), frames) && cached.buckets == want {
            return Ok(cached);
        }
    }

    let overview = player::build_overview(&reader, want);
    meta.overview = serde_json::to_value(&overview).ok();
    // 缓存写失败（例如只读目录）不影响本次结果
    let _ = recorder::write_sidecar(file, &meta);
    Ok(overview)
}

/// 查询选定通道的降采样曲线。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于校验节目路径。
/// * `query` - 曲线查询参数，见 [`SeriesQuery`]。
///
/// # Returns
///
/// 每个有效通道对应一条 [`player::ChannelSeries`]，点按时间升序排列。
///
/// # Errors
///
/// 路径非法（`bad_path`）、Universe 不存在（`unknown_universe`）、通道过多或文件无法解析。
#[tauri::command]
pub async fn player_series(
    app: AppHandle,
    query: SeriesQuery,
) -> Result<Vec<player::ChannelSeries>, String> {
    let file = checked_path(&app, &query.path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let reader = ArtRecReader::open_file(&file).map_err(|e| e.to_string())?;
        player::channel_series(
            &reader,
            query.universe,
            &query.channels,
            query.t0_us,
            query.t1_us,
            query.max_points,
        )
        .map_err(|e| match e {
            SeriesError::UnknownUniverse(_) => ERR_UNKNOWN_UNIVERSE.to_string(),
            other => other.to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 通道曲线查询参数（面向前端 DTO，camelCase）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesQuery {
    /// 节目路径。
    pub path: String,
    /// Universe 编号。
    pub universe: u16,
    /// 通道号列表（0 起）。
    pub channels: Vec<u16>,
    /// 区间起点（微秒）。
    pub t0_us: u64,
    /// 区间终点（微秒）。
    pub t1_us: u64,
    /// 最大点数。
    pub max_points: u32,
}

/// 录制开始前的互斥检查：回放模式下不允许录制。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Errors
///
/// 已打开节目，或处于播放器模式（此时实时接收已停止，没有东西可录）时返回 [`ERR_PLAYBACK_ACTIVE`]。
pub fn ensure_not_playing(app: &AppHandle) -> Result<(), String> {
    let core = app.artnet_core();
    if core.playback().is_loaded() || core.app_mode_status().mode == host_core::app_mode::AppMode::Player {
        Err(ERR_PLAYBACK_ACTIVE.to_string())
    } else {
        Ok(())
    }
}
