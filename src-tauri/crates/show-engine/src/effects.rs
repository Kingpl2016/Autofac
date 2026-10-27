//! 特效求值：把 [`EffectCue`] 在某一时刻、某一台灯具上渲染成"颜色 + 强度调制"。
//!
//! 约定：
//!
//! - 灯具在分组里的顺序（`index` / `count`）决定特效沿灯具推进的先后；`direction = -1` 把顺序反过来；
//! - 周期取毫秒，或按拍数乘以节拍（没有节拍设置时按 120 BPM），下限 [`MIN_PERIOD_MS`]；
//! - 公式里只用加减乘除、取整与比较，**不用** `sin` / `cos` / `exp`，因此与前端的 TS 镜像
//!   （`lib/effects.ts`）在 IEEE 754 下逐位一致，黄金向量可以精确比对；
//! - 随机（闪烁）用确定性整数哈希，种子来自 Cue，预览、播放、烘焙结果完全相同。

use crate::project::{EffectCue, EffectId, EffectPeriod, Tempo};

/// 周期下限（毫秒）：低于一个输出帧（33 ms）没有意义。
pub const MIN_PERIOD_MS: f64 = 33.0;

/// 没有节拍设置时按拍数换算所用的 BPM。
pub const FALLBACK_BPM: f64 = 120.0;

/// 闪烁特效中，每个节拍步里某台灯具被点亮的概率。
const SPARKLE_DENSITY: f64 = 0.3;

/// 频闪的占空比（亮的比例）。
const STROBE_DUTY: f64 = 0.5;

/// 一次采样的结果。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EffectSample {
    /// 颜色，每个分量 `0..=1`。
    pub rgb: [f64; 3],
    /// 强度调制 `0..=1`：0 取亮度范围下限，1 取上限。
    pub modulation: f64,
}

/// 取小数部分（输入非负时落在 `[0, 1)`）。
fn fract(x: f64) -> f64 {
    x - x.floor()
}

/// smoothstep 曲线。
fn smooth(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// 特效周期换算成毫秒。
///
/// # Arguments
///
/// * `period` - Cue 里的周期设置。
/// * `tempo` - 工程的节拍设置；按拍数时使用，缺省按 [`FALLBACK_BPM`]。
///
/// # Returns
///
/// 毫秒周期，不小于 [`MIN_PERIOD_MS`]；非有限数按下限处理。
#[must_use]
pub fn period_ms(period: EffectPeriod, tempo: Option<Tempo>) -> f64 {
    let ms = match period {
        EffectPeriod::Ms { ms } => ms,
        EffectPeriod::Beats { beats } => {
            let bpm = tempo.map_or(FALLBACK_BPM, |t| t.bpm);
            let bpm = if bpm.is_finite() && bpm > 0.0 { bpm } else { FALLBACK_BPM };
            beats * 60_000.0 / bpm
        }
    };
    if ms.is_finite() {
        ms.max(MIN_PERIOD_MS)
    } else {
        MIN_PERIOD_MS
    }
}

/// 确定性的 32 位整数哈希（闪烁特效的随机源）。
///
/// # Arguments
///
/// * `seed` - Cue 的随机种子。
/// * `index` - 灯具序号。
/// * `step` - 时间步序号。
///
/// # Returns
///
/// 均匀分布的 32 位值。
#[must_use]
pub fn hash32(seed: u32, index: u32, step: u32) -> u32 {
    let mut x = seed
        ^ index.wrapping_add(1).wrapping_mul(0x9E37_79B1)
        ^ step.wrapping_add(1).wrapping_mul(0x85EB_CA6B);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7FEB_352D);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846C_A68B);
    x ^= x >> 16;
    x
}

/// 色相 `[0,1)` 转 RGB（饱和度与明度均为 1），分段线性。
fn hue_to_rgb(h: f64) -> [f64; 3] {
    let h6 = fract(h) * 6.0;
    let i = h6.floor();
    let f = h6 - i;
    match i as u32 {
        0 => [1.0, f, 0.0],
        1 => [1.0 - f, 1.0, 0.0],
        2 => [0.0, 1.0, f],
        3 => [0.0, 1.0 - f, 1.0],
        4 => [f, 0.0, 1.0],
        _ => [1.0, 0.0, 1.0 - f],
    }
}

