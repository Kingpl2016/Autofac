//! 节拍分析：从单声道采样估计 BPM、第一拍（强拍）位置、逐拍时刻与按能量划分的段落。
//!
//! 流程（参考 Ellis 2007 “Beat Tracking by Dynamic Programming”）：
//!
//! 1. 起音强度：1024 点 Hann 窗、256 点步长的短时傅里叶变换，对数压缩幅度谱的正向差分之和（谱通量）；
//!    减去局部均值、半波整流、按标准差归一化；
//! 2. 测速：起音强度在 60~200 BPM 对应延迟上的自相关，乘以以 120 BPM 为中心的对数高斯先验，
//!    取最大值并做抛物线插值；
//! 3. 跟拍：动态规划，在“落在强起音上”和“与上一拍间隔接近一个周期”之间取最优，回溯得到逐拍位置；
//! 4. 定网格：对逐拍时刻做稳健的线性拟合得到周期与相位（接近整数的 BPM 取整）；
//! 5. 强拍：4 拍一小节，比较 4 个相位上低频（< 200 Hz）起音的总和，取最大者为第一拍；
//! 6. 段落：按小节统计能量（dB），前后各 4 小节的均值之差为新颖度，取超过阈值的局部极大为段落边界。
//!
//! 只依赖标准库（自带基 2 FFT），结果是确定的，前后端 / 测试一致。

use serde::{Deserialize, Serialize};

/// 分析时使用的采样率上限（Hz）：更高采样率的音频先降采样（盒式滤波）。
pub const ANALYSIS_RATE: f64 = 11_025.0;
/// 可识别的最低 BPM。
pub const MIN_BPM: f64 = 60.0;
/// 可识别的最高 BPM。
pub const MAX_BPM: f64 = 200.0;
/// 最多分析的时长（秒），超出部分忽略。
pub const MAX_ANALYSIS_SECONDS: f64 = 1800.0;
/// 每小节拍数（当前固定 4/4）。
pub const BEATS_PER_BAR: u32 = 4;

/// STFT 窗长（采样点，2 的幂）。
const WINDOW: usize = 1024;
/// STFT 步长（采样点）。
const HOP: usize = 256;
/// 对数压缩系数：`ln(1 + GAMMA·|X|)`。
const GAMMA: f32 = 100.0;
/// 低频起音（强拍判断）的上限频率（Hz）。
const LOW_HZ: f64 = 200.0;
/// 速度先验的中心（BPM）与宽度（倍频程）。
const PRIOR_BPM: f64 = 120.0;
const PRIOR_OCTAVES: f64 = 0.9;
/// 跟拍的节奏紧度：偏离周期的惩罚系数。
const TIGHTNESS: f32 = 100.0;
/// 段落边界的新颖度阈值（dB）与最短段落（小节）。
const SECTION_THRESHOLD_DB: f64 = 3.0;
const MIN_SECTION_BARS: usize = 8;
/// 新颖度比较的窗口（小节）。
const NOVELTY_BARS: usize = 4;
/// 至少需要多少个周期的音频才分析。
const MIN_PERIODS: usize = 8;

/// 节拍分析结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatAnalysis {
    /// 速度（BPM，保留 1 位小数；接近整数时取整）。
    pub bpm: f64,
    /// 第一拍（强拍）相对 0 点的偏移（毫秒，`0..一小节`），与前端 `Tempo.offsetMs` 同义。
    pub offset_ms: i64,
    /// 每小节拍数。
    pub beats_per_bar: u32,
    /// 检测到的逐拍时刻（毫秒，升序）。
    pub beats_ms: Vec<u64>,
    /// 置信度 0~1：自相关峰的相对强度 × 拍间隔的规律程度。
    pub confidence: f64,
    /// 分析的音频时长（毫秒）。
    pub duration_ms: u64,
    /// 按能量划分的段落（至少一段，按时间顺序首尾相接）。
    pub sections: Vec<SectionGuess>,
}

