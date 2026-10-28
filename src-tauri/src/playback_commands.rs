//! Tauri 命令：回放控制、时间线概览与通道曲线查询。
//!
//! 命令只做"提取 → 校验路径 → 调用领域 → 返回 DTO"；回放控制器位于 `host-core` 插件
//! （经 [`host_core::ArtnetCoreExt`] 访问），回放逻辑位于 `player` crate。
//!
//! 涉及文件 IO 或模式切换的命令（打开节目、概览、曲线）都是 `async` 命令并在
//! `tauri::async_runtime::spawn_blocking` 线程上执行，不占用主线程；阻塞线程池的线程已进入
//! Tokio 运行时上下文，打开节目时切换应用模式、重建接收套接字所需的 reactor 可用。

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use parking_lot::{Mutex, MutexGuard};
use std::time::SystemTime;

use artrec_core::ArtRecReader;
use player::{Overview, ScanError, SeriesError};
use tauri::AppHandle;

use host_core::playback::{PlaybackStatus, RepeatMode};
use host_core::{ArtnetCoreExt, DispatchTarget};

use crate::recording_commands::resolved_dir;

/// 错误码：录制目录里找不到该节目或路径非法。
pub const ERR_BAD_PATH: &str = "bad_path";
/// 错误码：节目中不存在所请求的 Universe。
pub const ERR_UNKNOWN_UNIVERSE: &str = "unknown_universe";
/// 错误码：回放进行中，不能开始录制。
pub const ERR_PLAYBACK_ACTIVE: &str = "playback_active";
/// 错误码：节目编辑器正在输出灯光，不能开始录制。
pub const ERR_SHOW_ACTIVE: &str = host_core::playback::ERR_SHOW_ACTIVE;

/// 串行化"打开节目"与"开始录制"两条会改变录制 / 回放状态的命令路径。
///
/// 两者都是"先检查互斥，再改变状态"。它们改为 `async` + `spawn_blocking` 之前是同步命令，
/// 在主线程上天然串行；移到阻塞线程池后可能并发，检查与执行之间会出现竞态（例如同时开始
/// 录制与打开节目），故用这把进程级锁恢复原来的串行语义。
///
/// 用模块级 `static` 而非 `app.manage`：托管状态统一在 `src-tauri/src/lib.rs` 注册，而这把锁
/// 只服务于本文件与 `recording_commands` 两处命令，没有必要扩大到应用壳。
static SESSION_GATE: Mutex<()> = Mutex::new(());

