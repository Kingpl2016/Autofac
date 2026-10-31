//! 音乐结构分析：在节拍分析（[`crate::beats`]）的基础上统计每小节的特征、给段落打结构标签、找出编排上有用的事件。
//!
//! - 每小节：响度（dB）、相对能量、亮度（频谱重心）、低频占比、起音密度；
//! - 段落：沿用节拍分析按能量切出的段落，按特征向量的距离贪心聚类，相似的段落标同一个字母（A、B、A…），
//!   并给出标签的置信度；
//! - 事件：`hit`（低频起音突出的强拍）、`build`（连续渐强）、`drop`（安静之后突然变响）、`break`（突然变安静）。
//!
//! 结果完全由采样决定（没有随机、没有模型），前端把它写进给模型看的“每段特征表”，
//! 并由编译器把重音片段放到事件的时刻上。`sensitivity` 调整事件与标签的阈值（越大越敏感）。

use serde::{Deserialize, Serialize};

use crate::beats::{self, BeatAnalysis, Features};

/// 分析算法的版本号；算法或输出变化时递增（前端与磁盘缓存据此失效）。
pub const ANALYSIS_VERSION: u32 = 1;
/// 默认灵敏度。
pub const DEFAULT_SENSITIVITY: f64 = 1.0;
/// 最低灵敏度。
pub const MIN_SENSITIVITY: f64 = 0.5;
/// 最高灵敏度。
pub const MAX_SENSITIVITY: f64 = 2.0;
/// 段落标签置信度低于这个值时，前端不据此推断段落角色。
pub const MIN_LABEL_CONFIDENCE: f64 = 0.5;

/// 同一标签的段落特征之间的最大距离（灵敏度 1 时）。
const LABEL_DISTANCE: f64 = 0.18;
/// `drop` / `break`：与前两小节均值相比的响度变化（dB，灵敏度 1 时）。
const JUMP_DB: f64 = 6.0;
/// `build`：每小节至少变响多少（dB）才算“在渐强”。
const BUILD_STEP_DB: f64 = 0.3;
/// `build`：至少持续几小节。
const BUILD_MIN_BARS: usize = 4;
/// `build`：总共至少变响多少（dB，灵敏度 1 时）。
const BUILD_RISE_DB: f64 = 4.0;
/// 同类 `drop` / `break` 之间至少相隔几小节。
const EVENT_GAP_BARS: usize = 4;
/// `hit`：强拍低频起音至少是全曲逐拍均值的多少倍（灵敏度 1 时）。
const HIT_RATIO: f64 = 1.5;
/// `hit`：只在相对能量不低于这个值的小节上找。
const HIT_MIN_ENERGY: f64 = 0.5;
/// 起音密度：归一化起音强度超过这个值的局部极大算一次起音。
const ONSET_PEAK: f32 = 1.0;

/// 一小节的特征。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct BarFeature {
    /// 起点（毫秒，素材内）。
    pub start_ms: u64,
    /// 终点（毫秒，素材内）。
    pub end_ms: u64,
    /// 平均响度（dBFS）。
    pub loudness_db: f64,
    /// 相对能量 0~1（全曲第 10 百分位为 0，第 90 百分位为 1）。
    pub energy: f64,
    /// 相对亮度 0~1（频谱重心，全曲内比较）。
    pub brightness: f64,
    /// 相对低频占比 0~1（全曲内比较）。
    pub bass: f64,
    /// 相对起音密度 0~1（每拍起音数，全曲内比较）。
    pub density: f64,
}

/// 一个段落的特征与结构标签。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct SectionFeature {
    /// 起点（毫秒，素材内）。
    pub start_ms: u64,
    /// 终点（毫秒，素材内）。
    pub end_ms: u64,
    /// 相对能量 0~1（同 [`beats::SectionGuess::energy`]）。
    pub energy: f64,
    /// 相对亮度 0~1。
    pub brightness: f64,
    /// 相对低频占比 0~1。
    pub bass: f64,
    /// 相对起音密度 0~1。
    pub density: f64,
    /// 结构标签：相似的段落同一个字母，按首次出现的顺序 `A`、`B`、`C`…
    pub label: String,
    /// 标签的置信度 0~1（低于 [`MIN_LABEL_CONFIDENCE`] 时不可靠）。
    pub label_confidence: f64,
}

