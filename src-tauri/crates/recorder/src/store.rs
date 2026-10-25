//! 崩溃安全的磁盘落盘与孤立录制恢复。
//!
//! 录制期间写入 `名称.artrec.part`，同时把每个已写 Chunk 的帧索引追加到
//! `名称.artrec.idx`（每帧 16 字节，与 `.artrec` 内索引条目同格式）。
//! 正常结束时补写索引表、回填头部、原子重命名为 `名称.artrec` 并写 sidecar；
//! 异常退出后由 [`recover_orphans`] 依据索引日志重建出可播放的文件。
//!
//! 落盘顺序保证：[`FileRecorder::checkpoint`] 先刷 `.part` 再刷日志，
//! 因此日志中出现的条目对应的 Chunk 一定已写入磁盘。

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use artrec_core::{
    ArtRecError, ArtRecWriter, ChunkHdr, FileHeader, FrameIndex, UniDesc, CHUNKHDR_SIZE,
    FRAMEINDEX_SIZE, HEADER_SIZE, UNIDESC_SIZE,
};
use serde::Serialize;

use crate::encoder::Encoded;
use crate::session::{RecorderSession, SessionConfig, SessionStats};
use crate::sidecar::{write_sidecar, Sidecar, SIDECAR_VERSION};

/// 录制中的临时文件后缀。
pub const PART_SUFFIX: &str = ".artrec.part";
/// 索引日志后缀。
pub const JOURNAL_SUFFIX: &str = ".artrec.idx";
/// 完成文件后缀。
pub const ARTREC_SUFFIX: &str = ".artrec";

/// 写缓冲大小。
const BUF_CAPACITY: usize = 64 * 1024;

/// 落盘层错误。
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// 文件系统错误。
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    /// ArtRec 编码错误。
    #[error("ArtRec 错误: {0}")]
    ArtRec(#[from] ArtRecError),
}

/// 把用户输入的名称规整为安全的文件名主干：替换非法字符、去除首尾空白与点、
/// 避开 Windows 保留名并限制长度；结果为空时回落 `recording`。
///
/// # Arguments
///
/// * `name` - 用户输入的原始名称。
///
/// # Returns
///
/// 可安全用作文件名主干的字符串：非法字符与控制字符替换为 `_`，最长 80 个字符，
/// 命中 Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM0`-`COM9`、`LPT0`-`LPT9`）时加 `_` 前缀，
/// 规整后为空则返回 `recording`。
#[must_use]
pub fn sanitize_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let limited: String = trimmed.chars().take(80).collect();
    let limited = limited.trim().to_string();
    if limited.is_empty() {
        return "recording".to_string();
    }
    let upper = limited.to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        format!("_{limited}")
    } else {
        limited
    }
}

/// 在目录内为 `stem` 找一个不与任何 `suffixes` 冲突的名字（冲突时追加 `-2`、`-3`…）。
fn unique_stem(dir: &Path, stem: &str, suffixes: &[&str]) -> String {
    let taken = |s: &str| suffixes.iter().any(|suf| dir.join(format!("{s}{suf}")).exists());
    if !taken(stem) {
        return stem.to_string();
    }
    (2u32..=u32::MAX)
        .map(|n| format!("{stem}-{n}"))
        .find(|c| !taken(c))
        .unwrap_or_else(|| stem.to_string())
}

/// 开始录制所需的非会话参数。
#[derive(Debug, Clone)]
pub struct StartParams {
    /// 录制目录。
    pub dir: PathBuf,
    /// 文件名主干（会被 [`sanitize_file_stem`] 规整并去重）。
    pub stem: String,
    /// 节目显示名。
    pub name: String,
    /// 备注。
    pub notes: String,
    /// 创建时间（Unix 毫秒）。
    pub created_unix_ms: u64,
    /// 应用版本。
    pub app_version: String,
    /// 合并模式字符串（写入 sidecar）。
    pub merge_mode: String,
    /// 合并引擎源超时（毫秒）。
    pub source_timeout_ms: u64,
}

/// 录制结束的结果。
#[derive(Debug, Clone)]
pub struct Finished {
    /// 最终 `.artrec` 路径。
    pub path: PathBuf,
    /// 最终统计。
    pub stats: SessionStats,
    /// 已写入 sidecar 的元数据。
    pub sidecar: Sidecar,
}

/// 正在进行的磁盘录制。
pub struct FileRecorder {
    session: RecorderSession<BufWriter<File>>,
    journal: BufWriter<File>,
    part: PathBuf,
    idx: PathBuf,
    final_path: PathBuf,
    meta: Sidecar,
}