/// 一个猜测的段落。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionGuess {
    /// 起点（毫秒）。
    pub start_ms: u64,
    /// 终点（毫秒）。
    pub end_ms: u64,
    /// 相对能量 0~1（全曲最安静的段落为 0，最响的为 1）。
    pub energy: f64,
}

/// 盒式滤波降采样器：把任意采样率的采样流降到不高于 [`ANALYSIS_RATE`]。
pub struct Downsampler {
    step: f64,
    next: f64,
    pos: f64,
    acc: f32,
    count: u32,
    limit: usize,
    out: Vec<f32>,
    /// 输出采样率（Hz）。
    pub rate: f64,
}

impl Downsampler {
    /// 新建降采样器。
    ///
    /// # Arguments
    ///
    /// * `source_rate` - 输入采样率（Hz）。
    ///
    /// # Returns
    ///
    /// 降采样器；输入不高于 [`ANALYSIS_RATE`] 时不降采样。
    #[must_use]
    pub fn new(source_rate: f64) -> Self {
        let rate = source_rate.clamp(1.0, ANALYSIS_RATE);
        let step = source_rate.max(1.0) / rate;
        Self {
            step,
            next: step,
            pos: 0.0,
            acc: 0.0,
            count: 0,
            limit: (rate * MAX_ANALYSIS_SECONDS) as usize,
            out: Vec::new(),
            rate,
        }
    }

    /// 输入一个采样。
    ///
    /// # Arguments
    ///
    /// * `sample` - 单声道采样。
    pub fn push(&mut self, sample: f32) {
        if self.out.len() >= self.limit {
            return;
        }
        self.acc += sample;
        self.count += 1;
        self.pos += 1.0;
        if self.pos >= self.next {
            self.out.push(self.acc / self.count as f32);
            self.acc = 0.0;
            self.count = 0;
            self.next += self.step;
        }
    }

    /// 结束输入。
    ///
    /// # Returns
    ///
    /// 降采样后的采样。
    #[must_use]
    pub fn finish(self) -> Vec<f32> {
        self.out
    }
}

/// 基 2 复数 FFT（只用来求幅度谱）。
struct Fft {
    n: usize,
    rev: Vec<usize>,
    cos: Vec<f32>,
    sin: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
}

impl Fft {
    fn new(n: usize) -> Self {
        debug_assert!(n.is_power_of_two());
        let bits = n.trailing_zeros();
        let rev = (0..n).map(|i| i.reverse_bits() >> (usize::BITS - bits)).collect();
        let (cos, sin) = (0..n / 2)
            .map(|j| {
                let a = 2.0 * std::f64::consts::PI * j as f64 / n as f64;
                (a.cos() as f32, a.sin() as f32)
            })
            .unzip();
        Self { n, rev, cos, sin, re: vec![0.0; n], im: vec![0.0; n] }
    }

    /// 实数输入的幅度谱 `|X[k]|`，`k = 0..=n/2`。
    #[expect(clippy::many_single_char_names, reason = "FFT 数学记法 n/i/x 等为习惯命名")]
    fn magnitudes(&mut self, input: &[f32], out: &mut [f32]) {
        let n = self.n;
        for (i, x) in input.iter().enumerate().take(n) {
            self.re[self.rev[i]] = *x;
        }
        self.im.fill(0.0);
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = n / len;
            for start in (0..n).step_by(len) {
                for j in 0..half {
                    let (c, s) = (self.cos[j * step], self.sin[j * step]);
                    let (a, b) = (start + j, start + j + half);
                    // (xr + i·xi)·e^{-iθ}
                    let vr = self.re[b] * c + self.im[b] * s;
                    let vi = self.im[b] * c - self.re[b] * s;
                    let (ur, ui) = (self.re[a], self.im[a]);
                    self.re[a] = ur + vr;
                    self.im[a] = ui + vi;
                    self.re[b] = ur - vr;
                    self.im[b] = ui - vi;
                }
            }
            len *= 2;
        }
        for (k, o) in out.iter_mut().enumerate().take(n / 2 + 1) {
            *o = self.re[k].hypot(self.im[k]);
        }
    }
}

