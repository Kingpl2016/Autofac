//! 节目编辑导出：从一个 `.artrec` 中截取若干时间片段首尾拼接、只保留部分 Universe，
//! 写成新节目或替换原节目。
//!
//! 截取是"无损"的：保留原始帧的时间戳（平移到新时间轴），不按固定帧率重新采样。
//! 每个片段开头先写出该时刻的完整状态（从最近的全量帧前推得到），因此切点落在差分链中间、
//! 或落在两帧之间都不会丢失状态。写入沿用录制的默认编码（Zstd L3、仅全量帧），
//! 并保留源文件的循环标志；与上一帧相同的帧不写，结尾补一帧收尾帧使末帧时间等于总时长。
//!
//! 落盘与 [`crate::bake_file`] 相同："临时文件 → 重命名 → 写 sidecar"，失败时不留下临时文件。

use std::fs::File;
use std::io::{self, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use artrec_core::{
    ArtRecError, ArtRecReader, ArtRecWriter, FrameIndex, ReadAhead, DEFAULT_READ_AHEAD, FLAG_LOOP,
};

use crate::encoder::{EncoderConfig, FrameEncoder};
use crate::library::{resolve_in_dir, LibraryError, TrashFn};
use crate::manage::unique_entry_path;
use crate::sidecar::{
    overview_cache_path, read_sidecar, show_project_path, sidecar_path, write_sidecar,
    SIDECAR_VERSION,
};

/// 编辑参数。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EditSpec {
    /// 源时间轴上要保留的片段 `[start_us, end_us)`（微秒），导出时按时间顺序首尾拼接；
    /// 会经 [`normalize_segments`] 规整（裁剪到节目范围、排序、合并重叠）。
    pub segments: Vec<(u64, u64)>,
    /// 要保留的 Universe；`None` 表示全部保留。不存在于源文件的编号被忽略。
    pub universes: Option<Vec<u16>>,
}

/// 编辑结果的去向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditOutput<'a> {
    /// 另存为新节目（显示名；文件名由它规整得到，重名时自动追加编号）。
    New {
        /// 新节目的显示名。
        name: &'a str,
    },
    /// 替换原节目：原文件（连同 sidecar、概览缓存）移入回收站，结果放到原位置。
    Replace,
}

/// 编辑导出的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditReport {
    /// 结果节目的 `.artrec` 路径。
    pub path: PathBuf,
    /// 总时长（微秒，即保留片段长度之和）。
    pub duration_us: u64,
    /// 帧数。
    pub frames: u64,
    /// 文件字节数。
    pub bytes: u64,
    /// 文件内的 Universe（源文件顺序）。
    pub universes: Vec<u16>,
}