/// 事件类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum EventKind {
    /// 低频起音突出的强拍（适合冲击）。
    Hit,
    /// 连续渐强（`end_ms` 为渐强结束）。
    Build,
    /// 安静之后突然变响。
    Drop,
    /// 突然变安静。
    Break,
}

/// 一个事件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct MusicEvent {
    /// 类型。
    pub kind: EventKind,
    /// 时刻（毫秒，素材内）；`build` 为渐强开始。
    pub at_ms: u64,
    /// 持续事件的终点（毫秒，素材内），只有 `build` 有。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub end_ms: Option<u64>,
    /// 强度 0~1。
    pub strength: f64,
}

/// 音乐结构分析结果（时刻均为素材内时刻）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AudioAnalysis {
    /// 算法版本（[`ANALYSIS_VERSION`]）。
    pub version: u32,
    /// 使用的灵敏度。
    pub sensitivity: f64,
    /// 节拍分析结果。
    pub beats: BeatAnalysis,
    /// 每小节的特征（按时间顺序首尾相接）。
    pub bars: Vec<BarFeature>,
    /// 段落（与 `beats.sections` 一一对应）。
    pub sections: Vec<SectionFeature>,
    /// 事件（按时刻升序）。
    pub events: Vec<MusicEvent>,
}

/// 把灵敏度夹到允许的范围（非数字时取默认值）。
///
/// # Arguments
///
/// * `sensitivity` - 前端传来的灵敏度。
///
/// # Returns
///
/// [`MIN_SENSITIVITY`]..=[`MAX_SENSITIVITY`] 内的值，保留两位小数。
#[must_use]
pub fn clamp_sensitivity(sensitivity: f64) -> f64 {
    if sensitivity.is_finite() {
        (sensitivity.clamp(MIN_SENSITIVITY, MAX_SENSITIVITY) * 100.0).round() / 100.0
    } else {
        DEFAULT_SENSITIVITY
    }
}

/// 分析一段单声道采样的音乐结构。
///
/// # Arguments
///
/// * `samples` - 单声道采样（-1.0 ~ 1.0）。
/// * `rate` - 采样率（Hz），建议不高于 [`beats::ANALYSIS_RATE`]。
/// * `sensitivity` - 灵敏度（见 [`clamp_sensitivity`]）。
///
/// # Returns
///
/// 分析结果；没有可跟踪的节拍时为 `None`（同 [`beats::analyze_samples`]）。
#[must_use]
pub fn analyze_samples(samples: &[f32], rate: f64, sensitivity: f64) -> Option<AudioAnalysis> {
    let sensitivity = clamp_sensitivity(sensitivity);
    let (beats, feats) = beats::analyze_detailed(samples, rate)?;
    let seconds_per_beat = 60.0 / beats.bpm;
    let duration_s = beats.duration_ms as f64 / 1000.0;
    let edges = beats::bar_edges(beats.offset_ms as f64 / 1000.0, seconds_per_beat * f64::from(beats.beats_per_bar), duration_s);
    let bars = bar_features(&feats, &edges, seconds_per_beat);
    let sections = section_features(&beats, &bars, sensitivity);
    let events = find_events(&beats, &feats, &bars, &edges, sensitivity);
    Some(AudioAnalysis { version: ANALYSIS_VERSION, sensitivity, beats, bars, sections, events })
}

/// 第 `p` 百分位（`values` 非空）。
fn percentile(values: &[f64], p: f64) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    let i = ((v.len() - 1) as f64 * p).round() as usize;
    v[i.min(v.len() - 1)]
}

/// 全曲内的相对值：第 10 百分位为 0，第 90 百分位为 1（夹在 0~1）；整体变化小于 `min_range` 时全部为 0.5。
fn relative(values: &[f64], min_range: f64) -> Vec<f64> {
    if values.is_empty() {
        return Vec::new();
    }
    let (lo, hi) = (percentile(values, 0.1), percentile(values, 0.9));
    if hi - lo < min_range {
        return vec![0.5; values.len()];
    }
    values.iter().map(|v| ((v - lo) / (hi - lo)).clamp(0.0, 1.0)).collect()
}