/// 逐帧特征。
struct Features {
    /// 全频带谱通量
    onset: Vec<f32>,
    /// 低频谱通量
    low: Vec<f32>,
    /// 每帧（一个步长）的 RMS
    rms: Vec<f32>,
    /// 帧率（帧 / 秒）
    fps: f64,
    rate: f64,
}

impl Features {
    /// 帧 `n`（可带小数）对应的时刻（秒）。帧以 `n·HOP` 为窗中心；谱通量的峰平均落在起音前约半个步长，补回来。
    fn time_of(&self, n: f64) -> f64 {
        (n * HOP as f64 + HOP as f64 / 2.0) / self.rate
    }
}

fn features(samples: &[f32], rate: f64) -> Features {
    let mut fft = Fft::new(WINDOW);
    let window: Vec<f32> = (0..WINDOW)
        .map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / WINDOW as f64).cos()) as f32)
        .collect();
    let norm = window.iter().sum::<f32>() / 2.0;
    let bins = WINDOW / 2 + 1;
    let low_bins = ((LOW_HZ / rate * WINDOW as f64).ceil() as usize).clamp(2, bins);
    let frames = samples.len() / HOP + 1;
    let mut buf = vec![0.0f32; WINDOW];
    let mut mag = vec![0.0f32; bins];
    let mut prev = vec![0.0f32; bins];
    let mut onset = Vec::with_capacity(frames);
    let mut low = Vec::with_capacity(frames);
    let mut rms = Vec::with_capacity(frames);
    for n in 0..frames {
        // 窗以 n·HOP 为中心：窗内第 i 点对应采样 n·HOP + i − WINDOW/2（越界补零）
        let base = n * HOP;
        for (i, b) in buf.iter_mut().enumerate() {
            let at = (base + i).checked_sub(WINDOW / 2);
            *b = match at {
                Some(at) if at < samples.len() => samples[at] * window[i],
                _ => 0.0,
            };
        }
        fft.magnitudes(&buf, &mut mag);
        let (mut flux, mut low_flux) = (0.0f32, 0.0f32);
        for k in 1..bins {
            let lm = (GAMMA * mag[k] / norm).ln_1p();
            let d = (lm - prev[k]).max(0.0);
            if n > 0 {
                flux += d;
                if k < low_bins {
                    low_flux += d;
                }
            }
            prev[k] = lm;
        }
        onset.push(flux);
        low.push(low_flux);
        let hop = &samples[(n * HOP).min(samples.len())..((n + 1) * HOP).min(samples.len())];
        let energy = if hop.is_empty() { 0.0 } else { hop.iter().map(|s| s * s).sum::<f32>() / hop.len() as f32 };
        rms.push(energy.sqrt());
    }
    Features { onset, low, rms, fps: rate / HOP as f64, rate }
}

/// 减去局部均值、半波整流、按标准差归一化。
fn normalize(raw: &[f32]) -> Vec<f32> {
    const HALF: usize = 8;
    let n = raw.len();
    let mut prefix = vec![0.0f64; n + 1];
    for (i, v) in raw.iter().enumerate() {
        prefix[i + 1] = prefix[i] + f64::from(*v);
    }
    let out: Vec<f32> = (0..n)
        .map(|i| {
            let (a, b) = (i.saturating_sub(HALF), (i + HALF + 1).min(n));
            let mean = (prefix[b] - prefix[a]) / (b - a) as f64;
            (f64::from(raw[i]) - mean).max(0.0) as f32
        })
        .collect();
    let var = out.iter().map(|v| f64::from(*v) * f64::from(*v)).sum::<f64>() / n.max(1) as f64;
    let std = var.sqrt() as f32;
    if std <= 1e-9 {
        return vec![0.0; n];
    }
    out.iter().map(|v| v / std).collect()
}