/// 编辑导出错误。
#[derive(Debug, thiserror::Error)]
pub enum EditError {
    /// 路径校验、回收站或文件系统错误（见 [`LibraryError`]）。
    #[error(transparent)]
    Library(#[from] LibraryError),
    /// 没有可保留的内容：片段为空 / 长度为 0，没有保留任何 Universe，或源节目没有帧。
    #[error("没有可导出的内容")]
    Empty,
    /// 节目带编辑器工程，不能被替换（工程下次保存时会重新生成 `.artrec`，覆盖裁剪结果）。
    #[error("编辑器节目不能替换，只能另存为新节目")]
    EditableReplace,
    /// 被调用方取消；临时文件已清理。
    #[error("已取消")]
    Cancelled,
    /// 读取源节目或写入结果时的 ArtRec 编解码错误。
    #[error("编码失败: {0}")]
    Codec(#[from] ArtRecError),
}

impl From<io::Error> for EditError {
    fn from(e: io::Error) -> Self {
        Self::Library(LibraryError::Io(e))
    }
}

/// 当前时间（Unix 毫秒）。
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// 在路径末尾追加后缀（不替换扩展名）。
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// 规整保留片段：裁剪到 `[0, duration_us]`、去掉长度为 0 的片段、按开始时间排序，
/// 并合并相互重叠或首尾相接的片段。
///
/// # Arguments
///
/// * `segments` - 原始片段 `[start_us, end_us)`（微秒），顺序任意，可能重叠或越界。
/// * `duration_us` - 源节目总时长（微秒）。
///
/// # Returns
///
/// 按时间升序、互不重叠且长度大于 0 的片段；没有有效片段时为空。
#[must_use]
pub fn normalize_segments(segments: &[(u64, u64)], duration_us: u64) -> Vec<(u64, u64)> {
    let mut v: Vec<(u64, u64)> = segments
        .iter()
        .map(|&(a, b)| (a.min(duration_us), b.min(duration_us)))
        .filter(|&(a, b)| b > a)
        .collect();
    v.sort_unstable();
    let mut out: Vec<(u64, u64)> = Vec::with_capacity(v.len());
    for (a, b) in v {
        match out.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

/// 统计 `[a, b)` 内（`inclusive_end` 时为 `[a, b]`）需要处理的帧数（含片段起点那一帧），用于进度。
fn frames_in(index: &[FrameIndex], a: u64, b: u64, inclusive_end: bool) -> usize {
    let lo = index.partition_point(|f| f.time_us <= a);
    let hi = if inclusive_end {
        index.partition_point(|f| f.time_us <= b)
    } else {
        index.partition_point(|f| f.time_us < b)
    };
    hi.saturating_sub(lo) + 1
}

/// 一次编辑导出的写入过程：在源节目上顺序推进状态，按保留的 Universe 取帧并编码写出。
struct Pass<'a, R: Read + Seek, W: Write + Seek> {
    /// 源节目读取器。
    reader: &'a ArtRecReader<R>,
    /// 结果写入器。
    writer: ArtRecWriter<W>,
    /// 帧编码器（去重、选择帧类型）。
    encoder: FrameEncoder,
    /// 源节目各路当前状态。
    buffers: Vec<Vec<u8>>,
    /// 保留的 Universe 下标（源文件顺序）。
    keep: Vec<usize>,
    /// 保留 Universe 的当前状态（`keep` 覆盖全部时不使用）。
    sub: Vec<Vec<u8>>,
    /// 复用的 Chunk 解压缓冲。
    raw: Vec<u8>,
    /// 已处理帧数与总帧数（进度）。
    done: u32,
    total: u32,
}

impl<R: Read + Seek, W: Write + Seek> Pass<'_, R, W> {
    /// 把源节目状态定位到 `a` 时刻：从 `<= a` 的最近全量帧前推到该时刻的最后一帧。
    ///
    /// # Returns
    ///
    /// 下一个待处理帧的下标（`a` 早于首帧时为 0，状态为全 0）。
    fn seek_state(&mut self, a: u64) -> Result<usize, EditError> {
        self.buffers = self.reader.zero_buffers();
        let Some(i) = self.reader.find_index(a) else {
            return Ok(0);
        };
        for j in self.reader.keyframe_at_or_before(i)?..=i {
            self.apply(j)?;
        }
        Ok(i + 1)
    }

    /// 读取并应用源节目第 `j` 帧。
    fn apply(&mut self, j: usize) -> Result<(), EditError> {
        let hdr = self.reader.read_chunk_into(j, &mut self.raw)?;
        self.reader.apply_chunk_into(&mut self.buffers, &hdr, &self.raw)?;
        Ok(())
    }

    /// 以结果时间轴上的 `time_us` 写出当前状态（与上一帧相同则不写），并汇报进度。
    fn emit(&mut self, time_us: u64, progress: &mut dyn FnMut(f32)) -> Result<(), EditError> {
        if self.keep.len() == self.buffers.len() {
            self.encoder.encode(&mut self.writer, time_us, &self.buffers)?;
        } else {
            for (dst, &i) in self.sub.iter_mut().zip(&self.keep) {
                dst.copy_from_slice(&self.buffers[i]);
            }
            self.encoder.encode(&mut self.writer, time_us, &self.sub)?;
        }
        self.done = self.done.saturating_add(1);
        if self.done.is_multiple_of(100) {
            progress((f64::from(self.done) / f64::from(self.total.max(1))) as f32);
        }
        Ok(())
    }
}

/// 把编辑结果写进 `dest`（调用方保证 `dest` 是临时文件，失败时由调用方清理）。
///
/// # Arguments
///
/// * `src` - 源 `.artrec`（已校验）。
/// * `dest` - 输出文件路径。
/// * `spec` - 编辑参数。
/// * `cancel` - 取消标志，每处理一帧检查一次。
/// * `progress` - 进度回调（`0.0..=1.0`），约每百帧调用一次。
///
/// # Returns
///
/// `(时长, 帧数, 字节数, Universe)`。
///
/// # Errors
///
/// 见 [`EditError`]。
fn write_edit(
    src: &Path,
    dest: &Path,
    spec: &EditSpec,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(u64, u64, u64, Vec<u16>), EditError> {
    let template = ArtRecReader::open_file(src)?;
    // 顺序扫描：带预读的数据源，减少逐帧小块读盘
    let reader = template.with_source(ReadAhead::new(File::open(src)?, DEFAULT_READ_AHEAD))?;
    drop(template);
    let index = reader.index();
    let Some(last_frame) = index.last() else {
        return Err(EditError::Empty);
    };
    let duration = reader.header().total_duration_us.max(last_frame.time_us);
    let segments = normalize_segments(&spec.segments, duration);
    if segments.is_empty() {
        return Err(EditError::Empty);
    }

    let keep: Vec<usize> = reader
        .unis()
        .iter()
        .enumerate()
        .filter(|(_, u)| spec.universes.as_ref().is_none_or(|set| set.contains(&u.universe)))
        .map(|(i, _)| i)
        .collect();
    if keep.is_empty() {
        return Err(EditError::Empty);
    }
    let unis: Vec<_> = keep.iter().map(|&i| reader.unis()[i]).collect();
    let universes: Vec<u16> = unis.iter().map(|u| u.universe).collect();

    let cfg = EncoderConfig::default();
    let flags = cfg.file_flags() | (reader.header().flags & FLAG_LOOP);
    let sink = BufWriter::new(File::create(dest)?);
    let writer =
        ArtRecWriter::new(sink, unis, cfg.algo, cfg.level, flags, reader.header().rec_start_us)?;

    // 最后一个片段延伸到节目末尾时，末尾那一帧（时间戳等于总时长）也属于它
    let last_seg = segments.len() - 1;
    let inclusive = |n: usize, b: u64| n == last_seg && b >= duration;
    let total: usize = segments
        .iter()
        .enumerate()
        .map(|(n, &(a, b))| frames_in(index, a, b, inclusive(n, b)))
        .sum();
    let zero = reader.zero_buffers();
    let mut pass = Pass {
        reader: &reader,
        writer,
        encoder: FrameEncoder::new(cfg),
        sub: keep.iter().map(|&i| zero[i].clone()).collect(),
        buffers: zero,
        keep,
        raw: Vec::new(),
        done: 0,
        total: u32::try_from(total).unwrap_or(u32::MAX),
    };

    let mut offset = 0u64;
    for (n, &(a, b)) in segments.iter().enumerate() {
        let mut j = pass.seek_state(a)?;
        pass.emit(offset, progress)?;
        while let Some(fi) = index.get(j) {
            if fi.time_us > b || (fi.time_us == b && !inclusive(n, b)) {
                break;
            }
            if cancel.load(Ordering::Relaxed) {
                return Err(EditError::Cancelled);
            }
            pass.apply(j)?;
            pass.emit(offset + (fi.time_us - a), progress)?;
            j += 1;
        }
        offset += b - a;
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(EditError::Cancelled);
    }

    let Pass { mut writer, mut encoder, .. } = pass;
    encoder.encode_tail(&mut writer, offset)?;
    let frames = writer.frame_count() as u64;
    let mut sink = writer.finish(offset)?;
    sink.flush()?;
    // 改名前落盘：断电后要么是原节目、要么是完整的新文件。
    sink.get_ref().sync_all()?;
    let bytes = sink.get_ref().metadata()?.len();
    Ok((offset, frames, bytes, universes))
}

/// 编辑导出一个节目：按 `spec` 截取 / 拼接 / 筛选 Universe，结果另存为新节目或替换原节目。
///
/// - 另存：sidecar 沿用原节目的元数据（备注、来源、过滤条件等），名称与创建时间为新值，
///   来源标记清空（结果是普通节目，不能再用编辑器打开）。
/// - 替换：先把结果写进临时文件，再把原 `.artrec`、sidecar 与概览缓存一并移入回收站
///   （可从回收站恢复），最后把结果放到原位置并写回 sidecar（名称、备注保持不变）。
///
/// # Arguments
///
/// * `dir` - 录制目录。
/// * `path` - 源节目的 `.artrec` 路径（文件必须存在）。
/// * `spec` - 编辑参数。
/// * `output` - 结果去向。
/// * `cancel` - 取消标志；被置位时放弃并清理临时文件（替换模式下原节目保持原样）。
/// * `progress` - 进度回调（`0.0..=1.0`），完成时调用 `1.0`。
/// * `trash` - 把文件移入回收站的函数（替换模式使用；测试可注入假实现）。
///
/// # Returns
///
/// 结果节目的 [`EditReport`]。
///
/// # Errors
///
/// - [`EditError::Library`]：路径非法、无法移入回收站（此时原节目保持原样）或文件系统失败。
/// - [`EditError::EditableReplace`]：要替换的节目带编辑器工程。
/// - [`EditError::Empty`]：没有可保留的内容。
/// - [`EditError::Cancelled`]：被取消。
/// - [`EditError::Codec`]：源文件无法解析或结果无法编码。
pub fn edit_recording(
    dir: &Path,
    path: &Path,
    spec: &EditSpec,
    output: EditOutput<'_>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
    trash: TrashFn<'_>,
) -> Result<EditReport, EditError> {
    let src = resolve_in_dir(dir, path)?;
    if output == EditOutput::Replace && show_project_path(&src).is_file() {
        return Err(EditError::EditableReplace);
    }
    let dest = match output {
        EditOutput::New { name } => unique_entry_path(dir, name),
        EditOutput::Replace => src.clone(),
    };
    let tmp = with_suffix(&dest, ".edit");
    let (duration_us, frames, bytes, universes) =
        match write_edit(&src, &tmp, spec, cancel, progress) {
            Ok(r) => r,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        };

    let mut meta = read_sidecar(&src).unwrap_or_default();
    match output {
        EditOutput::New { name } => {
            name.trim().clone_into(&mut meta.name);
            meta.created_unix_ms = now_ms();
            meta.source.clear();
        }
        EditOutput::Replace => {
            let items: Vec<PathBuf> = [src.clone(), sidecar_path(&src), overview_cache_path(&src)]
                .into_iter()
                .filter(|p| p.exists())
                .collect();
            if let Err(e) = trash(&items) {
                let _ = std::fs::remove_file(&tmp);
                return Err(LibraryError::Trash(e).into());
            }
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    meta.version = SIDECAR_VERSION;
    meta.recovered = false;
    meta.universes.clone_from(&universes);
    meta.duration_us = duration_us;
    meta.frames = frames;
    meta.bytes = bytes;
    write_sidecar(&dest, &meta)?;
    // 另存时目标位置不会有缓存；替换时原缓存已随原节目移走，这里只是兜底
    let _ = std::fs::remove_file(overview_cache_path(&dest));
    progress(1.0);
    Ok(EditReport { path: dest, duration_us, frames, bytes, universes })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::io::Cursor;

    use artrec_core::{ArtRecWriter, CompressAlgo, DiffChange, UniDesc, FLAG_DIFF_FRAME};

    use super::*;
    use crate::library::list_library_uncached;
    use crate::show_store::{save_show, SaveRequest};
    use crate::sidecar::{write_overview_cache, Sidecar};
    use crate::testutil::TempDir;

    /// 写一个节目：Universe 1、2、3，第 i 帧在 `i * 1000` 微秒，内容为 `[i, i+100, i+200]`
    /// （各路 512 字节填同一个值），总时长 `frames * 1000`（末尾补收尾帧）。
    fn make(dir: &Path, stem: &str, frames: u64, flags: u32) -> PathBuf {
        let unis = [1u16, 2, 3].map(|u| UniDesc::from_universe(u, 512).unwrap()).to_vec();
        let mut w =
            ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 3, flags, 7).unwrap();
        let frame = |i: u64| [0u64, 100, 200].map(|o| vec![((i + o) % 256) as u8; 512]).to_vec();
        for i in 0..frames {
            w.add_full_frame(i * 1000, &frame(i)).unwrap();
        }
        w.add_full_frame(frames * 1000, &frame(frames - 1)).unwrap();
        let p = dir.join(format!("{stem}.artrec"));
        std::fs::write(&p, w.finish(frames * 1000).unwrap().into_inner()).unwrap();
        p
    }

    /// 读出结果的 (时间戳, 第 0 路首字节) 序列与总时长。
    fn dump(path: &Path) -> (Vec<(u64, u8)>, u64, Vec<u16>, u32) {
        let r = ArtRecReader::open_file(path).unwrap();
        let frames = (0..r.index().len())
            .map(|i| (r.index()[i].time_us, r.resolve_frame(i).unwrap()[0][0]))
            .collect();
        (frames, r.header().total_duration_us, r.unis().iter().map(|u| u.universe).collect(), r.header().flags)
    }

    fn no_trash(_: &[PathBuf]) -> Result<(), String> {
        panic!("另存不应调用回收站")
    }

    fn run(dir: &Path, src: &Path, spec: &EditSpec, output: EditOutput<'_>) -> Result<EditReport, EditError> {
        edit_recording(dir, src, spec, output, &AtomicBool::new(false), &mut |_| {}, &no_trash)
    }

    fn spec(segments: &[(u64, u64)]) -> EditSpec {
        EditSpec { segments: segments.to_vec(), universes: None }
    }

    #[test]
    fn 规整片段_裁剪排序合并并丢弃空片段() {
        assert_eq!(normalize_segments(&[(500, 900), (0, 100), (80, 200), (950, 2000), (300, 300)], 1000),
            vec![(0, 200), (500, 900), (950, 1000)]);
        assert_eq!(normalize_segments(&[(0, 100), (100, 200)], 1000), vec![(0, 200)]);
        assert!(normalize_segments(&[(1500, 2000)], 1000).is_empty());
        assert!(normalize_segments(&[], 1000).is_empty());
    }

    #[test]
    fn 单段截取_时间平移且首帧是入点时刻的状态() {
        let dir = TempDir::new("edit-trim");
        let src = make(dir.path(), "a", 10, 0);
        // 入点 2500 落在第 2、3 帧之间：首帧应为第 2 帧的内容
        let r = run(dir.path(), &src, &spec(&[(2500, 6000)]), EditOutput::New { name: "裁剪" }).unwrap();
        let (frames, total, unis, _) = dump(&r.path);
        assert_eq!(total, 3500);
        assert_eq!(r.duration_us, 3500);
        assert_eq!(frames, vec![(0, 2), (500, 3), (1500, 4), (2500, 5), (3500, 5)]);
        assert_eq!(unis, vec![1, 2, 3]);
        assert_eq!(r.path.file_name().unwrap(), "裁剪.artrec");
    }

    #[test]
    fn 删除中间段_前后两段首尾拼接() {
        let dir = TempDir::new("edit-cut");
        let src = make(dir.path(), "a", 10, 0);
        let r = run(dir.path(), &src, &spec(&[(0, 3000), (6000, 10_000)]), EditOutput::New { name: "b" }).unwrap();
        let (frames, total, _, _) = dump(&r.path);
        assert_eq!(total, 7000);
        // 0..3000：帧 0、1、2；6000 起：帧 6..9，再加原节目末尾的收尾帧（时间 10000 → 7000）
        let times: Vec<u64> = frames.iter().map(|f| f.0).collect();
        assert_eq!(times, vec![0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
        let values: Vec<u8> = frames.iter().map(|f| f.1).collect();
        assert_eq!(values, vec![0, 1, 2, 6, 7, 8, 9, 9]);
    }

    #[test]
    fn 只保留部分_universe() {
        let dir = TempDir::new("edit-unis");
        let src = make(dir.path(), "a", 4, 0);
        let s = EditSpec { segments: vec![(0, 4000)], universes: Some(vec![3, 9]) };
        let r = run(dir.path(), &src, &s, EditOutput::New { name: "u" }).unwrap();
        let (frames, _, unis, _) = dump(&r.path);
        assert_eq!(unis, vec![3]);
        assert_eq!(r.universes, vec![3]);
        assert_eq!(frames[0].1, 200);
        let lib = list_library_uncached(dir.path());
        let entry = lib.iter().find(|e| e.file_name == "u.artrec").unwrap();
        assert!(entry.valid);
        assert_eq!(entry.universes, vec![3]);
    }

    #[test]
    fn 切点落在差分链中间时首帧状态完整() {
        let dir = TempDir::new("edit-diff");
        let unis = vec![UniDesc::from_universe(0, 512).unwrap()];
        let mut w = ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::Zstd, 3, FLAG_DIFF_FRAME | FLAG_LOOP, 0).unwrap();
        let mut f = vec![vec![0u8; 512]];
        f[0][0] = 10;
        w.add_full_frame(0, &f).unwrap();
        w.add_diff_frame(1000, &[DiffChange { uni_idx: 0, ch_addr: 1, ch_val: 20 }]).unwrap();
        w.add_diff_frame(2000, &[DiffChange { uni_idx: 0, ch_addr: 2, ch_val: 30 }]).unwrap();
        w.add_diff_frame(3000, &[]).unwrap();
        let src = dir.path().join("d.artrec");
        std::fs::write(&src, w.finish(3000).unwrap().into_inner()).unwrap();

        let r = run(dir.path(), &src, &spec(&[(2500, 3000)]), EditOutput::New { name: "x" }).unwrap();
        let rd = ArtRecReader::open_file(&r.path).unwrap();
        let first = rd.resolve_frame(0).unwrap();
        assert_eq!(&first[0][..3], &[10, 20, 30]);
        // 结果按默认编码（仅全量帧），保留源文件的循环标志
        assert!(!rd.header().allows_diff());
        assert!(rd.header().loop_play());
        assert_eq!(rd.header().total_duration_us, 500);
    }

    #[test]
    fn 没有可保留内容时报错且不留临时文件() {
        let dir = TempDir::new("edit-empty");
        let src = make(dir.path(), "a", 4, 0);
        assert!(matches!(run(dir.path(), &src, &spec(&[]), EditOutput::New { name: "e" }), Err(EditError::Empty)));
        assert!(matches!(run(dir.path(), &src, &spec(&[(9000, 9999)]), EditOutput::New { name: "e" }), Err(EditError::Empty)));
        let none = EditSpec { segments: vec![(0, 1000)], universes: Some(vec![42]) };
        assert!(matches!(run(dir.path(), &src, &none, EditOutput::New { name: "e" }), Err(EditError::Empty)));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "只剩源文件");
    }

    #[test]
    fn 取消后清理临时文件() {
        let dir = TempDir::new("edit-cancel");
        let src = make(dir.path(), "a", 50, 0);
        let res = edit_recording(dir.path(), &src, &spec(&[(0, 50_000)]), EditOutput::New { name: "c" },
            &AtomicBool::new(true), &mut |_| {}, &no_trash);
        assert!(matches!(res, Err(EditError::Cancelled)));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn 另存沿用元数据_重名时自动编号_来源标记清空() {
        let dir = TempDir::new("edit-meta");
        let src = make(dir.path(), "a", 4, 0);
        write_sidecar(&src, &Sidecar { name: "开场".into(), notes: "备注".into(), source: "x".into(), ..Sidecar::default() }).unwrap();
        make(dir.path(), "开场（裁剪）", 1, 0);
        let r = run(dir.path(), &src, &spec(&[(0, 2000)]), EditOutput::New { name: "开场（裁剪）" }).unwrap();
        assert_eq!(r.path.file_name().unwrap(), "开场（裁剪）-2.artrec");
        let meta = read_sidecar(&r.path).unwrap();
        assert_eq!((meta.name.as_str(), meta.notes.as_str(), meta.source.as_str()), ("开场（裁剪）", "备注", ""));
        assert_eq!((meta.duration_us, meta.frames), (r.duration_us, r.frames));
        // 原节目原样保留
        assert_eq!(dump(&src).1, 4000);
    }

    #[test]
    fn 替换_原文件移入回收站_结果放回原位() {
        let dir = TempDir::new("edit-replace");
        let src = make(dir.path(), "a", 6, 0);
        write_sidecar(&src, &Sidecar { name: "开场".into(), notes: "n".into(), ..Sidecar::default() }).unwrap();
        write_overview_cache(&src, b"old").unwrap();
        let trashed = RefCell::new(Vec::new());
        let trash = |paths: &[PathBuf]| -> Result<(), String> {
            for p in paths {
                // 模拟回收站：移走文件
                std::fs::remove_file(p).unwrap();
                trashed.borrow_mut().push(p.file_name().unwrap().to_string_lossy().into_owned());
            }
            Ok(())
        };
        let r = edit_recording(dir.path(), &src, &spec(&[(1000, 4000)]), EditOutput::Replace,
            &AtomicBool::new(false), &mut |_| {}, &trash).unwrap();
        assert_eq!(r.path, std::fs::canonicalize(&src).unwrap());
        assert_eq!(*trashed.borrow(), vec!["a.artrec", "a.artrec.json", "a.artrec.ovw"]);
        assert_eq!(dump(&src).1, 3000);
        let meta = read_sidecar(&src).unwrap();
        assert_eq!((meta.name.as_str(), meta.notes.as_str(), meta.duration_us), ("开场", "n", 3000));
        assert!(!overview_cache_path(&src).exists());
    }

    #[test]
    fn 替换时回收站失败_原节目保持原样() {
        let dir = TempDir::new("edit-replace-fail");
        let src = make(dir.path(), "a", 6, 0);
        let before = std::fs::read(&src).unwrap();
        let res = edit_recording(dir.path(), &src, &spec(&[(0, 1000)]), EditOutput::Replace,
            &AtomicBool::new(false), &mut |_| {}, &|_| Err("不可用".into()));
        assert!(matches!(res, Err(EditError::Library(LibraryError::Trash(_)))));
        assert_eq!(std::fs::read(&src).unwrap(), before);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "不留临时文件");
    }

    #[test]
    fn 编辑器节目不能替换但可以另存() {
        let dir = TempDir::new("edit-editable");
        let json = r#"{"version":1,"name":"秀"}"#;
        let p = save_show(dir.path(), SaveRequest { path: None, name: "秀", notes: "", file_stem: "a", json }).unwrap();
        make(dir.path(), "a", 4, 0);
        assert!(matches!(run(dir.path(), &p, &spec(&[(0, 1000)]), EditOutput::Replace), Err(EditError::EditableReplace)));
        let r = run(dir.path(), &p, &spec(&[(0, 1000)]), EditOutput::New { name: "秀（裁剪）" }).unwrap();
        let lib = list_library_uncached(dir.path());
        let entry = lib.iter().find(|e| e.file_name == "秀（裁剪）.artrec").unwrap();
        assert_eq!(r.path.file_name().unwrap(), "秀（裁剪）.artrec");
        assert!(!entry.editable);
        assert!(entry.valid);
    }

    #[test]
    fn 进度从零到一() {
        let dir = TempDir::new("edit-progress");
        let src = make(dir.path(), "a", 300, 0);
        let mut seen = Vec::new();
        edit_recording(dir.path(), &src, &spec(&[(0, 300_000)]), EditOutput::New { name: "p" },
            &AtomicBool::new(false), &mut |p| seen.push(p), &no_trash).unwrap();
        assert!(seen.len() >= 3);
        assert!((seen.last().unwrap() - 1.0).abs() < f32::EPSILON);
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
    }
}