impl FileRecorder {
    /// 创建 `.part` 与索引日志并开始会话。
    ///
    /// # Arguments
    ///
    /// * `params` - 目录、文件名与元数据参数。
    /// * `cfg` - 会话配置（过滤、Universe 集合、合并与编码策略）。
    ///
    /// # Returns
    ///
    /// 已创建 `.part` 文件与索引日志、头部与 Universe 表已落盘的 [`FileRecorder`]。
    ///
    /// # Errors
    ///
    /// 目录不可写、Universe 非法等返回 [`StoreError`]。
    pub fn start(params: StartParams, cfg: SessionConfig) -> Result<Self, StoreError> {
        fs::create_dir_all(&params.dir)?;
        let stem = unique_stem(
            &params.dir,
            &sanitize_file_stem(&params.stem),
            &[ARTREC_SUFFIX, PART_SUFFIX],
        );
        let part = params.dir.join(format!("{stem}{PART_SUFFIX}"));
        let idx = params.dir.join(format!("{stem}{JOURNAL_SUFFIX}"));
        let final_path = params.dir.join(format!("{stem}{ARTREC_SUFFIX}"));

        let part_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&part)?;
        let journal_file = match OpenOptions::new().write(true).create_new(true).open(&idx) {
            Ok(f) => f,
            Err(e) => {
                let _ = fs::remove_file(&part);
                return Err(e.into());
            }
        };

        let meta = Sidecar {
            version: SIDECAR_VERSION,
            name: params.name,
            notes: params.notes,
            created_unix_ms: params.created_unix_ms,
            app_version: params.app_version,
            filter: cfg.filter.clone(),
            universes: cfg.universes.clone(),
            merge_mode: params.merge_mode,
            ..Sidecar::default()
        };
        let session = match RecorderSession::new(
            BufWriter::with_capacity(BUF_CAPACITY, part_file),
            cfg,
            params.source_timeout_ms,
        ) {
            Ok(s) => s,
            Err(e) => {
                let _ = fs::remove_file(&part);
                let _ = fs::remove_file(&idx);
                return Err(e.into());
            }
        };
        let mut rec = Self {
            session,
            journal: BufWriter::with_capacity(4096, journal_file),
            part,
            idx,
            final_path,
            meta,
        };
        // 让头部与 Universe 表尽早落盘，崩溃后文件始终可解析
        rec.checkpoint()?;
        Ok(rec)
    }

    /// 最终 `.artrec` 路径（录制完成后才存在）。
    ///
    /// # Returns
    ///
    /// 录制正常结束后文件将被重命名到的目标路径。
    #[must_use]
    pub fn final_path(&self) -> &Path {
        &self.final_path
    }

    /// 摄入一帧，见 [`RecorderSession::ingest`]。
    ///
    /// # Arguments
    ///
    /// * `frame` - 接收到的帧。
    /// * `t_us` - 该帧到达时刻（相对录制起点，微秒）。
    pub fn ingest(&mut self, frame: &artnet_net::DmxFrame, t_us: u64) {
        self.session.ingest(frame, t_us);
    }

    /// 周期性调用：变更检测并写帧，写出的帧索引同步追加到日志。
    ///
    /// # Returns
    ///
    /// 写入了帧则返回 [`Encoded`]，无新数据或数据无变化时返回 `None`。
    ///
    /// # Errors
    ///
    /// 写盘失败返回 [`StoreError`]（调用方应终止录制并提示用户）。
    pub fn tick(&mut self) -> Result<Option<Encoded>, StoreError> {
        let e = self.session.tick()?;
        if let Some(enc) = &e {
            self.journal.write_all(&enc.index.to_bytes())?;
        }
        Ok(e)
    }

    /// 检查点：先刷 `.part` 再刷索引日志并 `sync_data`，建议约每秒调用一次。
    ///
    /// # Errors
    ///
    /// 写盘失败返回 [`StoreError`]。
    pub fn checkpoint(&mut self) -> Result<(), StoreError> {
        self.session.flush()?;
        self.session.sink().get_ref().sync_data()?;
        self.journal.flush()?;
        self.journal.get_ref().sync_data()?;
        Ok(())
    }

    /// 实时统计。
    ///
    /// # Returns
    ///
    /// 当前时刻的 [`SessionStats`] 快照。
    #[must_use]
    pub fn stats(&self) -> SessionStats {
        self.session.stats()
    }

    /// 正常结束：补收尾帧与索引、回填头部、原子重命名并写 sidecar。
    ///
    /// # Arguments
    ///
    /// * `total_us` - 录制总时长（微秒）。
    ///
    /// # Returns
    ///
    /// [`Finished`]，含最终 `.artrec` 路径、最终统计与已写入的 sidecar 元数据。
    ///
    /// # Errors
    ///
    /// 任一步失败返回 [`StoreError`]；失败时 `.part` 与日志保留，可由 [`recover_orphans`] 恢复。
    pub fn finish(self, total_us: u64) -> Result<Finished, StoreError> {
        let Self {
            session,
            journal,
            part,
            idx,
            final_path,
            mut meta,
        } = self;
        let sources = session.sources_seen();
        let protocols = session.protocols_seen();
        let ignored = session.ignored_universes();
        let (bw, stats) = session.finish(total_us)?;
        let file = bw.into_inner().map_err(std::io::IntoInnerError::into_error)?;
        file.sync_all()?;
        drop(file);
        drop(journal);

        fs::rename(&part, &final_path)?;
        let _ = fs::remove_file(&idx);

        meta.sources = sources;
        meta.protocols = protocols;
        meta.ignored_universes = ignored;
        meta.duration_us = stats.duration_us;
        meta.frames = stats.frames;
        meta.bytes = fs::metadata(&final_path).map_or(stats.bytes, |m| m.len());
        write_sidecar(&final_path, &meta)?;
        Ok(Finished {
            path: final_path,
            stats,
            sidecar: meta,
        })
    }

    /// 取消录制并删除 `.part` 与日志。
    pub fn cancel(self) {
        let Self {
            session,
            journal,
            part,
            idx,
            ..
        } = self;
        let (file, _) = session.abandon().into_parts();
        drop(file);
        let (jfile, _) = journal.into_parts();
        drop(jfile);
        let _ = fs::remove_file(part);
        let _ = fs::remove_file(idx);
    }

    /// 模拟崩溃：丢弃用户态缓冲、保留磁盘文件（仅测试）。
    #[cfg(test)]
    fn crash(self) {
        let (file, _) = self.session.abandon().into_parts();
        drop(file);
        let (jfile, _) = self.journal.into_parts();
        drop(jfile);
    }
}

