//! 烘焙：把"按时间取帧"的数据源写成 `.artrec` 节目文件。
//!
//! 节目编辑器保存时用它把时间线渲染成核心板可直接回放的文件。本模块不关心帧从哪来：
//! 调用方给出 Universe 列表、总时长和一个 `fill` 回调，回调在每个采样时刻把各 Universe 的
//! 512 通道写进缓冲。写入沿用录制的 [`FrameEncoder`]（Zstd + 变更触发 + 收尾帧），
//! 因此静止的段落不产生帧，产物与录制得到的文件完全同构。
//!
//! 落盘是"临时文件 + 重命名"：烘焙中途失败或被取消，已有的 `.artrec` 保持原样，不留残片。

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use artrec_core::{ArtRecError, ArtRecWriter, UniDesc, FLAG_LOOP};

use crate::encoder::{EncoderConfig, FrameEncoder};
use crate::session::DMX_LEN;
use crate::sidecar::{overview_cache_path, read_sidecar, write_sidecar};

/// 烘焙参数。
#[derive(Debug, Clone, Copy)]
pub struct BakeSpec<'a> {
    /// 写入文件的 Universe（升序、不重复；顺序即 `fill` 缓冲的顺序）。
    pub universes: &'a [u16],
    /// 节目总时长（微秒）。
    pub duration_us: u64,
    /// 采样帧率（每秒采样几次）。
    pub fps: u32,
    /// 是否在文件头标记"推荐循环播放"。
    pub looping: bool,
}

/// 烘焙结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BakeReport {
    /// 实际写入的帧数（静止段落不写帧）。
    pub frames: u64,
    /// 节目总时长（微秒）。
    pub duration_us: u64,
    /// 文件字节数。
    pub bytes: u64,
    /// 文件内的 Universe。
    pub universes: Vec<u16>,
}

/// 烘焙错误。
#[derive(Debug, thiserror::Error)]
pub enum BakeError {
    /// 没有可输出的 Universe，或时长 / 帧率为 0。
    #[error("没有可烘焙的内容")]
    Empty,
    /// 被调用方取消；临时文件已清理。
    #[error("烘焙已取消")]
    Cancelled,
    /// ArtRec 编码错误（Universe 过多、编号越界等）。
    #[error("编码失败: {0}")]
    Encode(#[from] ArtRecError),
    /// 文件系统错误。
    #[error("文件错误: {0}")]
    Io(#[from] io::Error),
}

/// 当前时间（Unix 微秒）。
fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

/// 烘焙过程中使用的临时文件路径。
fn temp_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".bake");
    PathBuf::from(s)
}

/// 烘焙并写出 `.artrec`，成功后同步更新 sidecar、清除概览缓存。
///
/// 采样时刻为 `k / fps`（k 从 0 到总时长对应的最后一个采样点）；数据与上一帧完全相同则不写帧，
/// 最后补一帧收尾帧使末帧时间戳等于总时长。
///
/// # Arguments
///
/// * `dest` - 目标 `.artrec` 路径（所在目录必须存在）；成功时原子替换同名文件。
/// * `spec` - 烘焙参数。
/// * `cancel` - 取消标志；每采样一帧检查一次，被置位则放弃并清理临时文件。
/// * `progress` - 进度回调，参数为 `0.0..=1.0`，约每百帧调用一次，完成时调用 `1.0`。
/// * `fill` - 取帧回调：参数为采样时刻（微秒）和与 `spec.universes` 一一对应的缓冲（每个 512 字节，
///   调用前内容为上一次的结果，回调必须写满）。
///
/// # Returns
///
/// 烘焙报告。
///
/// # Errors
///
/// - [`BakeError::Empty`]：没有 Universe，或时长 / 帧率为 0。
/// - [`BakeError::Cancelled`]：`cancel` 被置位。
/// - [`BakeError::Encode`]：Universe 编号越界、数量过多等。
/// - [`BakeError::Io`]：创建、写入或重命名失败。
pub fn bake_file(
    dest: &Path,
    spec: BakeSpec<'_>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
    mut fill: impl FnMut(u64, &mut [Vec<u8>]),
) -> Result<BakeReport, BakeError> {
    if spec.universes.is_empty() || spec.duration_us == 0 || spec.fps == 0 {
        return Err(BakeError::Empty);
    }
    let tmp = temp_path(dest);
    let result = bake_to_temp(&tmp, spec, cancel, progress, &mut fill);
    let report = match result {
        Ok(report) => report,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }

    // 文件已就位：同步元数据，并让旧的概览缓存失效
    let mut meta = read_sidecar(dest).unwrap_or_default();
    meta.universes.clone_from(&report.universes);
    meta.duration_us = report.duration_us;
    meta.frames = report.frames;
    meta.bytes = report.bytes;
    write_sidecar(dest, &meta)?;
    let _ = std::fs::remove_file(overview_cache_path(dest));
    progress(1.0);
    Ok(report)
}