/// 自相关测速。
///
/// # Returns
///
/// `(周期（帧，带小数）, 自相关峰相对 0 延迟的强度 0~1)`；音频太短时为 `None`。
fn estimate_period(onset: &[f32], fps: f64) -> Option<(f64, f64)> {
    let lmin = ((fps * 60.0 / MAX_BPM).floor() as usize).max(1);
    let lmax = (fps * 60.0 / MIN_BPM).ceil() as usize;
    if onset.len() < lmax * MIN_PERIODS / 2 || onset.len() < 2 * lmax + 2 {
        // 太短：连 4 个最慢的周期都放不下
        return None;
    }
    let ac = |l: usize| -> f64 {
        let n = onset.len() - l;
        (0..n).map(|i| f64::from(onset[i]) * f64::from(onset[i + l])).sum::<f64>() / n as f64
    };
    let ac0 = ac(0);
    if ac0 <= 1e-12 {
        return None;
    }
    let acs: Vec<f64> = (0..=lmax + 1).map(ac).collect();
    // 不加倍周期的谐波支持：小节重音会让倍周期的自相关更大，从而把速度估成一半
    let score = |l: usize| -> f64 {
        let bpm = 60.0 * fps / l as f64;
        let prior = (-0.5 * ((bpm / PRIOR_BPM).log2() / PRIOR_OCTAVES).powi(2)).exp();
        acs[l] * prior
    };
    let best = (lmin..=lmax).max_by(|a, b| score(*a).total_cmp(&score(*b)))?;
    let delta = if best > lmin && best < lmax {
        let (y0, y1, y2) = (score(best - 1), score(best), score(best + 1));
        let den = y0 - 2.0 * y1 + y2;
        if den.abs() > 1e-12 { (0.5 * (y0 - y2) / den).clamp(-0.5, 0.5) } else { 0.0 }
    } else {
        0.0
    };
    Some((best as f64 + delta, (acs[best] / ac0).clamp(0.0, 1.0)))
}

/// 动态规划跟拍。
///
/// # Returns
///
/// 逐拍所在的帧（升序）。
fn track_beats(onset: &[f32], period: f64) -> Vec<usize> {
    let n = onset.len();
    let lo = (period / 2.0).round().max(1.0) as usize;
    let hi = (period * 2.0).round() as usize;
    let mut cum = vec![0.0f32; n];
    let mut back = vec![usize::MAX; n];
    for t in 0..n {
        let mut best = f32::NEG_INFINITY;
        let mut arg = usize::MAX;
        if t >= lo {
            let from = t.saturating_sub(hi);
            for (prev, score) in cum.iter().enumerate().take(t - lo + 1).skip(from) {
                let ratio = (t - prev) as f64 / period;
                let cost = TIGHTNESS * (ratio.ln() as f32).powi(2);
                let v = score - cost;
                if v > best {
                    best = v;
                    arg = prev;
                }
            }
        }
        cum[t] = onset[t] + if arg == usize::MAX { 0.0 } else { best.max(0.0) };
        back[t] = if arg != usize::MAX && best > 0.0 { arg } else { usize::MAX };
    }
    // 结尾附近（最后一个周期内）累计分最高的帧作为最后一拍
    let tail = n.saturating_sub(period.ceil() as usize + 1);
    let Some(mut t) = (tail..n).max_by(|a, b| cum[*a].total_cmp(&cum[*b])) else {
        return Vec::new();
    };
    let mut beats = vec![t];
    while back[t] != usize::MAX {
        t = back[t];
        beats.push(t);
    }
    beats.reverse();
    // 去掉首尾落在静音里的拍
    let mean = beats.iter().map(|b| onset[*b]).sum::<f32>() / beats.len().max(1) as f32;
    let strong = |b: usize| onset[b.saturating_sub(1)..(b + 2).min(n)].iter().copied().fold(0.0, f32::max) >= 0.1 * mean;
    let first = beats.iter().position(|b| strong(*b)).unwrap_or(0);
    let last = beats.iter().rposition(|b| strong(*b)).unwrap_or(beats.len().saturating_sub(1));
    beats[first..=last.max(first)].to_vec()
}