/// 帧区间 `[a, b)` 内的 RMS 加权均值。
fn weighted_mean(values: &[f32], weights: &[f32], a: usize, b: usize) -> f64 {
    let (mut sum, mut total) = (0.0f64, 0.0f64);
    for i in a..b.min(values.len()).min(weights.len()) {
        let w = f64::from(weights[i]) * f64::from(weights[i]);
        sum += f64::from(values[i]) * w;
        total += w;
    }
    if total > 1e-12 { sum / total } else { 0.0 }
}

/// 每小节的特征（`beat_s` 为一拍的秒数）。
fn bar_features(feats: &Features, edges: &[f64], beat_s: f64) -> Vec<BarFeature> {
    let onset = beats::normalize(&feats.onset);
    let frame = |t: f64| ((t * feats.fps) as usize).min(feats.rms.len());
    let mut loudness = Vec::new();
    let mut centroid = Vec::new();
    let mut bass = Vec::new();
    let mut density = Vec::new();
    for w in edges.windows(2) {
        let (a, b) = (frame(w[0]), frame(w[1]));
        let slice = &feats.rms[a.min(b)..b];
        let mean = if slice.is_empty() { 0.0 } else { slice.iter().map(|v| f64::from(*v)).sum::<f64>() / slice.len() as f64 };
        loudness.push(20.0 * (mean + 1e-6).log10());
        centroid.push(weighted_mean(&feats.centroid, &feats.rms, a, b));
        bass.push(weighted_mean(&feats.bass, &feats.rms, a, b));
        let peaks = (a.max(1)..b.min(onset.len().saturating_sub(1)))
            .filter(|i| onset[*i] > ONSET_PEAK && onset[*i] >= onset[i - 1] && onset[*i] > onset[i + 1])
            .count();
        // 按实际时长折算成每拍起音数（首尾不足一小节的零头也可比）
        let beats_here = ((w[1] - w[0]) / beat_s).max(1e-6);
        density.push(peaks as f64 / beats_here);
    }
    let energy = relative(&loudness, 1.0);
    let brightness = relative(&centroid, 50.0);
    let bass_rel = relative(&bass, 0.03);
    let density_rel = relative(&density, 0.05);
    edges
        .windows(2)
        .enumerate()
        .map(|(j, w)| BarFeature {
            start_ms: (w[0] * 1000.0).round() as u64,
            end_ms: (w[1] * 1000.0).round() as u64,
            loudness_db: (loudness[j] * 10.0).round() / 10.0,
            energy: round3(energy[j]),
            brightness: round3(brightness[j]),
            bass: round3(bass_rel[j]),
            density: round3(density_rel[j]),
        })
        .collect()
}

/// 保留三位小数（输出稳定、缓存文件小）。
fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// 段落特征向量 `[能量, 亮度, 低频, 密度]` 之间的距离（均方根）。
fn distance(a: &[f64; 4], b: &[f64; 4]) -> f64 {
    (a.iter().zip(b).map(|(x, y)| (x - y).powi(2)).sum::<f64>() / 4.0).sqrt()
}

/// 第 `i` 个标签的字母（超过 26 个时接着用 `A2`、`B2`…）。
fn label_name(i: usize) -> String {
    let letter = char::from(b'A' + (i % 26) as u8);
    if i < 26 { letter.to_string() } else { format!("{letter}{}", i / 26 + 1) }
}

