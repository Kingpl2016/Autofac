//! 音视频素材：探测时长与音轨信息，计算波形峰值。
//!
//! 节目编辑器只"引用"素材（不复制进工程）。播放由 webview 的原生 `<audio>` / `<video>` 完成，
//! 这里只做前端做不好的两件事：
//!
//! - [`probe`]：不解码，读容器头得到时长、采样率、声道数；
//! - [`compute_peaks`]：解码音轨，按固定的"每秒 N 个桶"统计每个桶的最小 / 最大振幅，供时间线画波形。
//!
//! 解码使用纯 Rust 的 symphonia，跨平台、无需系统编解码器。无音轨的视频（例如静音的 mp4）
//! 探测不出时长，由前端从 `<video>` 元数据补上。

use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use thiserror::Error;

/// 视频容器的扩展名（按扩展名区分音频 / 视频，symphonia 不暴露视频轨）。
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv"];

/// 每秒峰值桶数的取值范围。
pub const MIN_PEAKS_PER_SECOND: u32 = 10;
/// 每秒峰值桶数的上限。
pub const MAX_PEAKS_PER_SECOND: u32 = 200;
/// 单个素材最多的峰值桶数（防止超长素材撑爆内存 / 传输）。
pub const MAX_PEAK_BUCKETS: usize = 600_000;

/// 素材类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    /// 纯音频。
    Audio,
    /// 视频（可能带音轨）。
    Video,
}

/// 探测结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// 素材类型（按扩展名判断）。
    pub kind: MediaKind,
    /// 时长（毫秒）；容器里没有可用音轨来推算时为 `None`（例如静音视频，由前端从元数据补上）。
    pub duration_ms: Option<u64>,
    /// 是否有可解码的音轨。
    pub has_audio: bool,
    /// 音轨采样率。
    pub sample_rate: Option<u32>,
    /// 音轨声道数。
    pub channels: Option<u8>,
}

/// 波形峰值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peaks {
    /// 每秒的桶数。
    pub per_second: u32,
    /// 音轨时长（毫秒）。
    pub duration_ms: u64,
    /// 每个桶两个值 `[最小, 最大]`，量化到 `-127..=127`（满幅为 ±127），按桶顺序平铺。
    pub peaks: Vec<i8>,
}

/// 素材错误。
#[derive(Debug, Error)]
pub enum MediaError {
    /// 文件不存在或无法打开。
    #[error("无法打开素材文件: {0}")]
    Io(#[from] std::io::Error),
    /// 格式不受支持，或没有可解码的音轨。
    #[error("不支持的音视频格式")]
    Unsupported,
    /// 解码过程中出现无法恢复的错误。
    #[error("解码失败: {0}")]
    Decode(String),
    /// 被取消。
    #[error("已取消")]
    Cancelled,
    /// 音频太短或没有稳定的节拍（节拍分析）。
    #[error("没有检测到稳定的节拍")]
    NoBeat,
}

impl MediaError {
    /// 机器可读的错误码，前端据此选择本地化文案。
    ///
    /// # Returns
    ///
    /// `io` / `unsupported` / `decode` / `cancelled` / `no_beat`。
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::Unsupported => "unsupported",
            Self::Decode(_) => "decode",
            Self::Cancelled => "cancelled",
            Self::NoBeat => "no_beat",
        }
    }
}

/// 由扩展名判断素材类型。
///
/// # Arguments
///
/// * `path` - 素材路径。
///
/// # Returns
///
/// 视频容器扩展名为 [`MediaKind::Video`]，其余为 [`MediaKind::Audio`]。
#[must_use]
pub fn kind_of(path: &Path) -> MediaKind {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        MediaKind::Video
    } else {
        MediaKind::Audio
    }
}

fn open_format(
    path: &Path,
) -> Result<Box<dyn symphonia::core::formats::FormatReader>, MediaError> {
    let file = File::open(path)?;
    let stream = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map(|probed| probed.format)
        .map_err(|_| MediaError::Unsupported)
}

/// 把素材的第一条音轨逐采样解码成单声道（多声道取平均），供波形与节拍分析共用。
pub(crate) struct MonoDecoder {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    codec: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    /// 音轨采样率（Hz）。
    pub(crate) sample_rate: u32,
}