/// 把帧写进临时文件。
fn bake_to_temp(
    tmp: &Path,
    spec: BakeSpec<'_>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
    fill: &mut impl FnMut(u64, &mut [Vec<u8>]),
) -> Result<BakeReport, BakeError> {
    let unis = spec
        .universes
        .iter()
        .map(|&u| UniDesc::from_universe(u, DMX_LEN))
        .collect::<Result<Vec<_>, _>>()?;
    let cfg = EncoderConfig::default();
    let flags = cfg.file_flags() | if spec.looping { FLAG_LOOP } else { 0 };
    let sink = BufWriter::new(File::create(tmp)?);
    let mut writer = ArtRecWriter::new(sink, unis, cfg.algo, cfg.level, flags, now_us())?;
    let mut encoder = FrameEncoder::new(cfg);

    let fps = u64::from(spec.fps);
    let last_index = spec.duration_us * fps / 1_000_000;
    let mut buffers = vec![vec![0u8; usize::from(DMX_LEN)]; spec.universes.len()];
    for k in 0..=last_index {
        if cancel.load(Ordering::Relaxed) {
            return Err(BakeError::Cancelled);
        }
        let time_us = (k * 1_000_000 / fps).min(spec.duration_us);
        fill(time_us, &mut buffers);
        encoder.encode(&mut writer, time_us, &buffers)?;
        if k % 100 == 0 {
            // 采样点数远小于 u32 上限（一小时 30 FPS 才 10.8 万）；饱和转换仅为满足 clippy
            let done = f64::from(u32::try_from(k).unwrap_or(u32::MAX));
            let total = f64::from(u32::try_from(last_index.max(1)).unwrap_or(u32::MAX));
            progress((done / total) as f32);
        }
    }
    encoder.encode_tail(&mut writer, spec.duration_us)?;
    let frames = writer.frame_count() as u64;
    let mut sink = writer.finish(spec.duration_us)?;
    sink.flush()?;
    // 改名前落盘：断电后要么是旧文件、要么是完整的新文件，不会留下半截烘焙结果。
    sink.get_ref().sync_all()?;
    let bytes = sink.get_ref().metadata()?.len();
    Ok(BakeReport {
        frames,
        duration_us: spec.duration_us,
        bytes,
        universes: spec.universes.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::list_library_uncached;
    use crate::show_store::{save_show, SaveRequest};
    use crate::sidecar::{write_overview_cache, SOURCE_EDITOR};
    use crate::testutil::TempDir;

    fn no_progress(_: f32) {}

    fn spec(universes: &[u16], duration_us: u64) -> BakeSpec<'_> {
        BakeSpec { universes, duration_us, fps: 30, looping: false }
    }

    #[test]
    fn 静止的段落不写帧_只有变化点与收尾帧() {
        let dir = TempDir::new("bake-basic");
        let dest = dir.path().join("a.artrec");
        // 0~1 秒全 0，1 秒起全 200；总长 2 秒
        let report = bake_file(
            &dest,
            spec(&[0, 3], 2_000_000),
            &AtomicBool::new(false),
            &mut no_progress,
            |t, bufs| {
                let v = if t >= 1_000_000 { 200 } else { 0 };
                for b in bufs.iter_mut() {
                    b.fill(v);
                }
            },
        )
        .unwrap();
        // 首帧 + 变化帧 + 收尾帧
        assert_eq!(report.frames, 3);
        assert_eq!(report.universes, vec![0, 3]);
        assert!(report.bytes > 0 && dest.is_file());
        assert!(!temp_path(&dest).exists(), "不留临时文件");
        let list = list_library_uncached(dir.path());
        assert_eq!(list.len(), 1);
        assert!(list[0].valid);
        assert_eq!((list[0].frames, list[0].duration_us), (3, 2_000_000));
        assert_eq!(list[0].universes, vec![0, 3]);
    }

    #[test]
    fn 每帧都变化时按采样率写帧() {
        let dir = TempDir::new("bake-fps");
        let dest = dir.path().join("a.artrec");
        let report = bake_file(
            &dest,
            spec(&[1], 1_000_000),
            &AtomicBool::new(false),
            &mut no_progress,
            |t, bufs| bufs[0].fill((t / 33_000) as u8),
        )
        .unwrap();
        // 0..=30 共 31 个采样点；末采样点恰为总时长，无需额外收尾帧
        assert_eq!(report.frames, 31);
    }

    #[test]
    fn 成功后更新sidecar_保留名称与来源_清除概览缓存() {
        let dir = TempDir::new("bake-sidecar");
        let dest = save_show(
            dir.path(),
            SaveRequest { path: None, name: "开场", notes: "n", file_stem: "开场", json: "{}" },
        )
        .unwrap();
        write_overview_cache(&dest, b"old").unwrap();
        bake_file(&dest, spec(&[0], 500_000), &AtomicBool::new(false), &mut no_progress, |_, b| b[0].fill(9)).unwrap();
        let meta = read_sidecar(&dest).unwrap();
        assert_eq!((meta.name.as_str(), meta.source.as_str()), ("开场", SOURCE_EDITOR));
        assert_eq!((meta.duration_us, meta.universes.clone()), (500_000, vec![0]));
        assert!(meta.frames >= 1 && meta.bytes > 0);
        assert!(!overview_cache_path(&dest).exists());
        let list = list_library_uncached(dir.path());
        assert!(list[0].editable && list[0].exported && list[0].valid);
    }

    #[test]
    fn 取消时清理临时文件_已有的artrec保持原样() {
        let dir = TempDir::new("bake-cancel");
        let dest = dir.path().join("a.artrec");
        std::fs::write(&dest, b"old").unwrap();
        let cancel = AtomicBool::new(false);
        let mut calls: u8 = 0;
        let err = bake_file(&dest, spec(&[0], 5_000_000), &cancel, &mut no_progress, |_, b| {
            calls += 1;
            b[0].fill(calls);
            if calls == 10 {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err();
        assert!(matches!(err, BakeError::Cancelled));
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        assert!(!temp_path(&dest).exists());
    }

    #[test]
    fn 无内容或参数为零报错() {
        let dir = TempDir::new("bake-empty");
        let dest = dir.path().join("a.artrec");
        let cancel = AtomicBool::new(false);
        for s in [spec(&[], 1_000_000), spec(&[0], 0), BakeSpec { fps: 0, ..spec(&[0], 1_000_000) }] {
            let err = bake_file(&dest, s, &cancel, &mut no_progress, |_, _| {}).unwrap_err();
            assert!(matches!(err, BakeError::Empty));
        }
        assert!(!dest.exists());
    }

    #[test]
    fn universe越界报编码错误_不留文件() {
        let dir = TempDir::new("bake-range");
        let dest = dir.path().join("a.artrec");
        let err = bake_file(&dest, spec(&[5000], 1_000_000), &AtomicBool::new(false), &mut no_progress, |_, _| {}).unwrap_err();
        assert!(matches!(err, BakeError::Encode(_)));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn 循环标志写入文件头() {
        let dir = TempDir::new("bake-loop");
        let dest = dir.path().join("a.artrec");
        let s = BakeSpec { looping: true, ..spec(&[0], 500_000) };
        bake_file(&dest, s, &AtomicBool::new(false), &mut no_progress, |_, b| b[0].fill(1)).unwrap();
        let reader = artrec_core::ArtRecReader::open_file(&dest).unwrap();
        assert!(reader.header().loop_play());
    }

    #[test]
    fn 进度单调且以_1_结束() {
        let dir = TempDir::new("bake-progress");
        let dest = dir.path().join("a.artrec");
        let mut seen: Vec<f32> = Vec::new();
        bake_file(&dest, spec(&[0], 10_000_000), &AtomicBool::new(false), &mut |p| seen.push(p), |t, b| b[0].fill((t / 40_000) as u8)).unwrap();
        assert!(seen.len() >= 3);
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        assert!((seen.last().copied().unwrap() - 1.0).abs() < f32::EPSILON);
    }
}