/// 段落特征与结构标签。
fn section_features(beats: &BeatAnalysis, bars: &[BarFeature], sensitivity: f64) -> Vec<SectionFeature> {
    let threshold = LABEL_DISTANCE / sensitivity;
    let vectors: Vec<[f64; 4]> = beats
        .sections
        .iter()
        .map(|s| {
            // 小节中点落在段落里的算这一段
            let inside: Vec<&BarFeature> = bars
                .iter()
                .filter(|b| (s.start_ms..s.end_ms).contains(&b.start_ms.midpoint(b.end_ms)))
                .collect();
            let avg = |f: fn(&BarFeature) -> f64| if inside.is_empty() { 0.5 } else { inside.iter().map(|b| f(b)).sum::<f64>() / inside.len() as f64 };
            [s.energy, avg(|b| b.brightness), avg(|b| b.bass), avg(|b| b.density)]
        })
        .collect();
    // 贪心聚类：按时间顺序，离最近的已有标签（成员均值）足够近就并入，否则开一个新标签
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut assigned = vec![0usize; vectors.len()];
    let centroid = |ids: &[usize]| -> [f64; 4] {
        let mut c = [0.0; 4];
        for i in ids {
            for (k, v) in vectors[*i].iter().enumerate() {
                c[k] += v / ids.len() as f64;
            }
        }
        c
    };
    for (i, v) in vectors.iter().enumerate() {
        let best = members
            .iter()
            .enumerate()
            .map(|(l, ids)| (l, distance(v, &centroid(ids))))
            .min_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        match best {
            Some((l, d)) if d < threshold => {
                members[l].push(i);
                assigned[i] = l;
            }
            _ => {
                assigned[i] = members.len();
                members.push(vec![i]);
            }
        }
    }
    let centroids: Vec<[f64; 4]> = members.iter().map(|ids| centroid(ids)).collect();
    beats
        .sections
        .iter()
        .zip(&vectors)
        .enumerate()
        .map(|(i, (s, v))| {
            let l = assigned[i];
            // 离自己标签越近、离别的标签越远，越可信
            let own = distance(v, &centroids[l]);
            let other = centroids
                .iter()
                .enumerate()
                .filter(|(k, _)| *k != l)
                .map(|(_, c)| distance(v, c))
                .fold(f64::INFINITY, f64::min);
            let fit = if members[l].len() > 1 { (1.0 - own / threshold).clamp(0.0, 1.0) } else { 1.0 };
            let separation = if other.is_finite() { (other / (2.0 * threshold)).clamp(0.0, 1.0) } else { 0.0 };
            SectionFeature {
                start_ms: s.start_ms,
                end_ms: s.end_ms,
                energy: round3(s.energy),
                brightness: round3(v[1]),
                bass: round3(v[2]),
                density: round3(v[3]),
                label: label_name(l),
                label_confidence: round3(fit * separation),
            }
        })
        .collect()
}