/// 取得 [`SESSION_GATE`]（parking_lot 锁不毒化；它不保护任何数据，只用于串行化）。
///
/// # Returns
///
/// 守卫；在其作用域内其它"打开节目 / 开始录制"命令会等待。
pub(crate) fn session_gate() -> MutexGuard<'static, ()> {
    SESSION_GATE.lock()
}

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
pub async fn player_open(
    app: AppHandle,
    path: String,
    target: Option<DispatchTarget>,
) -> Result<PlaybackStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_blocking(&app, &path, target.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// [`player_open`] 的阻塞实现体（在 `spawn_blocking` 线程上运行，具备 Tokio 运行时上下文）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `path` - 节目路径。
/// * `target` - 输出目标。
///
/// # Returns
///
/// 节目刚打开时的初始 [`PlaybackStatus`]。
///
/// # Errors
///
/// 同 [`player_open`]。
fn open_blocking(
    app: &AppHandle,
    path: &str,
    target: DispatchTarget,
) -> Result<PlaybackStatus, String> {
    let file = checked_path(app, path)?;
    let name = recorder::read_sidecar(&file)
        .map(|m| m.name)
        .filter(|n| !n.trim().is_empty())
        .or_else(|| file.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let emit = crate::app_emitter(app);
    let library_dir = resolved_dir(app);
    let _gate = session_gate();
    app.artnet_core()
        .open_playback(emit, file, name, target, library_dir)
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

/// 设置前端正在查看的 Universe（决定二进制通道流的回放帧包含哪些 Universe）。
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

/// 读取（必要时生成并缓存到 `.artrec.ovw`）节目的时间线概览。
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

/// 命中 `.ovw` 缓存直接返回，否则并行扫描生成并写回缓存。
///
/// 生成后顺带把旧版 sidecar 里内嵌的 `overview` 字段去掉（一次性迁移）。缓存写入与迁移失败
/// （例如录制目录只读）都不影响本次结果。
///
/// # Arguments
///
/// * `file` - 已校验的节目路径。
/// * `buckets` - 期望桶数（未钳制）。
///
/// # Returns
///
/// 节目的时间线概览。
///
/// # Errors
///
/// 节目文件无法打开或解析时返回错误描述。
fn load_overview(file: &Path, buckets: u32) -> Result<Overview, String> {
    let want = buckets.clamp(player::overview::MIN_BUCKETS, player::overview::MAX_BUCKETS);
    if let Some(hit) = cached_overview(file, want) {
        return Ok(hit);
    }

    let reader = open_shared(file)?;
    let overview =
        player::build_overview_parallel(&reader, file, want).map_err(|e| e.to_string())?;
    let _ = recorder::write_overview_cache(file, &player::encode_overview(&overview));
    let _ = recorder::purge_legacy_overview(file);
    Ok(overview)
}

/// 读取并校验 `.ovw` 缓存。
///
/// 是否匹配只需比较文件字节数与帧数（帧数取自文件头，与帧索引条数相同），因此这里只读
/// 文件头与 Universe 表、不解析帧索引：节目库缩略图批量请求概览时，命中的代价是读一个小文件
/// 加读文件头。
///
/// # Arguments
///
/// * `file` - 节目路径。
/// * `want` - 已钳制的桶数。
///
/// # Returns
///
/// 缓存存在、格式合法且版本、桶数、文件字节数与帧数都与当前文件一致时返回概览，否则返回 `None`。
fn cached_overview(file: &Path, want: u32) -> Option<Overview> {
    let cached = player::decode_overview(&recorder::read_overview_cache(file)?)?;
    let mut src = File::open(file).ok()?;
    let (len, header, _) = artrec_core::read_header_and_unis(&mut src).ok()?;
    (cached.buckets == want && cached.matches(len, u64::from(header.frame_count))).then_some(cached)
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
        let reader = open_shared(&file)?;
        player::channel_series_parallel(
            &reader,
            &file,
            query.universe,
            &query.channels,
            query.t0_us,
            query.t1_us,
            query.max_points,
        )
        .map_err(series_error)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把并行扫描错误映射为前端错误码：Universe 不存在为 [`ERR_UNKNOWN_UNIVERSE`]，其余为描述文本。
///
/// # Arguments
///
/// * `e` - 并行扫描错误。
///
/// # Returns
///
/// 前端可识别的错误字符串。
fn series_error(e: ScanError) -> String {
    match e {
        ScanError::Series(SeriesError::UnknownUniverse(_)) => ERR_UNKNOWN_UNIVERSE.to_string(),
        other => other.to_string(),
    }
}

/// 读取器缓存容量：概览与曲线通常只针对当前节目，留 2 项容纳"切换节目时的前一个"。
const READER_CACHE_CAP: usize = 2;

/// 读取器缓存键：规范化路径 + 文件字节数 + 修改时间（文件被改写后自动失效）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReaderKey {
    /// 规范化后的节目路径（来自 [`recorder::resolve_in_dir`]）。
    path: PathBuf,
    /// 文件字节数。
    len: u64,
    /// 修改时间；平台不支持时为 `None`。
    modified: Option<SystemTime>,
}

/// 只报告长度、不提供数据的占位数据源。
///
/// 缓存里的模板读取器只用于派生（[`ArtRecReader::with_source`] 共享已解析的头、Universe 表
/// 与帧索引），用它代替真实文件句柄，缓存就不会长期占用节目文件（不妨碍改名、移入回收站或
/// 弹出移动硬盘）。读帧时总是返回错误——模板从不直接用于读帧。
#[derive(Debug)]
struct Detached {
    /// 声称的总长度（与原文件一致，满足 `with_source` 的长度校验）。
    len: u64,
    /// 当前位置。
    pos: u64,
}

impl Read for Detached {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("模板读取器不提供帧数据"))
    }
}

impl Seek for Detached {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let next = match pos {
            SeekFrom::Start(p) => Some(p),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        };
        self.pos = next.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek 越界"))?;
        Ok(self.pos)
    }
}

/// 最近使用的模板读取器（最近使用的在前，最多 [`READER_CACHE_CAP`] 项）。
///
/// `ArtRecReader` 是 `Send` 但不是 `Sync`，放在 `Mutex` 里即可跨线程共享；每次使用时在
/// 当前线程上 `with_source` 派生一个持有新文件句柄的读取器，模板本身从不离开锁。
/// 用模块级 `static`（`LazyLock`）而非 `app.manage`：托管状态统一在 `src-tauri/src/lib.rs`
/// 注册，这份缓存只服务于本文件的概览 / 曲线命令。
static READERS: LazyLock<Mutex<ReaderLru>> =
    LazyLock::new(|| Mutex::new(Vec::with_capacity(READER_CACHE_CAP)));