impl MonoDecoder {
    /// 打开素材并创建解码器。
    ///
    /// # Arguments
    ///
    /// * `path` - 素材文件路径。
    ///
    /// # Returns
    ///
    /// 定位在开头的解码器。
    ///
    /// # Errors
    ///
    /// 文件无法打开（[`MediaError::Io`]），或没有可解码的音轨（[`MediaError::Unsupported`]）。
    pub(crate) fn open(path: &Path) -> Result<Self, MediaError> {
        let format = open_format(path)?;
        let (track_id, params) = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL && t.codec_params.sample_rate.is_some())
            .map(|t| (t.id, t.codec_params.clone()))
            .ok_or(MediaError::Unsupported)?;
        let sample_rate = params.sample_rate.ok_or(MediaError::Unsupported)?;
        let codec = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|_| MediaError::Unsupported)?;
        Ok(Self { format, codec, track_id, sample_rate })
    }

    /// 解码到文件末尾，每个单声道采样回调一次。个别损坏的数据包会被跳过（留下一小段空白）。
    ///
    /// # Arguments
    ///
    /// * `cancel` - 取消标志，每个数据包检查一次。
    /// * `on_sample` - 采样回调（-1.0 ~ 1.0）。
    ///
    /// # Errors
    ///
    /// 出现无法恢复的解码错误（[`MediaError::Decode`]），或被取消（[`MediaError::Cancelled`]）。
    pub(crate) fn run(&mut self, cancel: &AtomicBool, mut on_sample: impl FnMut(f32)) -> Result<(), MediaError> {
        let mut scratch: Option<SampleBuffer<f32>> = None;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(MediaError::Cancelled);
            }
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                // 正常读到文件末尾：symphonia 以 UnexpectedEof 表示
                Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(SymphoniaError::ResetRequired) => break,
                Err(e) => return Err(MediaError::Decode(e.to_string())),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.codec.decode(&packet) {
                Ok(d) => d,
                // 单个包损坏：跳过
                Err(SymphoniaError::DecodeError(_) | SymphoniaError::IoError(_)) => continue,
                Err(e) => return Err(MediaError::Decode(e.to_string())),
            };
            let spec = *decoded.spec();
            let channels = spec.channels.count().max(1);
            let buf = scratch.get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
            if buf.capacity() < decoded.capacity() * channels {
                *buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
            }
            buf.copy_interleaved_ref(decoded);
            for frame in buf.samples().chunks_exact(channels) {
                on_sample(frame.iter().sum::<f32>() / channels as f32);
            }
        }
        Ok(())
    }
}

/// 读取素材的基本信息（不解码）。
///
/// # Arguments
///
/// * `path` - 素材文件路径。
///
/// # Returns
///
/// 类型、时长与音轨信息。视频即使没有可解码的音轨也能成功（`has_audio = false`）；
/// 音频文件没有音轨则视为不支持。
///
/// # Errors
///
/// - [`MediaError::Io`]：文件无法打开。
/// - [`MediaError::Unsupported`]：容器无法识别，或音频文件里没有可解码的音轨。
pub fn probe(path: &Path) -> Result<MediaInfo, MediaError> {
    let kind = kind_of(path);
    let format = match open_format(path) {
        Ok(f) => f,
        // 视频容器 symphonia 读不了（例如 mov 的某些变体）时仍允许导入，由前端补时长
        Err(MediaError::Unsupported) if kind == MediaKind::Video => {
            return Ok(MediaInfo { kind, duration_ms: None, has_audio: false, sample_rate: None, channels: None });
        }
        Err(e) => return Err(e),
    };
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL && t.codec_params.sample_rate.is_some());
    let Some(track) = track else {
        if kind == MediaKind::Video {
            return Ok(MediaInfo { kind, duration_ms: None, has_audio: false, sample_rate: None, channels: None });
        }
        return Err(MediaError::Unsupported);
    };
    let params = &track.codec_params;
    let duration_ms = match (params.time_base, params.n_frames) {
        (Some(tb), Some(n)) => {
            let t = tb.calc_time(n);
            Some(t.seconds * 1000 + (t.frac * 1000.0).round() as u64)
        }
        (None, Some(n)) => params.sample_rate.map(|sr| n * 1000 / u64::from(sr)),
        _ => None,
    };
    Ok(MediaInfo {
        kind,
        duration_ms,
        has_audio: true,
        sample_rate: params.sample_rate,
        channels: params.channels.map(|c| u8::try_from(c.count()).unwrap_or(u8::MAX)),
    })
}