/// 一次孤立录制的恢复结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RecoveryOutcome {
    /// 已恢复为可播放的 `.artrec`。
    #[serde(rename_all = "camelCase")]
    Recovered {
        /// 恢复后的文件路径。
        path: PathBuf,
        /// 恢复的帧数。
        frames: u64,
        /// 恢复的时长（微秒）。
        duration_us: u64,
    },
    /// 没有任何有效帧，已清理残留文件。
    #[serde(rename_all = "camelCase")]
    Discarded {
        /// 被清理的 `.part` 路径。
        part: PathBuf,
    },
    /// 无法恢复，残留文件已改名为 `.bad` 以免重复处理。
    #[serde(rename_all = "camelCase")]
    Failed {
        /// 原 `.part` 路径。
        part: PathBuf,
        /// 失败原因。
        reason: String,
    },
}

/// 扫描目录中的孤立 `.artrec.part` 并恢复。
///
/// **只应在应用启动、尚未开始任何录制时调用**，否则会把正在写入的文件当作孤立文件。
///
/// # Arguments
///
/// * `dir` - 录制目录。
///
/// # Returns
///
/// 每个孤立文件一条结果；目录不存在或无孤立文件时为空。
#[must_use]
pub fn recover_orphans(dir: &Path) -> Vec<RecoveryOutcome> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut parts: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(PART_SUFFIX))
        })
        .collect();
    parts.sort();
    parts
        .into_iter()
        .map(|part| match recover_one(&part) {
            Ok(o) => o,
            Err(e) => {
                let mut bad = part.as_os_str().to_owned();
                bad.push(".bad");
                let _ = fs::rename(&part, PathBuf::from(bad));
                RecoveryOutcome::Failed {
                    part,
                    reason: e.to_string(),
                }
            }
        })
        .collect()
}