/// 抛物线插值求峰的小数位置。
fn refine(values: &[f32], i: usize) -> f64 {
    if i == 0 || i + 1 >= values.len() {
        return i as f64;
    }
    let (y0, y1, y2) = (f64::from(values[i - 1]), f64::from(values[i]), f64::from(values[i + 1]));
    let den = y0 - 2.0 * y1 + y2;
    if den.abs() < 1e-12 {
        return i as f64;
    }
    i as f64 + (0.5 * (y0 - y2) / den).clamp(-0.5, 0.5)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    let n = v.len();
    if n == 0 {
        return 0.0;
    }
    if n % 2 == 1 { v[n / 2] } else { f64::midpoint(v[n / 2 - 1], v[n / 2]) }
}

/// 分析一段单声道采样。
///
/// # Arguments
///
/// * `samples` - 单声道采样（-1.0 ~ 1.0）。
/// * `rate` - 采样率（Hz），建议不高于 [`ANALYSIS_RATE`]（见 [`Downsampler`]）。
///
/// # Returns
///
/// 分析结果；音频太短（不足约 8 个周期）、近乎静音或没有可跟踪的节拍时为 `None`。
#[must_use]
pub fn analyze_samples(samples: &[f32], rate: f64) -> Option<BeatAnalysis> {
    if rate <= 0.0 || samples.len() < WINDOW * 4 {
        return None;
    }
    let feats = features(samples, rate);
    let onset = normalize(&feats.onset);
    let (period, strength) = estimate_period(&onset, feats.fps)?;
    let frames = track_beats(&onset, period);
    if frames.len() < MIN_PERIODS / 2 {
        return None;
    }
    let times: Vec<f64> = frames.iter().map(|f| feats.time_of(refine(&onset, *f))).collect();

    // 稳健拟合：先用拍间隔中位数定周期，给每拍编号，再用最小二乘求周期与相位
    let ibis: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    let rough = median(ibis.clone());
    if rough <= 0.0 {
        return None;
    }
    let ks: Vec<f64> = times.iter().map(|t| ((t - times[0]) / rough).round()).collect();
    let n = times.len() as f64;
    let (mk, mt) = (ks.iter().sum::<f64>() / n, times.iter().sum::<f64>() / n);
    let (mut sxy, mut sxx) = (0.0, 0.0);
    for (k, t) in ks.iter().zip(&times) {
        sxy += (k - mk) * (t - mt);
        sxx += (k - mk) * (k - mk);
    }
    let fitted = if sxx > 0.0 { sxy / sxx } else { rough };
    let mut bpm = 60.0 / fitted;
    if !(MIN_BPM * 0.9..=MAX_BPM * 1.1).contains(&bpm) {
        return None;
    }
    bpm = if (bpm - bpm.round()).abs() <= 0.15 { bpm.round() } else { (bpm * 10.0).round() / 10.0 };
    let beat_s = 60.0 / bpm;
    // 用最终周期重新求相位（各拍残差的中位数）
    let phase = median(times.iter().zip(&ks).map(|(t, k)| t - times[0] - k * beat_s).collect()) + times[0];

    // 强拍：4 个相位上低频起音的总和
    let low = normalize(&feats.low);
    let low_at = |t: f64| -> f32 {
        let f = (t * feats.rate - HOP as f64 / 2.0) / HOP as f64;
        let i = f.round().max(0.0) as usize;
        low[i.saturating_sub(1)..(i + 2).min(low.len())].iter().copied().fold(0.0, f32::max)
    };
    let bar = beat_s * f64::from(BEATS_PER_BAR);
    let phases: Vec<f32> = (0..BEATS_PER_BAR)
        .map(|p| {
            ks.iter()
                .filter(|k| (**k as i64 - i64::from(p)).rem_euclid(i64::from(BEATS_PER_BAR)) == 0)
                .map(|k| low_at(phase + k * beat_s))
                .sum()
        })
        .collect();
    let down = (0..BEATS_PER_BAR as usize).max_by(|a, b| phases[*a].total_cmp(&phases[*b])).unwrap_or(0);
    let downbeat = phase + down as f64 * beat_s;
    let mut offset_s = downbeat.rem_euclid(bar);
    // 浮点误差落在一小节末尾时归零（例如 1.9997 s 而一小节 2 s）
    if bar - offset_s < 0.0005 {
        offset_s = 0.0;
    }

    let regularity = if ibis.is_empty() {
        0.0
    } else {
        let mean = ibis.iter().sum::<f64>() / ibis.len() as f64;
        let var = ibis.iter().map(|d| (d - mean).powi(2)).sum::<f64>() / ibis.len() as f64;
        (1.0 - 4.0 * var.sqrt() / mean.max(1e-9)).clamp(0.0, 1.0)
    };
    let confidence = ((strength * 2.0).min(1.0) * regularity).clamp(0.0, 1.0);
    let duration_s = samples.len() as f64 / rate;

    Some(BeatAnalysis {
        bpm,
        offset_ms: (offset_s * 1000.0).round() as i64,
        beats_per_bar: BEATS_PER_BAR,
        beats_ms: times.iter().map(|t| (t.max(0.0) * 1000.0).round() as u64).collect(),
        confidence,
        duration_ms: (duration_s * 1000.0).round() as u64,
        sections: sections(&feats, offset_s, bar, duration_s),
    })
}