/// 颜色字节转 `0..=1` 分数。
fn color(c: [u8; 3]) -> [f64; 3] {
    c.map(|v| f64::from(v) / 255.0)
}

/// 在颜色列表上循环插值：`pos` 取 `[0,1)`，列表首尾相接。
#[allow(clippy::many_single_char_names)]
fn cycle_color(colors: &[[u8; 3]], pos: f64) -> [f64; 3] {
    let n = colors.len();
    if n == 1 {
        return color(colors[0]);
    }
    let s = fract(pos) * n as f64;
    let i = s.floor();
    let f = s - i;
    let a = color(colors[(i as usize) % n]);
    let b = color(colors[(i as usize + 1) % n]);
    [
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
    ]
}

/// 渲染特效在某台灯具上的瞬时结果。
///
/// # Arguments
///
/// * `cue` - 特效 Cue。
/// * `tempo` - 工程的节拍设置（周期按拍数时使用）。
/// * `elapsed_ms` - 距 Cue 起点的毫秒数（可为 0，不应为负）。
/// * `index` - 灯具在轨道成员（分组顺序）里的序号，从 0 起。
/// * `count` - 轨道成员总数（至少 1）。
///
/// # Returns
///
/// 该灯具此刻的颜色与强度调制。
#[must_use]
pub fn sample(
    cue: &EffectCue,
    tempo: Option<Tempo>,
    elapsed_ms: i64,
    index: usize,
    count: usize,
) -> EffectSample {
    const WHITE: [u8; 3] = [255, 255, 255];
    let fallback = [WHITE];
    let colors: &[[u8; 3]] = if cue.colors.is_empty() { &fallback } else { &cue.colors };
    let count = count.max(1);
    let pos = if cue.direction < 0 { count - 1 - index.min(count - 1) } else { index.min(count - 1) };
    let n = count as f64;
    let p = pos as f64;
    let period = period_ms(cue.period, tempo);
    let cycles = elapsed_ms.max(0) as f64 / period;
    let spread = cue.phase_spread.clamp(0.0, 1.0);
    // 沿灯具扩散后的周期位置
    let c = fract(cycles + spread * (p / n));

    match cue.effect {
        EffectId::Breathe => EffectSample {
            rgb: color(colors[0]),
            modulation: smooth(1.0 - (2.0 * c - 1.0).abs()),
        },
        EffectId::Rainbow => EffectSample { rgb: hue_to_rgb(c), modulation: 1.0 },
        EffectId::Chase => {
            let head = fract(cycles) * n;
            let diff = (p - head).abs();
            let dist = diff.min(n - diff);
            let tail = 1.0 + spread * (n - 1.0);
            EffectSample {
                rgb: color(colors[0]),
                modulation: (1.0 - dist / tail).clamp(0.0, 1.0),
            }
        }
        EffectId::Wipe => {
            let lit = (p + 0.5) / n <= fract(cycles);
            if lit {
                EffectSample { rgb: color(colors[0]), modulation: 1.0 }
            } else if colors.len() > 1 {
                EffectSample { rgb: color(colors[1]), modulation: 1.0 }
            } else {
                EffectSample { rgb: color(colors[0]), modulation: 0.0 }
            }
        }
        EffectId::Gradient => EffectSample {
            rgb: cycle_color(colors, p / n * spread + cycles),
            modulation: 1.0,
        },
        EffectId::Pulse => {
            let k = 1.0 - c;
            EffectSample { rgb: color(colors[0]), modulation: k * k * k }
        }
        EffectId::Sparkle => {
            let step = cycles.floor();
            let step_u = if step >= 0.0 { step as u32 } else { 0 };
            let h = hash32(cue.seed, pos as u32, step_u);
            let lit = f64::from(h) / 4_294_967_296.0 < SPARKLE_DENSITY;
            if lit {
                let pick = colors[((h >> 8) as usize) % colors.len()];
                EffectSample { rgb: color(pick), modulation: 1.0 - fract(cycles) }
            } else {
                EffectSample { rgb: color(colors[0]), modulation: 0.0 }
            }
        }
        EffectId::Strobe => EffectSample {
            rgb: color(colors[0]),
            modulation: if c < STROBE_DUTY { 1.0 } else { 0.0 },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{CueBase, Easing};

    fn cue(effect: EffectId, colors: Vec<[u8; 3]>, period_ms: f64, spread: f64) -> EffectCue {
        EffectCue {
            base: CueBase {
                id: "e".into(),
                track_id: "t".into(),
                start_ms: 0,
                end_ms: 100_000,
                brightness: 100.0,
                fade_in_ms: 0,
                fade_out_ms: 0,
                easing: Easing::Linear,
            },
            effect,
            colors,
            period: EffectPeriod::Ms { ms: period_ms },
            phase_spread: spread,
            direction: 1,
            range: [0.0, 100.0],
            seed: 7,
        }
    }

    const RED: [u8; 3] = [255, 0, 0];
    const BLUE: [u8; 3] = [0, 0, 255];

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn 周期按毫秒或拍数换算_有下限() {
        assert!(near(period_ms(EffectPeriod::Ms { ms: 800.0 }, None), 800.0));
        assert!(near(period_ms(EffectPeriod::Ms { ms: 1.0 }, None), MIN_PERIOD_MS));
        assert!(near(period_ms(EffectPeriod::Ms { ms: f64::NAN }, None), MIN_PERIOD_MS));
        // 没有节拍：120 BPM → 每拍 500 ms
        assert!(near(period_ms(EffectPeriod::Beats { beats: 2.0 }, None), 1000.0));
        let t = Tempo { bpm: 60.0, offset_ms: 0.0, beats_per_bar: 4 };
        assert!(near(period_ms(EffectPeriod::Beats { beats: 2.0 }, Some(t)), 2000.0));
        let bad = Tempo { bpm: 0.0, offset_ms: 0.0, beats_per_bar: 4 };
        assert!(near(period_ms(EffectPeriod::Beats { beats: 1.0 }, Some(bad)), 500.0));
    }

    #[test]
    fn 哈希确定且分布大致均匀() {
        assert_eq!(hash32(7, 3, 9), hash32(7, 3, 9));
        assert_ne!(hash32(7, 3, 9), hash32(8, 3, 9));
        assert_ne!(hash32(7, 3, 9), hash32(7, 4, 9));
        let hits = (0..10_000u32).filter(|&k| f64::from(hash32(1, 0, k)) / 4_294_967_296.0 < 0.3).count();
        assert!((2700..3300).contains(&hits), "命中 {hits}");
    }

    #[test]
    fn 呼吸_三角平滑_半周期最亮() {
        let c = cue(EffectId::Breathe, vec![RED], 1000.0, 0.0);
        assert!(near(sample(&c, None, 0, 0, 1).modulation, 0.0));
        assert!(near(sample(&c, None, 250, 0, 1).modulation, 0.5));
        assert!(near(sample(&c, None, 500, 0, 1).modulation, 1.0));
        assert!(near(sample(&c, None, 1000, 0, 1).modulation, 0.0));
        assert_eq!(sample(&c, None, 500, 0, 1).rgb, [1.0, 0.0, 0.0]);
    }

    #[test]
    fn 彩虹_相位沿灯具均匀分布_反向时顺序颠倒() {
        let mut c = cue(EffectId::Rainbow, vec![RED], 1000.0, 1.0);
        let hues: Vec<[f64; 3]> = (0..4).map(|i| sample(&c, None, 0, i, 4).rgb).collect();
        assert_eq!(hues[0], [1.0, 0.0, 0.0]);
        assert_eq!(hues[1], [0.5, 1.0, 0.0]);
        assert_eq!(hues[2], [0.0, 1.0, 1.0]);
        assert_eq!(hues[3], [0.5, 0.0, 1.0]);
        c.direction = -1;
        assert_eq!(sample(&c, None, 0, 0, 4).rgb, hues[3]);
        assert_eq!(sample(&c, None, 0, 3, 4).rgb, hues[0]);
    }

    #[test]
    fn 追逐_亮点沿灯具环形移动() {
        let c = cue(EffectId::Chase, vec![RED], 4000.0, 0.0);
        let at = |t: i64| -> Vec<f64> { (0..4).map(|i| sample(&c, None, t, i, 4).modulation).collect() };
        assert_eq!(at(1000), vec![0.0, 1.0, 0.0, 0.0]);
        assert_eq!(at(1500), vec![0.0, 0.5, 0.5, 0.0]);
        // 环形：头部在 3.5 时，灯具 0 与灯具 3 各得一半
        assert_eq!(at(3500), vec![0.5, 0.0, 0.0, 0.5]);
    }

    #[test]
    fn 擦除_从头到尾逐个点亮_第二色作底色() {
        let one = cue(EffectId::Wipe, vec![RED], 4000.0, 0.0);
        let lit = |c: &EffectCue| -> Vec<f64> { (0..4).map(|i| sample(c, None, 2400, i, 4).modulation).collect() };
        assert_eq!(lit(&one), vec![1.0, 1.0, 0.0, 0.0]);
        let two = cue(EffectId::Wipe, vec![RED, BLUE], 4000.0, 0.0);
        assert_eq!(sample(&two, None, 2400, 2, 4).rgb, [0.0, 0.0, 1.0]);
        assert_eq!(sample(&two, None, 2400, 2, 4).modulation, 1.0);
    }

    #[test]
    fn 渐变_颜色首尾相接循环() {
        let c = cue(EffectId::Gradient, vec![RED, BLUE], 2000.0, 1.0);
        assert_eq!(sample(&c, None, 0, 0, 2).rgb, [1.0, 0.0, 0.0]);
        assert_eq!(sample(&c, None, 0, 1, 2).rgb, [0.0, 0.0, 1.0]);
        let mid = sample(&c, None, 500, 0, 2).rgb;
        assert!(near(mid[0], 0.5) && near(mid[2], 0.5));
        let wrap = sample(&c, None, 500, 1, 2).rgb;
        assert!(near(wrap[0], 0.5) && near(wrap[2], 0.5), "蓝 → 红 的回绕段");
    }

    #[test]
    fn 脉冲_瞬间最亮_三次方衰减() {
        let c = cue(EffectId::Pulse, vec![RED], 1000.0, 0.0);
        assert!(near(sample(&c, None, 0, 0, 1).modulation, 1.0));
        assert!(near(sample(&c, None, 250, 0, 1).modulation, 0.421_875));
        assert!(near(sample(&c, None, 500, 0, 1).modulation, 0.125));
    }

    #[test]
    fn 闪烁_同种子同结果_亮时随时间衰减() {
        let c = cue(EffectId::Sparkle, vec![RED, BLUE], 200.0, 0.0);
        let again = sample(&c, None, 1234, 2, 5);
        assert_eq!(sample(&c, None, 1234, 2, 5), again);
        let mut other = c.clone();
        other.seed = 8;
        let differs = (0..50).any(|t| sample(&c, None, t * 200, 1, 5) != sample(&other, None, t * 200, 1, 5));
        assert!(differs, "换种子应改变图案");
        // 找一个亮的步，检查衰减
        let lit_step = (0..200).find(|&k| sample(&c, None, k * 200, 0, 1).modulation > 0.0).unwrap();
        let t0 = lit_step * 200;
        let m0 = sample(&c, None, t0, 0, 1).modulation;
        let m1 = sample(&c, None, t0 + 100, 0, 1).modulation;
        assert!(near(m0, 1.0) && near(m1, 0.5));
    }

    #[test]
    fn 频闪_占空比一半() {
        let c = cue(EffectId::Strobe, vec![RED], 200.0, 0.0);
        assert!(near(sample(&c, None, 50, 0, 1).modulation, 1.0));
        assert!(near(sample(&c, None, 150, 0, 1).modulation, 0.0));
        assert!(near(sample(&c, None, 200, 0, 1).modulation, 1.0));
    }

    #[test]
    fn 颜色为空时退回白色_序号越界被夹取() {
        let c = cue(EffectId::Pulse, vec![], 1000.0, 0.0);
        assert_eq!(sample(&c, None, 0, 99, 3).rgb, [1.0, 1.0, 1.0]);
        let one = cue(EffectId::Breathe, vec![RED], 1000.0, 0.5);
        assert!(near(sample(&one, None, 100, 0, 0).modulation, sample(&one, None, 100, 0, 1).modulation));
    }
}