/// 读取器缓存的内容：(键, 模板读取器)，最近使用的在前。
type ReaderLru = Vec<(ReaderKey, ArtRecReader<Detached>)>;

/// 加锁读取器缓存（parking_lot 锁不毒化；缓存项总是完整构造后才放入）。
fn readers() -> MutexGuard<'static, ReaderLru> {
    READERS.lock()
}

/// 打开节目供概览 / 曲线扫描使用：命中缓存时只打开文件并共享已解析的帧索引，
/// 拖动曲线时不必反复解析整张帧索引。
///
/// # Arguments
///
/// * `file` - 已校验（规范化）的节目路径。
///
/// # Returns
///
/// 持有独立文件句柄的读取器。
///
/// # Errors
///
/// 文件无法打开或解析时返回错误描述。
fn open_shared(file: &Path) -> Result<ArtRecReader<File>, String> {
    let meta = std::fs::metadata(file).map_err(|e| e.to_string())?;
    let key = ReaderKey {
        path: file.to_path_buf(),
        len: meta.len(),
        modified: meta.modified().ok(),
    };
    let src = File::open(file).map_err(|e| e.to_string())?;
    let src = {
        let mut lru = readers();
        match lru.iter().position(|(k, _)| *k == key) {
            Some(pos) => {
                let entry = lru.remove(pos);
                let derived = entry.1.with_source(src);
                lru.insert(0, entry);
                match derived {
                    Ok(reader) => return Ok(reader),
                    // 长度与模板不符：文件在取元数据之后被改写，重新打开并解析
                    Err(_) => File::open(file).map_err(|e| e.to_string())?,
                }
            }
            None => src,
        }
    };

    // 未命中：解析帧索引（不持锁），再把模板放进缓存
    let reader = ArtRecReader::from_reader(src).map_err(|e| e.to_string())?;
    let detached = Detached {
        len: reader.file_len(),
        pos: 0,
    };
    if let Ok(template) = reader.with_source(detached) {
        let mut lru = readers();
        // 同一路径只保留最新版本
        lru.retain(|(k, _)| k.path != key.path);
        lru.insert(0, (key, template));
        lru.truncate(READER_CACHE_CAP);
    }
    Ok(reader)
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
/// 调用方应持有 [`session_gate`]，使检查与随后的开始录制不被并发的打开节目打断。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
///
/// # Errors
///
/// - 已打开节目，或处于播放器模式（此时实时接收已停止，没有东西可录）时返回 [`ERR_PLAYBACK_ACTIVE`]。
/// - 节目编辑器正在输出灯光（此时实时帧被丢弃）时返回 [`ERR_SHOW_ACTIVE`]。
pub fn ensure_not_playing(app: &AppHandle) -> Result<(), String> {
    let core = app.artnet_core();
    if core.is_show_active() {
        return Err(ERR_SHOW_ACTIVE.to_string());
    }
    if core.playback().is_loaded()
        || core.app_mode_status().mode == host_core::app_mode::AppMode::Player
    {
        Err(ERR_PLAYBACK_ACTIVE.to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read, Seek, SeekFrom};

    use artrec_core::{ArtRecReader, ArtRecWriter, CompressAlgo, UniDesc};
    use player::ScanError;

    use super::{
        cached_overview, load_overview, open_shared, readers, series_error, Detached,
        ERR_UNKNOWN_UNIVERSE, READER_CACHE_CAP,
    };

    /// 串行化会访问进程级读取器缓存的测试（避免并行测试互相淘汰缓存项）。
    static SERIAL: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    /// 取得测试串行锁。
    fn serial() -> parking_lot::MutexGuard<'static, ()> {
        SERIAL.lock()
    }

    /// 测试用临时目录（作用域结束时删除）。
    struct Tmp(std::path::PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Self {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let p =
                std::env::temp_dir().join(format!("ans-playback-{tag}-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            Self(std::fs::canonicalize(p).unwrap())
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 写出一个 2 路、`frames` 帧的节目。
    fn write_program(path: &std::path::Path, frames: u64) {
        let unis = vec![
            UniDesc::from_universe(1, 512).unwrap(),
            UniDesc::from_universe(2, 512).unwrap(),
        ];
        let mut w =
            ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 3, 0, 0).unwrap();
        for i in 0..frames {
            w.add_full_frame(i * 25_000, &[vec![i as u8; 512], vec![(i * 3) as u8; 512]])
                .unwrap();
        }
        std::fs::write(path, w.finish(frames * 25_000).unwrap().into_inner()).unwrap();
    }

    #[test]
    fn detached_source_reports_length_but_no_data() {
        let mut d = Detached { len: 100, pos: 0 };
        assert_eq!(d.seek(SeekFrom::End(0)).unwrap(), 100);
        assert_eq!(d.seek(SeekFrom::Current(-40)).unwrap(), 60);
        assert_eq!(d.seek(SeekFrom::Start(7)).unwrap(), 7);
        assert!(d.seek(SeekFrom::Current(-8)).is_err());
        assert!(d.read(&mut [0u8; 4]).is_err());
    }

    #[test]
    fn overview_is_generated_cached_and_invalidated() {
        let _serial = serial();
        let dir = Tmp::new("ovw");
        let file = dir.0.join("show.artrec");
        write_program(&file, 40);
        // 旧版 sidecar：内嵌概览
        std::fs::write(
            recorder::sidecar_path(&file),
            r#"{"name":"旧节目","overview":{"version":1,"buckets":16}}"#,
        )
        .unwrap();

        assert!(cached_overview(&file, 64).is_none(), "首次没有缓存");
        let first = load_overview(&file, 64).unwrap();
        assert_eq!((first.buckets, first.frames), (64, 40));
        let want = player::build_overview(&ArtRecReader::open_file(&file).unwrap(), 64);
        assert_eq!(first, want, "与串行扫描结果一致");
        assert!(recorder::overview_cache_path(&file).exists(), "应写出 .ovw");
        let side = std::fs::read_to_string(recorder::sidecar_path(&file)).unwrap();
        assert!(!side.contains("\"overview\""), "旧字段应被迁移掉: {side}");
        assert_eq!(recorder::read_sidecar(&file).unwrap().name, "旧节目");

        // 命中：同桶数直接取缓存；桶数不同不命中
        assert_eq!(cached_overview(&file, 64), Some(first.clone()));
        assert!(cached_overview(&file, 128).is_none());
        assert_eq!(load_overview(&file, 64).unwrap(), first);

        // 文件改写（帧数与长度变化）后缓存失效并重新生成
        write_program(&file, 55);
        assert!(cached_overview(&file, 64).is_none());
        assert_eq!(load_overview(&file, 64).unwrap().frames, 55);

        // 缓存损坏：当作未命中
        std::fs::write(recorder::overview_cache_path(&file), b"garbage").unwrap();
        assert!(cached_overview(&file, 64).is_none());
        assert_eq!(load_overview(&file, 64).unwrap().frames, 55);
    }

    #[test]
    fn reader_cache_reuses_index_and_tracks_file_changes() {
        let _serial = serial();
        let dir = Tmp::new("lru");
        let a = dir.0.join("a.artrec");
        let b = dir.0.join("b.artrec");
        let c = dir.0.join("c.artrec");
        write_program(&a, 10);
        write_program(&b, 20);
        write_program(&c, 30);

        let first = open_shared(&a).unwrap();
        let again = open_shared(&a).unwrap();
        assert!(
            std::ptr::eq(first.index().as_ptr(), again.index().as_ptr()),
            "命中缓存时共享同一份帧索引"
        );
        assert_eq!(
            again.resolve_frame(3).unwrap()[0][0],
            3,
            "派生的读取器能正常读帧"
        );

        // 容量 2：a、b 之后再打开 c，最久未用的 a 被淘汰
        let _ = open_shared(&b).unwrap();
        let _ = open_shared(&c).unwrap();
        let cached: Vec<_> = readers().iter().map(|(k, _)| k.path.clone()).collect();
        assert_eq!(cached, vec![c.clone(), b.clone()], "最近使用的在前");
        assert!(cached.len() <= READER_CACHE_CAP);

        // 文件改写后键（长度 / 修改时间）变化，重新解析；同一路径只保留最新版本
        write_program(&b, 25);
        assert_eq!(open_shared(&b).unwrap().index().len(), 25);
        let cached: Vec<_> = readers().iter().map(|(k, _)| k.path.clone()).collect();
        assert_eq!(cached, vec![b, c]);
    }

    #[test]
    fn unknown_universe_maps_to_error_code() {
        let e = ScanError::Series(player::SeriesError::UnknownUniverse(9));
        assert_eq!(series_error(e), ERR_UNKNOWN_UNIVERSE);
        let other = series_error(ScanError::Series(player::SeriesError::TooManyChannels));
        assert_ne!(other, ERR_UNKNOWN_UNIVERSE);
    }
}