/// 解码音轨并做节拍分析（见 [`crate::beats`]）：先降采样到 [`crate::beats::ANALYSIS_RATE`]，最多分析 30 分钟。
///
/// # Arguments
///
/// * `path` - 素材文件路径。
/// * `cancel` - 取消标志，每个数据包检查一次。
///
/// # Returns
///
/// 速度、强拍偏移、逐拍时刻与段落。
///
/// # Errors
///
/// - [`MediaError::Io`] / [`MediaError::Unsupported`] / [`MediaError::Decode`] / [`MediaError::Cancelled`]：同 [`compute_peaks`]；
/// - [`MediaError::NoBeat`]：音频太短、近乎静音或没有可跟踪的节拍。
pub fn analyze_beats(path: &Path, cancel: &AtomicBool) -> Result<crate::beats::BeatAnalysis, MediaError> {
    let mut decoder = MonoDecoder::open(path)?;
    let mut down = crate::beats::Downsampler::new(f64::from(decoder.sample_rate));
    decoder.run(cancel, |s| down.push(s))?;
    let rate = down.rate;
    let samples = down.finish();
    crate::beats::analyze_samples(&samples, rate).ok_or(MediaError::NoBeat)
}

/// 解码音轨并做音乐结构分析（见 [`crate::analysis`]）：降采样同 [`analyze_beats`]。
///
/// # Arguments
///
/// * `path` - 素材文件路径。
/// * `sensitivity` - 灵敏度（见 [`crate::analysis::clamp_sensitivity`]）。
/// * `cancel` - 取消标志，每个数据包检查一次。
///
/// # Returns
///
/// 节拍、每小节特征、段落标签与事件。
///
/// # Errors
///
/// 同 [`analyze_beats`]。
pub fn analyze_audio(path: &Path, sensitivity: f64, cancel: &AtomicBool) -> Result<crate::analysis::AudioAnalysis, MediaError> {
    let mut decoder = MonoDecoder::open(path)?;
    let mut down = crate::beats::Downsampler::new(f64::from(decoder.sample_rate));
    decoder.run(cancel, |s| down.push(s))?;
    let rate = down.rate;
    let samples = down.finish();
    crate::analysis::analyze_samples(&samples, rate, sensitivity).ok_or(MediaError::NoBeat)
}