#[allow(clippy::too_many_lines)] // 恢复流程是一条线性的"校验 → 截断 → 补尾 → 改名"，拆分反而难读
fn recover_one(part: &Path) -> Result<RecoveryOutcome, StoreError> {
    let dir = part.parent().unwrap_or_else(|| Path::new("."));
    let name = part
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let stem = name.strip_suffix(PART_SUFFIX).unwrap_or(name).to_string();
    let idx_path = dir.join(format!("{stem}{JOURNAL_SUFFIX}"));

    let mut f = File::open(part)?;
    let len = f.metadata()?.len();
    // 头部都没落盘就崩溃：日志不可能引用任何 Chunk，没有可恢复的内容
    if len < u64::from(HEADER_SIZE) {
        drop(f);
        let _ = fs::remove_file(part);
        let _ = fs::remove_file(&idx_path);
        return Ok(RecoveryOutcome::Discarded {
            part: part.to_path_buf(),
        });
    }
    let mut head = vec![0u8; len.min(u64::from(HEADER_SIZE)) as usize];
    f.read_exact(&mut head)?;
    let header = FileHeader::from_bytes(&head)?;

    let b_off = u64::from(header.universe_desc_offset);
    let b_len = u64::from(header.universe_count) * u64::from(UNIDESC_SIZE);
    if b_off + b_len > len {
        return Err(ArtRecError::Truncated("Universe 描述表不完整").into());
    }
    let mut b = vec![0u8; b_len as usize];
    f.seek(SeekFrom::Start(b_off))?;
    f.read_exact(&mut b)?;
    let unis = b
        .chunks_exact(UNIDESC_SIZE as usize)
        .map(UniDesc::from_bytes)
        .collect::<Result<Vec<_>, _>>()?;

    // 取日志中"连续、时间非降、且 Chunk 头一致"的最长前缀
    let pool_off = u64::from(header.chunk_pool_offset);
    let journal = fs::read(&idx_path).unwrap_or_default();
    let mut index: Vec<FrameIndex> = Vec::new();
    let mut expect_pos = 0u64;
    let mut prev_t = 0u64;
    for rec in journal.chunks_exact(FRAMEINDEX_SIZE as usize) {
        let fi = FrameIndex::from_bytes(rec)?;
        let cmp_len = u64::from(fi.chunk_cmp_len);
        if u64::from(fi.chunk_pos) != expect_pos
            || fi.time_us < prev_t
            || cmp_len < CHUNKHDR_SIZE as u64
            || pool_off + expect_pos + cmp_len > len
        {
            break;
        }
        let mut hb = [0u8; CHUNKHDR_SIZE];
        f.seek(SeekFrom::Start(pool_off + expect_pos))?;
        f.read_exact(&mut hb)?;
        let hdr = ChunkHdr::from_bytes(&hb)?;
        if CHUNKHDR_SIZE as u64 + u64::from(hdr.payload_cmp_sz) != cmp_len {
            break;
        }
        index.push(fi);
        expect_pos += cmp_len;
        prev_t = fi.time_us;
    }
    drop(f);

    let Some(last) = index.last().copied() else {
        let _ = fs::remove_file(part);
        let _ = fs::remove_file(&idx_path);
        return Ok(RecoveryOutcome::Discarded {
            part: part.to_path_buf(),
        });
    };

    // 截掉未被日志确认的尾部，再补索引表与头部
    let file = OpenOptions::new().read(true).write(true).open(part)?;
    file.set_len(pool_off + expect_pos)?;
    let frames = index.len() as u64;
    let writer = ArtRecWriter::resume(
        file,
        unis.clone(),
        header.compress_algo,
        header.compress_level,
        header.flags,
        header.rec_start_us,
        index,
    )?;
    let file = writer.finish(last.time_us)?;
    file.sync_all()?;
    drop(file);

    let final_stem = unique_stem(dir, &stem, &[ARTREC_SUFFIX]);
    let final_path = dir.join(format!("{final_stem}{ARTREC_SUFFIX}"));
    fs::rename(part, &final_path)?;
    let _ = fs::remove_file(&idx_path);

    let sidecar = Sidecar {
        version: SIDECAR_VERSION,
        name: stem,
        created_unix_ms: header.rec_start_us / 1000,
        universes: unis.iter().map(|u| u.universe).collect(),
        duration_us: last.time_us,
        frames,
        bytes: fs::metadata(&final_path).map_or(0, |m| m.len()),
        recovered: true,
        ..Sidecar::default()
    };
    write_sidecar(&final_path, &sidecar)?;
    Ok(RecoveryOutcome::Recovered {
        path: final_path,
        frames,
        duration_us: last.time_us,
    })
}