/// 事件：渐强、突变、强拍冲击。
fn find_events(beats: &BeatAnalysis, feats: &Features, bars: &[BarFeature], edges: &[f64], sensitivity: f64) -> Vec<MusicEvent> {
    let mut events = Vec::new();
    let db: Vec<f64> = bars.iter().map(|b| b.loudness_db).collect();
    let n = db.len();
    if n == 0 {
        return events;
    }
    let median = percentile(&db, 0.5);

    // 突变：与前两小节的均值相比
    let jump = JUMP_DB / sensitivity;
    let mut jumps: Vec<(EventKind, usize, f64)> = Vec::new();
    for j in 2..n {
        let before = f64::midpoint(db[j - 1], db[j - 2]);
        let delta = db[j] - before;
        // 爆点要“落到”全曲偏响的位置，断层要落到偏静的位置（排除安静段内部的小起伏）
        if delta >= jump && db[j] >= median {
            jumps.push((EventKind::Drop, j, delta));
        } else if -delta >= jump && db[j] < median {
            jumps.push((EventKind::Break, j, -delta));
        }
    }
    // 同类事件相隔太近时留更强的（同强度留更早的）
    jumps.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.1.cmp(&b.1)));
    let mut kept: Vec<(EventKind, usize, f64)> = Vec::new();
    for e in jumps {
        if kept.iter().all(|k| k.0 != e.0 || k.1.abs_diff(e.1) >= EVENT_GAP_BARS) {
            kept.push(e);
        }
    }
    for (kind, j, delta) in kept {
        events.push(MusicEvent { kind, at_ms: bars[j].start_ms, end_ms: None, strength: round3((delta / 12.0).clamp(0.0, 1.0)) });
    }

    // 渐强：连续多小节每小节都变响
    let rise_needed = BUILD_RISE_DB / sensitivity;
    let mut start = 0usize;
    for j in 1..=n {
        let rising = j < n && db[j] > db[j - 1] + BUILD_STEP_DB;
        if rising {
            continue;
        }
        // 区间 [start, j) 里从 start 起每小节都比上一小节响
        let len = j - start;
        if len >= BUILD_MIN_BARS {
            let rise = db[j - 1] - db[start];
            if rise >= rise_needed {
                events.push(MusicEvent {
                    kind: EventKind::Build,
                    at_ms: bars[start].start_ms,
                    end_ms: Some(bars[j - 1].end_ms),
                    strength: round3((rise / 12.0).clamp(0.0, 1.0)),
                });
            }
        }
        start = j;
    }

    // 冲击：强拍上的低频起音明显高于全曲逐拍的平均水平，且所在小节足够响；每小节最多一个
    let low = beats::normalize(&feats.low);
    let low_at = |t_ms: f64| -> f64 {
        let f = (t_ms / 1000.0 * feats.rate - 128.0) / 256.0;
        let i = f.round().max(0.0) as usize;
        f64::from(low[i.saturating_sub(1)..(i + 2).min(low.len())].iter().copied().fold(0.0, f32::max))
    };
    let beat_values: Vec<f64> = beats.beats_ms.iter().map(|t| low_at(*t as f64)).collect();
    let mean = if beat_values.is_empty() { 0.0 } else { beat_values.iter().sum::<f64>() / beat_values.len() as f64 };
    let offset = beats.offset_ms as f64 / 1000.0;
    if mean > 1e-9 {
        let needed = HIT_RATIO * mean / sensitivity;
        let mut hits = Vec::new();
        for (j, bar) in bars.iter().enumerate() {
            // 小节起点是强拍（第一个零头小节从 0 开始，不是强拍）
            if edges[j] + 1e-3 < offset || bar.energy < HIT_MIN_ENERGY {
                continue;
            }
            let v = low_at(edges[j] * 1000.0);
            if v >= needed {
                hits.push((bar.start_ms, v));
            }
        }
        let max = hits.iter().map(|h| h.1).fold(0.0, f64::max).max(1e-9);
        for (at, v) in hits {
            events.push(MusicEvent { kind: EventKind::Hit, at_ms: at, end_ms: None, strength: round3(v / max) });
        }
    }

    events.sort_by(|a, b| a.at_ms.cmp(&b.at_ms).then(a.kind.cmp(&b.kind)));
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 11_025.0;

    /// 合成的鼓点（120 BPM，一小节 2 秒）：每拍一声高频“嗒”，强拍再叠一声低频“咚”；`gain(t)` 给出每拍的音量。
    #[expect(clippy::many_single_char_names, reason = "合成节拍的数学记法为习惯命名")]
    fn click_track(seconds: f64, gain: impl Fn(f64) -> f32) -> Vec<f32> {
        let n = (seconds * RATE) as usize;
        let mut out = vec![0.0f32; n];
        let beat = 0.5;
        let mut k = 0usize;
        loop {
            let t0 = k as f64 * beat;
            if t0 >= seconds {
                break;
            }
            let start = (t0 * RATE) as usize;
            let g = gain(t0);
            for i in 0..(0.06 * RATE) as usize {
                let Some(o) = out.get_mut(start + i) else { break };
                let t = i as f64 / RATE;
                let mut v = (2.0 * std::f64::consts::PI * 3000.0 * t).sin() * (-t * 60.0).exp() * 0.5;
                if k.is_multiple_of(4) {
                    v += (2.0 * std::f64::consts::PI * 70.0 * t).sin() * (-t * 25.0).exp() * 0.8;
                }
                *o += v as f32 * g;
            }
            k += 1;
        }
        let mut seed = 12_345u32;
        for o in &mut out {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            *o += ((seed >> 16) as f32 / 32_768.0 - 1.0) * 0.001;
        }
        out
    }

    #[test]
    fn a_b_a_结构标出相同字母() {
        // 安静 16 小节 → 响 16 小节 → 安静 16 小节
        let samples = click_track(96.0, |t| if (32.0..64.0).contains(&t) { 1.0 } else { 0.15 });
        let a = analyze_samples(&samples, RATE, 1.0).expect("应能分析");
        assert_eq!(a.beats.bpm, 120.0);
        let labels: Vec<&str> = a.sections.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(labels, ["A", "B", "A"], "{:?}", a.sections);
        assert!(a.sections[1].energy > 0.9 && a.sections[0].energy < 0.1);
        assert!(a.sections.iter().all(|s| s.label_confidence >= MIN_LABEL_CONFIDENCE), "{:?}", a.sections);
        assert_eq!(a.bars.len(), 48);
    }

    #[test]
    fn 找出渐强_爆点与断层_冲击每小节最多一个() {
        // 安静 8 小节 → 8 小节渐强 → 16 小节很响 → 8 小节安静
        let gain = |t: f64| -> f32 {
            if t < 16.0 {
                0.08
            } else if t < 32.0 {
                0.08 + 0.22 * ((t - 16.0) / 16.0) as f32
            } else if t < 64.0 {
                1.0
            } else {
                0.08
            }
        };
        let samples = click_track(80.0, gain);
        let a = analyze_samples(&samples, RATE, 1.0).expect("应能分析");
        let of = |k: EventKind| a.events.iter().filter(|e| e.kind == k).collect::<Vec<_>>();
        let builds = of(EventKind::Build);
        assert_eq!(builds.len(), 1, "{:?}", a.events);
        assert!((14_000..=20_000).contains(&builds[0].at_ms), "{builds:?}");
        assert!(builds[0].end_ms.is_some_and(|e| (30_000..=34_000).contains(&e)), "{builds:?}");
        let drops = of(EventKind::Drop);
        assert_eq!(drops.len(), 1, "{:?}", a.events);
        assert_eq!(drops[0].at_ms, 32_000);
        let breaks = of(EventKind::Break);
        assert_eq!(breaks.len(), 1, "{:?}", a.events);
        assert_eq!(breaks[0].at_ms, 64_000);
        // 冲击只在响的段落里，每小节最多一个，都落在强拍上
        let hits = of(EventKind::Hit);
        assert!(hits.len() >= 8 && hits.len() <= 16, "{} hits", hits.len());
        assert!(hits.iter().all(|h| (32_000..64_000).contains(&h.at_ms) && h.at_ms % 2000 == 0), "{hits:?}");
        assert!(hits.windows(2).all(|w| w[1].at_ms - w[0].at_ms >= 2000));
        // 事件按时刻升序
        assert!(a.events.windows(2).all(|w| w[0].at_ms <= w[1].at_ms));
    }

    #[test]
    fn 灵敏度越低事件越少_结果确定() {
        let samples = click_track(80.0, |t| if (32.0..64.0).contains(&t) { 1.0 } else { 0.4 });
        let normal = analyze_samples(&samples, RATE, 1.0).expect("应能分析");
        let low = analyze_samples(&samples, RATE, 0.5).expect("应能分析");
        // 0.4 → 1.0 约 8 dB：灵敏度 1 时算爆点，灵敏度 0.5（阈值 12 dB）时不算
        assert!(normal.events.iter().any(|e| e.kind == EventKind::Drop));
        assert!(!low.events.iter().any(|e| e.kind == EventKind::Drop));
        assert_eq!(analyze_samples(&samples, RATE, 1.0), Some(normal));
        assert_eq!(clamp_sensitivity(9.0), MAX_SENSITIVITY);
        assert_eq!(clamp_sensitivity(f64::NAN), DEFAULT_SENSITIVITY);
    }

    #[test]
    fn 相对值与标签名() {
        assert_eq!(relative(&[1.0, 1.0, 1.0], 0.5), vec![0.5; 3]);
        let r = relative(&[0.0, 5.0, 10.0], 1.0);
        assert_eq!(r[0], 0.0);
        assert_eq!(r[2], 1.0);
        assert_eq!(label_name(0), "A");
        assert_eq!(label_name(27), "B2");
    }
}