/// 一次解码截取若干段音轨，各自降采样成单声道 16 位 PCM 的 WAV（发给支持音频输入的模型做标注用）。
///
/// # Arguments
///
/// * `path` - 素材文件路径。
/// * `ranges` - 片段 `(起点毫秒, 长度毫秒)`（素材内），长度夹到 [`MAX_EXCERPT_MS`]，最多 [`MAX_EXCERPTS`] 段。
/// * `rate` - 输出采样率（Hz），夹到 8000~16000。
/// * `cancel` - 取消标志。
///
/// # Returns
///
/// 与 `ranges` 一一对应的 WAV 文件字节；落在音轨之外的片段为空数组。
///
/// # Errors
///
/// 同 [`compute_peaks`]；`ranges` 为空或超过上限时返回 [`MediaError::Unsupported`]。
pub fn excerpt_wavs(path: &Path, ranges: &[(u64, u64)], rate: u32, cancel: &AtomicBool) -> Result<Vec<Vec<u8>>, MediaError> {
    if ranges.is_empty() || ranges.len() > MAX_EXCERPTS {
        return Err(MediaError::Unsupported);
    }
    let rate = rate.clamp(8000, 16_000);
    let mut decoder = MonoDecoder::open(path)?;
    let source = u64::from(decoder.sample_rate);
    let step = source as f64 / f64::from(rate);
    let mut cuts: Vec<Cut> = ranges
        .iter()
        .map(|(start, len)| {
            let from = start * source / 1000;
            Cut { from, to: (start + (*len).min(MAX_EXCERPT_MS)) * source / 1000, next: from as f64 + step, acc: 0.0, count: 0, out: Vec::new() }
        })
        .collect();
    let mut index = 0u64;
    decoder.run(cancel, |s| {
        for c in &mut cuts {
            if index < c.from || index >= c.to {
                continue;
            }
            c.acc += s;
            c.count += 1;
            if index as f64 + 1.0 >= c.next {
                let v = c.acc / c.count.max(1) as f32;
                c.out.push((v.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16);
                c.acc = 0.0;
                c.count = 0;
                c.next += step;
            }
        }
        index += 1;
    })?;
    Ok(cuts.into_iter().map(|c| if c.out.is_empty() { Vec::new() } else { wav_bytes(&c.out, rate) }).collect())
}

/// 一次最多截取多少段。
pub const MAX_EXCERPTS: usize = 16;

/// [`excerpt_wavs`] 里一段正在截取的片段：采样区间、降采样状态与输出。
struct Cut {
    from: u64,
    to: u64,
    next: f64,
    acc: f32,
    count: u32,
    out: Vec<i16>,
}

/// 单声道 16 位 PCM 的 WAV 文件字节。
fn wav_bytes(out: &[i16], rate: u32) -> Vec<u8> {
    let data_len = u32::try_from(out.len() * 2).unwrap_or(u32::MAX);
    let mut wav = Vec::with_capacity(44 + out.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for v in out {
        wav.extend_from_slice(&v.to_le_bytes());
    }
    wav
}

/// 一个片段最长多少毫秒（发给模型的音频片段）。
pub const MAX_EXCERPT_MS: u64 = 20_000;

/// 解码音轨并统计波形峰值。
///
/// 多声道先混成单声道（取平均）。每个桶记录其中最小 / 最大的采样值，量化到 `-127..=127`。
/// 个别损坏的数据包会被跳过（波形里留下一小段静音），不会让整次计算失败。
///
/// # Arguments
///
/// * `path` - 素材文件路径。
/// * `per_second` - 每秒桶数，夹取到 [`MIN_PEAKS_PER_SECOND`]..=[`MAX_PEAKS_PER_SECOND`]。
/// * `cancel` - 取消标志，每个数据包检查一次。
///
/// # Returns
///
/// 峰值数据；桶数不超过 [`MAX_PEAK_BUCKETS`]（超长素材会被截断）。
///
/// # Errors
///
/// - [`MediaError::Io`] / [`MediaError::Unsupported`]：同 [`probe`]；没有可解码的音轨也算不支持。
/// - [`MediaError::Decode`]：解码器创建失败或出现无法恢复的错误。
/// - [`MediaError::Cancelled`]：`cancel` 被置位。
pub fn compute_peaks(path: &Path, per_second: u32, cancel: &AtomicBool) -> Result<Peaks, MediaError> {
    let per_second = per_second.clamp(MIN_PEAKS_PER_SECOND, MAX_PEAKS_PER_SECOND);
    let mut decoder = MonoDecoder::open(path)?;
    let sample_rate = u64::from(decoder.sample_rate);

    let mut mins: Vec<f32> = Vec::new();
    let mut maxs: Vec<f32> = Vec::new();
    let mut frame_index: u64 = 0;
    decoder.run(cancel, |mono| {
        let bucket = (frame_index * u64::from(per_second) / sample_rate) as usize;
        frame_index += 1;
        if bucket >= MAX_PEAK_BUCKETS {
            return;
        }
        if bucket >= mins.len() {
            mins.resize(bucket + 1, 0.0);
            maxs.resize(bucket + 1, 0.0);
        }
        mins[bucket] = mins[bucket].min(mono);
        maxs[bucket] = maxs[bucket].max(mono);
    })?;

    let quantize = |v: f32| (v.clamp(-1.0, 1.0) * 127.0).round() as i8;
    let mut peaks = Vec::with_capacity(mins.len() * 2);
    for (lo, hi) in mins.iter().zip(&maxs) {
        peaks.push(quantize(*lo));
        peaks.push(quantize(*hi));
    }
    Ok(Peaks {
        per_second,
        duration_ms: frame_index * 1000 / sample_rate,
        peaks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("ans-media-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 生成 16 位 PCM 的 WAV：`seconds` 秒，前半段振幅 `first`，后半段 `second`（满幅为 1.0），方波。
    fn wav(sample_rate: u32, channels: u16, seconds: u32, first: f32, second: f32) -> Vec<u8> {
        let frames = sample_rate * seconds;
        let mut data = Vec::new();
        for i in 0..frames {
            let amp = if i < frames / 2 { first } else { second };
            let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
            let v = (amp * sign * f32::from(i16::MAX)) as i16;
            for _ in 0..channels {
                data.extend_from_slice(&v.to_le_bytes());
            }
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&(sample_rate * u32::from(channels) * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        out
    }

    fn write(dir: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.0.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn 截取片段_降采样成单声道_wav_一次解码多段() {
        let dir = TempDir::new("excerpt");
        let path = write(&dir, "a.wav", &wav(44_100, 2, 4, 0.5, 0.5));
        let cut = excerpt_wavs(&path, &[(500, 1000), (3500, 2000), (9000, 1000)], 16_000, &AtomicBool::new(false)).unwrap();
        assert_eq!(cut.len(), 3);
        // 1 秒 16 kHz 单声道 16 位：44 字节头 + 32000 字节
        assert_eq!(&cut[0][..4], b"RIFF");
        assert!(cut[0].len().abs_diff(44 + 32_000) <= 4, "{}", cut[0].len());
        assert_eq!(u32::from_le_bytes([cut[0][24], cut[0][25], cut[0][26], cut[0][27]]), 16_000);
        assert_eq!(u16::from_le_bytes([cut[0][22], cut[0][23]]), 1);
        // 第二段只剩 0.5 秒在音轨内；第三段完全在音轨外
        assert!(cut[1].len().abs_diff(44 + 16_000) <= 4, "{}", cut[1].len());
        assert!(cut[2].is_empty());
        assert!(matches!(excerpt_wavs(&path, &[], 16_000, &AtomicBool::new(false)), Err(MediaError::Unsupported)));
    }

    #[test]
    fn 扩展名决定素材类型() {
        assert_eq!(kind_of(Path::new("a.MP4")), MediaKind::Video);
        assert_eq!(kind_of(Path::new("a.webm")), MediaKind::Video);
        assert_eq!(kind_of(Path::new("a.wav")), MediaKind::Audio);
        assert_eq!(kind_of(Path::new("a")), MediaKind::Audio);
    }

    #[test]
    fn 探测_wav_的时长_采样率_声道() {
        let dir = TempDir::new("probe");
        let path = write(&dir, "a.wav", &wav(8000, 2, 3, 0.5, 0.5));
        let info = probe(&path).unwrap();
        assert_eq!(info.kind, MediaKind::Audio);
        assert_eq!(info.duration_ms, Some(3000));
        assert!(info.has_audio);
        assert_eq!((info.sample_rate, info.channels), (Some(8000), Some(2)));
    }

    #[test]
    fn 不存在的文件报_io_不是音频的文件报不支持() {
        let dir = TempDir::new("errors");
        assert!(matches!(probe(&dir.0.join("ghost.wav")), Err(MediaError::Io(_))));
        let junk = write(&dir, "junk.mp3", b"this is definitely not audio data at all");
        assert!(matches!(probe(&junk), Err(MediaError::Unsupported)));
        assert_eq!(MediaError::Unsupported.code(), "unsupported");
        assert_eq!(MediaError::Cancelled.code(), "cancelled");
    }

    #[test]
    fn 无法识别的视频容器仍可导入_时长留给前端() {
        let dir = TempDir::new("video");
        let path = write(&dir, "clip.mp4", b"not really an mp4 container");
        let info = probe(&path).unwrap();
        assert_eq!(info.kind, MediaKind::Video);
        assert_eq!(info.duration_ms, None);
        assert!(!info.has_audio);
    }

    #[test]
    fn 峰值_按每秒桶数分段_振幅量化() {
        let dir = TempDir::new("peaks");
        // 2 秒：前 1 秒半幅，后 1 秒满幅
        let path = write(&dir, "a.wav", &wav(8000, 1, 2, 0.5, 1.0));
        let peaks = compute_peaks(&path, 10, &AtomicBool::new(false)).unwrap();
        assert_eq!(peaks.per_second, 10);
        assert_eq!(peaks.duration_ms, 2000);
        assert_eq!(peaks.peaks.len(), 20 * 2);
        // 方波交替正负：每个桶 min≈-振幅、max≈+振幅
        let bucket = |i: usize| (peaks.peaks[i * 2], peaks.peaks[i * 2 + 1]);
        // 半幅 16383 / 32768 × 127 ≈ 63.5，四舍五入后取 63
        assert_eq!(bucket(2), (-63, 63));
        assert_eq!(bucket(15), (-127, 127));
    }

    #[test]
    fn 多声道混成单声道取平均() {
        let dir = TempDir::new("stereo");
        let path = write(&dir, "s.wav", &wav(8000, 2, 1, 1.0, 1.0));
        let peaks = compute_peaks(&path, 10, &AtomicBool::new(false)).unwrap();
        // 两声道相同，平均后振幅不变
        assert_eq!((peaks.peaks[0], peaks.peaks[1]), (-127, 127));
    }

    #[test]
    fn 每秒桶数被夹取() {
        let dir = TempDir::new("clamp");
        let path = write(&dir, "a.wav", &wav(8000, 1, 1, 0.5, 0.5));
        assert_eq!(compute_peaks(&path, 1, &AtomicBool::new(false)).unwrap().per_second, MIN_PEAKS_PER_SECOND);
        assert_eq!(compute_peaks(&path, 9999, &AtomicBool::new(false)).unwrap().per_second, MAX_PEAKS_PER_SECOND);
    }

    #[test]
    fn 取消时返回_cancelled() {
        let dir = TempDir::new("cancel");
        let path = write(&dir, "a.wav", &wav(8000, 1, 1, 0.5, 0.5));
        assert!(matches!(
            compute_peaks(&path, 50, &AtomicBool::new(true)),
            Err(MediaError::Cancelled)
        ));
    }

    #[test]
    fn 节拍分析_从文件解码并降采样() {
        let dir = TempDir::new("beats");
        // 22050 Hz、120 BPM 的单声道“嗒”声，12 秒
        let rate = 22_050u32;
        let frames = rate * 12;
        let mut data = Vec::with_capacity(frames as usize * 2);
        for i in 0..frames {
            let t = f64::from(i) / f64::from(rate);
            let local = t % 0.5;
            let v = if local < 0.03 { (2.0 * std::f64::consts::PI * 2500.0 * local).sin() * (-local * 80.0).exp() * 0.6 } else { 0.0 };
            data.extend_from_slice(&((v * f64::from(i16::MAX)) as i16).to_le_bytes());
        }
        let mut bytes = wav(rate, 1, 0, 0.0, 0.0);
        let header = bytes.len();
        bytes.extend_from_slice(&data);
        bytes[4..8].copy_from_slice(&((header - 8 + data.len()) as u32).to_le_bytes());
        bytes[header - 4..header].copy_from_slice(&(data.len() as u32).to_le_bytes());
        let path = write(&dir, "click.wav", &bytes);
        let a = analyze_beats(&path, &AtomicBool::new(false)).unwrap();
        assert_eq!(a.bpm, 120.0);
        assert_eq!(a.duration_ms, 12_000);
        // 太短的文件
        let short = write(&dir, "short.wav", &wav(8000, 1, 1, 0.5, 0.5));
        assert!(matches!(analyze_beats(&short, &AtomicBool::new(false)), Err(MediaError::NoBeat)));
        assert_eq!(MediaError::NoBeat.code(), "no_beat");
    }

    #[test]
    fn 截断的_wav_仍能算出已有部分() {
        let dir = TempDir::new("trunc");
        let mut bytes = wav(8000, 1, 2, 0.5, 0.5);
        bytes.truncate(bytes.len() / 2);
        let path = write(&dir, "t.wav", &bytes);
        let peaks = compute_peaks(&path, 10, &AtomicBool::new(false)).unwrap();
        assert!(peaks.duration_ms > 0 && peaks.duration_ms < 2000);
    }
}