/// 列出目录下所有 `.artrec` 文件（升序），供节目库使用。
///
/// # Arguments
///
/// * `dir` - 录制目录。
///
/// # Returns
///
/// 按路径升序排列的 `.artrec` 文件路径（扩展名不区分大小写）；目录不存在或无法读取时为空。
#[must_use]
pub fn list_artrec_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let set: BTreeSet<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("artrec"))
        })
        .collect();
    set.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use artnet_net::{DmxFrame, Protocol};
    use artrec_core::ArtRecReader;
    use signal_engine::MergeMode;

    use super::{
        list_artrec_files, recover_orphans, sanitize_file_stem, FileRecorder, RecoveryOutcome,
        StartParams, PART_SUFFIX,
    };
    use crate::encoder::EncoderConfig;
    use crate::filter::RecordFilter;
    use crate::session::SessionConfig;
    use crate::sidecar::read_sidecar;
    use crate::testutil::TempDir;

    fn cfg(universes: Vec<u16>) -> SessionConfig {
        SessionConfig {
            filter: RecordFilter::default(),
            universes,
            merge_mode: MergeMode::Htp,
            encoder: EncoderConfig::default(),
            rec_start_unix_us: 1_700_000_000_000_000,
        }
    }

    fn params(dir: &TempDir, stem: &str) -> StartParams {
        StartParams {
            dir: dir.path().to_path_buf(),
            stem: stem.to_string(),
            name: stem.to_string(),
            notes: String::new(),
            created_unix_ms: 1_700_000_000_000,
            app_version: "0.1.0".into(),
            merge_mode: "htp".into(),
            source_timeout_ms: 2500,
        }
    }

    fn frame(universe: u16, v: u8) -> DmxFrame {
        DmxFrame {
            protocol: Protocol::ArtNet,
            universe,
            data: vec![v, v, v],
            source: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
            sequence: 0,
            received_at: std::time::Instant::now(),
        }
    }

    #[test]
    fn sanitize_handles_illegal_reserved_and_empty() {
        assert_eq!(sanitize_file_stem("a/b:c*?"), "a_b_c__");
        assert_eq!(sanitize_file_stem("  ..  "), "recording");
        assert_eq!(sanitize_file_stem("CON"), "_CON");
        assert_eq!(sanitize_file_stem("com1"), "_com1");
        assert_eq!(sanitize_file_stem("开场 秀"), "开场 秀");
        assert_eq!(sanitize_file_stem(&"x".repeat(200)).chars().count(), 80);
    }

    #[test]
    fn normal_finish_renames_and_writes_sidecar() {
        let dir = TempDir::new("finish");
        let mut rec = FileRecorder::start(params(&dir, "show"), cfg(vec![1])).unwrap();
        for i in 0..10u64 {
            rec.ingest(&frame(1, i as u8), i * 22_000);
            rec.tick().unwrap();
        }
        rec.checkpoint().unwrap();
        let done = rec.finish(300_000).unwrap();

        assert_eq!(done.path, dir.path().join("show.artrec"));
        assert!(!dir.path().join(format!("show{PART_SUFFIX}")).exists());
        assert!(!dir.path().join("show.artrec.idx").exists());
        let r = ArtRecReader::open_file(&done.path).unwrap();
        assert_eq!(u64::from(r.header().frame_count), done.stats.frames);
        assert_eq!(r.frame_at(0).unwrap().unwrap()[0][0], 0);

        let meta = read_sidecar(&done.path).unwrap();
        assert_eq!(meta.name, "show");
        assert_eq!(meta.universes, vec![1]);
        assert_eq!(meta.sources, vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))]);
        assert_eq!(meta.protocols, vec![Protocol::ArtNet]);
        assert_eq!(meta.duration_us, 300_000);
        assert!(!meta.recovered);
    }

    #[test]
    fn duplicate_names_get_suffix() {
        let dir = TempDir::new("dup");
        let a = FileRecorder::start(params(&dir, "same"), cfg(vec![1])).unwrap();
        let b = FileRecorder::start(params(&dir, "same"), cfg(vec![1])).unwrap();
        assert_eq!(a.final_path().file_name().unwrap(), "same.artrec");
        assert_eq!(b.final_path().file_name().unwrap(), "same-2.artrec");
        a.cancel();
        b.cancel();
        assert!(list_artrec_files(dir.path()).is_empty());
    }

    #[test]
    fn cancel_removes_temp_files() {
        let dir = TempDir::new("cancel");
        let mut rec = FileRecorder::start(params(&dir, "gone"), cfg(vec![1])).unwrap();
        rec.ingest(&frame(1, 5), 0);
        rec.tick().unwrap();
        rec.cancel();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn crash_after_checkpoint_recovers_confirmed_frames() {
        let dir = TempDir::new("crash");
        let mut rec = FileRecorder::start(params(&dir, "live"), cfg(vec![0, 1])).unwrap();
        for i in 0..20u64 {
            rec.ingest(&frame(0, (i + 1) as u8), i * 22_000);
            rec.ingest(&frame(1, (i + 50) as u8), i * 22_000);
            rec.tick().unwrap();
        }
        rec.checkpoint().unwrap();
        // checkpoint 之后的数据仍在用户态缓冲里，崩溃时丢失
        for i in 20..30u64 {
            rec.ingest(&frame(0, (i + 1) as u8), i * 22_000);
            rec.tick().unwrap();
        }
        rec.crash();

        let out = recover_orphans(dir.path());
        assert_eq!(out.len(), 1);
        let RecoveryOutcome::Recovered { path, frames, .. } = &out[0] else {
            panic!("应恢复成功: {out:?}");
        };
        assert!(*frames >= 20, "checkpoint 前的 20 帧必须保留，实际 {frames}");
        assert_eq!(path.file_name().unwrap(), "live.artrec");

        let r = ArtRecReader::open_file(path).unwrap();
        assert_eq!(u64::from(r.header().frame_count), *frames);
        let f = r.frame_at(19 * 22_000).unwrap().unwrap();
        assert_eq!(f[0][0], 20);
        assert_eq!(f[1][0], 69);
        assert!(read_sidecar(path).unwrap().recovered);
        // 孤立文件已清理，重复恢复无事发生
        assert!(recover_orphans(dir.path()).is_empty());
    }

    #[test]
    fn crash_before_any_frame_is_discarded() {
        let dir = TempDir::new("crash-empty");
        let rec = FileRecorder::start(params(&dir, "none"), cfg(vec![1])).unwrap();
        rec.crash();
        let out = recover_orphans(dir.path());
        assert!(matches!(out.as_slice(), [RecoveryOutcome::Discarded { .. }]));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn torn_journal_tail_is_ignored() {
        let dir = TempDir::new("torn");
        let mut rec = FileRecorder::start(params(&dir, "torn"), cfg(vec![1])).unwrap();
        for i in 0..5u64 {
            rec.ingest(&frame(1, (i + 1) as u8), i * 10_000);
            rec.tick().unwrap();
        }
        rec.checkpoint().unwrap();
        rec.crash();
        // 在日志末尾追加半条记录，模拟写入中途断电
        let idx = dir.path().join("torn.artrec.idx");
        let mut j = std::fs::read(&idx).unwrap();
        j.extend_from_slice(&[0xFF; 7]);
        std::fs::write(&idx, j).unwrap();

        let out = recover_orphans(dir.path());
        let [RecoveryOutcome::Recovered { frames, .. }] = out.as_slice() else {
            panic!("{out:?}");
        };
        assert_eq!(*frames, 5);
    }

    #[test]
    fn missing_header_is_reported_failed_and_quarantined() {
        let dir = TempDir::new("bad");
        std::fs::write(dir.path().join(format!("junk{PART_SUFFIX}")), [b'X'; 100]).unwrap();
        // 不足一个文件头的残骸没有可恢复内容，直接清理
        std::fs::write(dir.path().join(format!("tiny{PART_SUFFIX}")), b"nope").unwrap();
        let out = recover_orphans(dir.path());
        assert!(matches!(
            out.as_slice(),
            [RecoveryOutcome::Failed { .. }, RecoveryOutcome::Discarded { .. }]
        ));
        assert!(dir.path().join(format!("junk{PART_SUFFIX}.bad")).exists());
        assert!(!dir.path().join(format!("tiny{PART_SUFFIX}")).exists());
        assert!(recover_orphans(dir.path()).is_empty());
    }

    #[test]
    fn recovery_does_not_overwrite_existing_final_file() {
        let dir = TempDir::new("collide");
        let mut rec = FileRecorder::start(params(&dir, "take"), cfg(vec![1])).unwrap();
        rec.ingest(&frame(1, 9), 0);
        rec.tick().unwrap();
        rec.checkpoint().unwrap();
        rec.crash();
        std::fs::write(dir.path().join("take.artrec"), b"existing").unwrap();

        let out = recover_orphans(dir.path());
        let [RecoveryOutcome::Recovered { path, .. }] = out.as_slice() else {
            panic!("{out:?}");
        };
        assert_eq!(path.file_name().unwrap(), "take-2.artrec");
        assert_eq!(std::fs::read(dir.path().join("take.artrec")).unwrap(), b"existing");
    }
}