/// 按小节能量分段。
fn sections(feats: &Features, offset_s: f64, bar_s: f64, duration_s: f64) -> Vec<SectionGuess> {
    let whole = |energy: f64| vec![SectionGuess { start_ms: 0, end_ms: (duration_s * 1000.0).round() as u64, energy }];
    if bar_s <= 0.0 {
        return whole(1.0);
    }
    // 小节边界（秒）：从 0 开始，第一个强拍之后按小节推进
    // 不足半小节的首尾零头并入相邻小节（避免一个极短的“小节”被当成能量突变）
    let mut edges = vec![0.0];
    let mut t = offset_s;
    while t < duration_s {
        if t > bar_s / 2.0 && duration_s - t > bar_s / 2.0 {
            edges.push(t);
        }
        t += bar_s;
    }
    edges.push(duration_s);
    let bar_count = edges.len() - 1;
    let db: Vec<f64> = (0..bar_count)
        .map(|j| {
            let (a, b) = ((edges[j] * feats.fps) as usize, ((edges[j + 1] * feats.fps) as usize).min(feats.rms.len()));
            let slice = &feats.rms[a.min(b)..b];
            let mean = if slice.is_empty() { 0.0 } else { slice.iter().map(|v| f64::from(*v)).sum::<f64>() / slice.len() as f64 };
            20.0 * (mean + 1e-6).log10()
        })
        .collect();
    if bar_count < MIN_SECTION_BARS * 2 {
        return whole(1.0);
    }
    let avg = |r: std::ops::Range<usize>| db[r.clone()].iter().sum::<f64>() / r.len().max(1) as f64;
    let novelty: Vec<f64> = (0..bar_count)
        .map(|j| {
            if j < NOVELTY_BARS || j + NOVELTY_BARS > bar_count {
                0.0
            } else {
                (avg(j..j + NOVELTY_BARS) - avg(j - NOVELTY_BARS..j)).abs()
            }
        })
        .collect();
    // 局部极大、超过阈值、与上一个边界相隔足够远
    let mut cuts: Vec<usize> = Vec::new();
    let mut order: Vec<usize> = (0..bar_count).filter(|j| novelty[*j] >= SECTION_THRESHOLD_DB).collect();
    order.sort_by(|a, b| novelty[*b].total_cmp(&novelty[*a]));
    for j in order {
        if j < MIN_SECTION_BARS / 2 || bar_count - j < MIN_SECTION_BARS / 2 {
            continue;
        }
        if cuts.iter().all(|c| c.abs_diff(j) >= MIN_SECTION_BARS) {
            cuts.push(j);
        }
    }
    cuts.sort_unstable();
    let mut bounds = vec![0];
    bounds.extend(cuts);
    bounds.push(bar_count);
    let levels: Vec<f64> = bounds.windows(2).map(|w| avg(w[0]..w[1])).collect();
    let (lo, hi) = levels.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| (a.min(*v), b.max(*v)));
    bounds
        .windows(2)
        .zip(&levels)
        .map(|(w, level)| SectionGuess {
            start_ms: (edges[w[0]] * 1000.0).round() as u64,
            end_ms: (edges[w[1]] * 1000.0).round() as u64,
            energy: if hi - lo > 1e-9 { (level - lo) / (hi - lo) } else { 1.0 },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 11_025.0;

    /// 合成的鼓点：`bpm` 速度、第一拍在 `first_s` 秒，每拍一声高频“嗒”，强拍再叠一声低频“咚”；
    /// `gain` 给出每个时刻的整体音量。
    #[expect(clippy::many_single_char_names, reason = "合成节拍的数学记法为习惯命名")]
    fn click_track(bpm: f64, first_s: f64, seconds: f64, gain: impl Fn(f64) -> f32) -> Vec<f32> {
        let n = (seconds * RATE) as usize;
        let mut out = vec![0.0f32; n];
        let beat = 60.0 / bpm;
        let mut k = 0usize;
        loop {
            let t0 = first_s + k as f64 * beat;
            if t0 >= seconds {
                break;
            }
            let start = (t0 * RATE) as usize;
            let g = gain(t0);
            for i in 0..(0.06 * RATE) as usize {
                let Some(o) = out.get_mut(start + i) else { break };
                let t = i as f64 / RATE;
                let decay = (-t * 60.0).exp();
                let mut v = (2.0 * std::f64::consts::PI * 3000.0 * t).sin() * decay * 0.5;
                if k.is_multiple_of(4) {
                    v += (2.0 * std::f64::consts::PI * 70.0 * t).sin() * (-t * 25.0).exp() * 0.8;
                }
                *o += v as f32 * g;
            }
            k += 1;
        }
        // 一点底噪，避免完全静音
        let mut seed = 12_345u32;
        for o in &mut out {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            *o += ((seed >> 16) as f32 / 32_768.0 - 1.0) * 0.002;
        }
        out
    }

    #[test]
    fn fft_的幅度谱峰值在对应频点() {
        let mut fft = Fft::new(64);
        let input: Vec<f32> = (0..64).map(|i| (2.0 * std::f64::consts::PI * 5.0 * f64::from(i) / 64.0).cos() as f32).collect();
        let mut out = vec![0.0; 33];
        fft.magnitudes(&input, &mut out);
        let peak = out.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert_eq!(peak, 5);
        assert!((out[5] - 32.0).abs() < 1e-3, "幅度 = N/2");
        assert!(out[7] < 1e-3);
    }

    #[test]
    fn 降采样到分析采样率_低采样率不变() {
        let mut d = Downsampler::new(44_100.0);
        for i in 0..44_100 {
            d.push(if i % 2 == 0 { 1.0 } else { 0.0 });
        }
        assert!((d.rate - ANALYSIS_RATE).abs() < 1e-9);
        let out = d.finish();
        assert_eq!(out.len(), 11_025);
        assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-6), "盒式滤波取平均");
        let mut d = Downsampler::new(8000.0);
        d.push(0.3);
        assert_eq!(d.rate, 8000.0);
        assert_eq!(d.finish(), vec![0.3]);
    }

    #[test]
    fn 识别_120_bpm_与强拍位置() {
        let samples = click_track(120.0, 0.3, 24.0, |_| 1.0);
        let a = analyze_samples(&samples, RATE).expect("应能分析");
        assert_eq!(a.bpm, 120.0);
        assert!((a.offset_ms - 300).abs() <= 25, "强拍偏移 {}", a.offset_ms);
        assert_eq!(a.beats_per_bar, 4);
        assert!(a.confidence > 0.5, "置信度 {}", a.confidence);
        assert!(a.beats_ms.len() >= 40);
        // 每拍都接近真实位置
        for b in &a.beats_ms {
            let rel = (*b as f64 / 1000.0 - 0.3) / 0.5;
            assert!((rel - rel.round()).abs() * 500.0 < 30.0, "拍 {b} ms 偏离网格");
        }
    }

    #[test]
    fn 识别_非整数倍步长的速度_强拍不在第一声() {
        // 第一声在 0.2 s 但它不是强拍：让强拍从第 2 拍开始（first = 0.2 - 2 拍）
        let bpm = 96.0;
        let beat = 60.0 / bpm;
        let first = 0.2 + 2.0 * beat;
        // 强拍（k % 4 == 0）从 first 算起，前面再补两声弱拍
        let mut samples = click_track(bpm, first, 30.0, |_| 1.0);
        for k in 0..2 {
            let start = ((0.2 + f64::from(k) * beat) * RATE) as usize;
            for i in 0..(0.06 * RATE) as usize {
                let t = i as f64 / RATE;
                samples[start + i] += ((2.0 * std::f64::consts::PI * 3000.0 * t).sin() * (-t * 60.0).exp() * 0.5) as f32;
            }
        }
        let a = analyze_samples(&samples, RATE).expect("应能分析");
        assert_eq!(a.bpm, 96.0);
        let bar_ms = 4.0 * beat * 1000.0;
        let expected = (first * 1000.0).rem_euclid(bar_ms);
        let diff = (a.offset_ms as f64 - expected).abs();
        assert!(diff.min(bar_ms - diff) <= 30.0, "强拍偏移 {} 期望 {expected}", a.offset_ms);
    }

    #[test]
    fn 常见速度都能识别_不出现倍频错误() {
        for bpm in [72.0, 85.0, 100.0, 128.0, 140.0, 174.0] {
            let samples = click_track(bpm, 0.4, 30.0, |_| 1.0);
            let a = analyze_samples(&samples, RATE).unwrap_or_else(|| panic!("{bpm} BPM 应能分析"));
            assert!((a.bpm - bpm).abs() <= 0.5, "期望 {bpm} 得到 {}", a.bpm);
        }
    }

    #[test]
    fn 能量突变处分段() {
        // 前 20 s 小声、后 20 s 大声（+20 dB）
        let samples = click_track(120.0, 0.0, 40.0, |t| if t < 20.0 { 0.1 } else { 1.0 });
        let a = analyze_samples(&samples, RATE).expect("应能分析");
        assert_eq!(a.sections.len(), 2, "{:?}", a.sections);
        let cut = a.sections[0].end_ms.cast_signed();
        assert!((cut - 20_000).abs() <= 2000, "分段点 {cut}");
        assert_eq!(a.sections[1].start_ms.cast_signed(), cut);
        assert!(a.sections[0].energy < a.sections[1].energy);
        assert_eq!(a.sections[1].energy, 1.0);
        assert_eq!(a.sections.last().unwrap().end_ms, a.duration_ms);
    }

    #[test]
    fn 太短或静音时不给结果() {
        assert!(analyze_samples(&[0.0; 2000], RATE).is_none());
        assert!(analyze_samples(&vec![0.0; (RATE * 20.0) as usize], RATE).is_none());
        let short = click_track(120.0, 0.0, 2.0, |_| 1.0);
        assert!(analyze_samples(&short, RATE).is_none());
    }
}
