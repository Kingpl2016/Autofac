//! 属性分层的外观（[`Look`]）、可随时间变化的参数（固定值 / 关键帧 / 数值曲线）与多灯分布（[`Spread`]）。
//!
//! 与前端 `project.ts` 的同名类型逐字段对应（JSON 为 camelCase）。本模块只负责“在片段内某个时刻、
//! 第几台灯具上，各层的取值是多少”；层之间的合成（HTP / LTP）与混色在 [`crate::eval`] 里完成。
//!
//! 取值约定：
//!
//! - 强度：0~100（%）；
//! - 颜色：[`ColorValue`]（RGB 意图 + 白光策略 / 色温 / 按发光体直给）；
//! - 其它属性：0~1 的 DMX 分数（例如 Pan 0.5 为居中）。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::effects::{hash32, period_ms};
use crate::envelope::apply_gamma;
use crate::fixture::ChannelFunction;
use crate::mix::{kelvin_display, ColorRequest, WhiteStrategy, EMITTERS};
use crate::project::{EffectPeriod, Tempo};

/// 相邻关键帧之间的插值方式。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Curve {
    /// 线性。
    #[default]
    Linear,
    /// 保持（到下一帧时跳变）。
    Hold,
    /// 缓入（二次）。
    EaseIn,
    /// 缓出（二次）。
    EaseOut,
    /// 三次缓入缓出。
    EaseInOut,
    /// S 曲线（smoothstep）。
    SCurve,
}

impl Curve {
    /// 把线性进度映射到曲线上。
    ///
    /// # Arguments
    ///
    /// * `x` - 线性进度，超出 `0..=1` 时先被夹取。
    ///
    /// # Returns
    ///
    /// 曲线上的值 `0..=1`（`Hold` 在 `x < 1` 时为 0）。
    #[must_use]
    pub fn apply(self, x: f64) -> f64 {
        let x = if x.is_nan() { 0.0 } else { x.clamp(0.0, 1.0) };
        match self {
            Self::Linear => x,
            Self::Hold => {
                if x >= 1.0 {
                    1.0
                } else {
                    0.0
                }
            }
            Self::EaseIn => x * x,
            Self::EaseOut => 1.0 - (1.0 - x) * (1.0 - x),
            Self::EaseInOut => {
                if x < 0.5 {
                    4.0 * x * x * x
                } else {
                    let k = -2.0 * x + 2.0;
                    1.0 - k * k * k / 2.0
                }
            }
            Self::SCurve => x * x * (3.0 - 2.0 * x),
        }
    }
}

/// 一个关键帧（时间相对片段起点）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe<T> {
    /// 相对片段起点的时刻（毫秒）。
    pub t_ms: f64,
    /// 取值。
    pub value: T,
    /// 从本帧到下一帧的插值方式。
    #[serde(default)]
    pub curve: Curve,
}

/// 数值曲线的形状。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WaveShape {
    /// 正弦（从 `from` 起，半周期到 `to`）。
    Sine,
    /// 三角波。
    Triangle,
    /// 锯齿波（`from` 线性升到 `to` 后跳回）。
    Saw,
    /// 方波（占空比内为 `to`）。
    Square,
    /// 斜坡（整个片段从 `from` 到 `to`，不重复）。
    Ramp,
    /// 每个周期一个确定性随机值。
    Random,
    /// 平滑噪声：相邻周期的随机值之间插值（烛光、火焰）。
    Noise,
    /// 自定义步进：一个周期均分成 [`ValueCurve::steps`] 段，每段一个值。
    Steps,
}

/// 周期的相位起点。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CurveSync {
    /// 从片段（或这台灯延迟后的）起点算起。
    #[default]
    Clip,
    /// 按节拍网格对齐（从工程第一拍算起），片段起点不在拍上也合拍。
    Beat,
}

/// 数值曲线。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueCurve {
    /// 形状。
    pub shape: WaveShape,
    /// 起始值。
    pub from: f64,
    /// 目标值。
    pub to: f64,
    /// 片段内的循环次数（没有 [`ValueCurve::period`] 时使用）。
    #[serde(default = "one")]
    pub cycles: f64,
    /// 起始相位 0~1。
    #[serde(default)]
    pub phase: f64,
    /// 方波占空比 0~1。
    #[serde(default)]
    pub duty: Option<f64>,
    /// 按时间计的周期（毫秒或拍）；给出时忽略 `cycles`，周期与片段长度无关。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<EffectPeriod>,
    /// 相位起点；省略为 [`CurveSync::Clip`]。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync: Option<CurveSync>,
    /// 过渡占周期（步进波形为每一步）的比例 0~1：在这段时间里走完波形，余下时间保持；省略为 1。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<f64>,
    /// 过渡的缓动；省略时按形状本身（步进为保持，噪声为 S 曲线）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ease: Option<Curve>,
    /// 步进波形每一步的值（0~1，乘到 `from`→`to` 区间上）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<f64>,
    /// 随机 / 噪声的种子：给出时每台灯的随机序列各不相同；省略时所有灯共用同一序列（旧行为）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u32>,
}

impl ValueCurve {
    /// 只有形状、起止值与循环次数的曲线（其余字段为默认）。
    ///
    /// # Arguments
    ///
    /// * `shape` - 形状。
    /// * `from` - 起始值。
    /// * `to` - 目标值。
    /// * `cycles` - 片段内的循环次数。
    ///
    /// # Returns
    ///
    /// 曲线。
    #[must_use]
    pub fn basic(shape: WaveShape, from: f64, to: f64, cycles: f64) -> Self {
        Self {
            shape,
            from,
            to,
            cycles,
            phase: 0.0,
            duty: None,
            period: None,
            sync: None,
            transition: None,
            ease: None,
            steps: Vec::new(),
            seed: None,
        }
    }
}

fn one() -> f64 {
    1.0
}

/// 一次取值的上下文：片段内时刻、片段长度、额外相位，以及按时间计周期、节拍对齐、
/// 每台灯随机序列需要的信息。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SampleCtx {
    /// 相对片段（这台灯延迟后的）起点的时刻（毫秒）。
    pub u_ms: f64,
    /// 片段时长（毫秒）。
    pub len_ms: f64,
    /// 额外相位（周期的分数，可为任意实数）：多灯分布错开的相位。
    pub phase_offset: f64,
    /// 节目时间（毫秒）：按节拍对齐时使用。
    pub abs_ms: f64,
    /// 工程节拍；按拍计的周期没有节拍时按 [`crate::effects::FALLBACK_BPM`]。
    pub tempo: Option<Tempo>,
    /// 成员在分布里的序号：带种子的随机 / 噪声按它区分每台灯。
    pub index: u32,
}

impl SampleCtx {
    /// 只知道片段内时刻与长度时的上下文（节目时间取 `u_ms`，没有节拍，序号 0）。
    ///
    /// # Arguments
    ///
    /// * `u_ms` - 相对片段起点的时刻（毫秒）。
    /// * `len_ms` - 片段时长（毫秒）。
    ///
    /// # Returns
    ///
    /// 上下文。
    #[must_use]
    pub fn clip(u_ms: f64, len_ms: f64) -> Self {
        Self { u_ms, len_ms, phase_offset: 0.0, abs_ms: u_ms, tempo: None, index: 0 }
    }
}

/// 周期计时（数值曲线与颜色序列共用）。
#[derive(Debug, Clone, Copy)]
struct Timing {
    cycles: f64,
    period: Option<EffectPeriod>,
    sync: CurveSync,
    phase: f64,
}

impl Timing {
    /// 周期坐标 `x`（整数部分是第几个周期，小数部分是周期内的进度）与片段进度 `0..=1`。
    fn position(&self, ctx: &SampleCtx) -> (f64, f64) {
        let len = ctx.len_ms.max(1.0);
        let progress = (ctx.u_ms / len).clamp(0.0, 1.0);
        let base = if let Some(p) = self.period {
            let ms = period_ms(p, ctx.tempo);
            match self.sync {
                CurveSync::Clip => ctx.u_ms.max(0.0) / ms,
                CurveSync::Beat => {
                    let offset = ctx.tempo.map_or(0.0, |t| if t.offset_ms.is_finite() { t.offset_ms } else { 0.0 });
                    (ctx.abs_ms - offset) / ms
                }
            }
        } else {
            let cycles = if self.cycles.is_finite() { self.cycles.clamp(1.0, 1000.0) } else { 1.0 };
            progress * cycles
        };
        let offset = if ctx.phase_offset.is_finite() { ctx.phase_offset } else { 0.0 };
        let base = if base.is_finite() { base } else { 0.0 };
        // 相位偏移折回 0~1；节拍对齐时 base 可能为负（第一拍之前），整数部分只用作随机序号
        (base + self.phase.clamp(0.0, 1.0) + offset.rem_euclid(1.0), progress)
    }
}

/// 过渡占比内的进度：`f` 走完 `transition` 后保持 1。
fn transit(f: f64, transition: Option<f64>) -> f64 {
    let t = transition.map_or(1.0, |t| if t.is_finite() { t.clamp(0.0, 1.0) } else { 1.0 });
    if t <= 0.0 {
        1.0
    } else {
        (f / t).min(1.0)
    }
}

/// 周期序号（非负）：随机 / 噪声的取值键。
fn step_of(x: f64) -> u32 {
    let s = x.floor();
    if s <= 0.0 {
        0
    } else {
        s as u32
    }
}

/// 一个确定性随机值 `0..1`。
fn random_at(seed: Option<u32>, index: u32, step: u32) -> f64 {
    let h = match seed {
        Some(s) => hash32(s, index, step),
        None => hash32(0x5EED, 0, step),
    };
    f64::from(h) / 4_294_967_296.0
}

/// 数值参数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NumParam {
    /// 固定值。
    Value {
        /// 值。
        value: f64,
    },
    /// 关键帧（按时间升序）。
    Keys {
        /// 关键帧。
        keys: Vec<Keyframe<f64>>,
    },
    /// 数值曲线。
    Curve {
        /// 曲线（装箱：曲线字段较多，避免撑大每个参数）。
        curve: Box<ValueCurve>,
    },
}

impl NumParam {
    /// 在片段内时刻 `u_ms` 取值。
    ///
    /// # Arguments
    ///
    /// * `u_ms` - 相对片段起点的时刻（毫秒）。
    /// * `len_ms` - 片段时长（毫秒），数值曲线按它换算周期。
    ///
    /// # Returns
    ///
    /// 参数值；关键帧为空时为 0。
    #[must_use]
    pub fn sample(&self, u_ms: f64, len_ms: f64) -> f64 {
        self.sample_phased(u_ms, len_ms, 0.0)
    }

    /// 带相位偏移的取值：只影响数值曲线（追逐 / 波浪特效里每台灯错开的相位），固定值与关键帧不受影响。
    ///
    /// # Arguments
    ///
    /// * `u_ms` - 相对片段起点的时刻（毫秒）。
    /// * `len_ms` - 片段时长（毫秒）。
    /// * `phase_offset` - 额外相位（周期的分数，可为任意实数）。
    ///
    /// # Returns
    ///
    /// 参数值；关键帧为空时为 0。
    #[must_use]
    pub fn sample_phased(&self, u_ms: f64, len_ms: f64, phase_offset: f64) -> f64 {
        self.sample_at(&SampleCtx { phase_offset, ..SampleCtx::clip(u_ms, len_ms) })
    }

    /// 按完整上下文取值（按时间计的周期、节拍对齐、每台灯的随机序列）。
    ///
    /// # Arguments
    ///
    /// * `ctx` - 取值上下文。
    ///
    /// # Returns
    ///
    /// 参数值；关键帧为空时为 0。
    #[must_use]
    pub fn sample_at(&self, ctx: &SampleCtx) -> f64 {
        match self {
            Self::Value { value } => *value,
            Self::Keys { keys } => sample_keys(keys, ctx.u_ms, |a, b, t| a + (b - a) * t).unwrap_or(0.0),
            Self::Curve { curve } => sample_curve(curve, ctx),
        }
    }
}

#[expect(clippy::many_single_char_names, reason = "波形数学记法 x/f/g/s 为习惯命名")]
fn sample_curve(c: &ValueCurve, ctx: &SampleCtx) -> f64 {
    let timing = Timing { cycles: c.cycles, period: c.period, sync: c.sync.unwrap_or_default(), phase: c.phase };
    let (x, progress) = timing.position(ctx);
    let f = x - x.floor();
    // 没有过渡与缓动时沿用原来的公式（结果逐位不变）
    let plain = c.transition.is_none() && c.ease.is_none();
    let g = {
        let raw = transit(f, c.transition);
        c.ease.map_or(raw, |e| e.apply(raw))
    };
    let s = match c.shape {
        WaveShape::Sine if plain => 0.5 - 0.5 * (std::f64::consts::TAU * x).cos(),
        WaveShape::Sine => 0.5 - 0.5 * (std::f64::consts::TAU * g).cos(),
        WaveShape::Triangle => 1.0 - (2.0 * g - 1.0).abs(),
        WaveShape::Saw => g,
        WaveShape::Square => {
            if g < c.duty.unwrap_or(0.5).clamp(0.0, 1.0) {
                1.0
            } else {
                0.0
            }
        }
        WaveShape::Ramp => c.ease.map_or(progress, |e| e.apply(progress)),
        WaveShape::Random => random_at(c.seed, ctx.index, step_of(x)),
        WaveShape::Noise => {
            let step = step_of(x);
            let a = random_at(c.seed, ctx.index, step);
            let b = random_at(c.seed, ctx.index, step.saturating_add(1));
            a + (b - a) * c.ease.unwrap_or(Curve::SCurve).apply(transit(f, c.transition))
        }
        WaveShape::Steps => steps_value(&c.steps, f, c.transition, c.ease),
    };
    c.from + (c.to - c.from) * s
}

/// 步进波形在周期内进度 `f` 处的值：没有缓动时保持每一步的值，有缓动时在过渡占比内滑向下一步。
#[expect(clippy::many_single_char_names, reason = "插值数学记法 n/k/f/t 为习惯命名")]
fn steps_value(steps: &[f64], f: f64, transition: Option<f64>, ease: Option<Curve>) -> f64 {
    let n = steps.len();
    if n == 0 {
        return 0.0;
    }
    let pos = f.clamp(0.0, 1.0) * n as f64;
    let k = (pos.floor() as usize).min(n - 1);
    let at = |i: usize| {
        let v = steps[i % n];
        if v.is_finite() {
            v.clamp(0.0, 1.0)
        } else {
            0.0
        }
    };
    match ease {
        None => at(k),
        Some(e) => {
            let t = e.apply(transit(pos - k as f64, transition));
            at(k) + (at(k + 1) - at(k)) * t
        }
    }
}

/// 关键帧插值：第一帧之前取第一帧，最后一帧之后取最后一帧。
fn sample_keys<T: Clone>(keys: &[Keyframe<T>], u_ms: f64, lerp: impl Fn(&T, &T, f64) -> T) -> Option<T> {
    let first = keys.first()?;
    if u_ms <= first.t_ms {
        return Some(first.value.clone());
    }
    let upper = keys.partition_point(|k| k.t_ms <= u_ms);
    let Some(next) = keys.get(upper) else {
        return keys.last().map(|k| k.value.clone());
    };
    let prev = &keys[upper - 1];
    let span = (next.t_ms - prev.t_ms).max(1e-9);
    let t = prev.curve.apply((u_ms - prev.t_ms) / span);
    Some(lerp(&prev.value, &next.value, t))
}

/// 颜色值（意图色）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ColorValue {
    /// RGB 意图。
    Rgb {
        /// sRGB 0~255。
        rgb: [u8; 3],
        /// 白光策略；省略为保色。
        #[serde(default)]
        white: Option<WhiteStrategy>,
    },
    /// 色温（K）。
    Kelvin {
        /// 色温。
        kelvin: f64,
    },
    /// 按发光体直接给定（键为发光体功能名，如 `red`、`warmWhite`；值 0~1）。
    Manual {
        /// 各发光体的值。
        values: BTreeMap<ChannelFunction, f64>,
    },
}

/// 颜色参数（固定值或关键帧）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ColorParam {
    /// 固定颜色。
    Value {
        /// 颜色。
        value: ColorValue,
    },
    /// 关键帧。
    Keys {
        /// 关键帧。
        keys: Vec<Keyframe<ColorValue>>,
    },
    /// 颜色序列：每个周期依次走过一组颜色（受多灯相位分布影响）。
    Cycle {
        /// 序列（装箱，理由同 [`NumParam::Curve`]）。
        cycle: Box<ColorCycle>,
    },
}

/// 一组颜色之间的过渡方式。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColorBlend {
    /// 平滑插值（RGB 分量线性，色温按 mired）。
    #[default]
    Smooth,
    /// 跳变。
    Step,
    /// 按色相插值（沿色轮最短的方向），彩虹不经过灰色。
    Hue,
}

/// 颜色序列。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorCycle {
    /// 颜色（首尾相接）。
    pub colors: Vec<ColorValue>,
    /// 相邻颜色之间的过渡方式。
    #[serde(default)]
    pub blend: ColorBlend,
    /// 片段内的循环次数（没有 `period` 时使用）。
    #[serde(default = "one")]
    pub cycles: f64,
    /// 按时间计的周期；给出时忽略 `cycles`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<EffectPeriod>,
    /// 相位起点。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync: Option<CurveSync>,
    /// 起始相位 0~1。
    #[serde(default)]
    pub phase: f64,
    /// 每种颜色里过渡所占的比例 0~1（余下时间停在下一种颜色上）；省略为 1。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<f64>,
    /// 过渡的缓动；省略为线性。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ease: Option<Curve>,
}

impl ColorCycle {
    /// 按上下文取颜色。
    ///
    /// # Arguments
    ///
    /// * `ctx` - 取值上下文（相位偏移来自多灯分布）。
    ///
    /// # Returns
    ///
    /// 颜色状态；没有颜色时为 `None`。
    #[must_use]
    #[expect(clippy::many_single_char_names, reason = "插值数学记法 n/k/a/b/t 为习惯命名")]
    pub fn sample_at(&self, ctx: &SampleCtx) -> Option<ColorState> {
        let n = self.colors.len();
        if n == 0 {
            return None;
        }
        let timing = Timing { cycles: self.cycles, period: self.period, sync: self.sync.unwrap_or_default(), phase: self.phase };
        let (x, _) = timing.position(ctx);
        let pos = (x - x.floor()) * n as f64;
        let k = (pos.floor() as usize).min(n - 1);
        let a = ColorState::of(&self.colors[k]);
        if self.blend == ColorBlend::Step || n == 1 {
            return Some(a);
        }
        let b = ColorState::of(&self.colors[(k + 1) % n]);
        let t = self.ease.unwrap_or_default().apply(transit(pos - k as f64, self.transition));
        Some(blend_states(&a, &b, t, self.blend))
    }
}

/// 两个颜色按过渡方式插值。
#[expect(clippy::many_single_char_names, reason = "颜色插值记法 a/b/t/h/s/v 为习惯命名")]
fn blend_states(a: &ColorState, b: &ColorState, t: f64, blend: ColorBlend) -> ColorState {
    match (blend, a, b) {
        (ColorBlend::Step, _, _) => {
            if t < 1.0 {
                *a
            } else {
                *b
            }
        }
        (ColorBlend::Hue, ColorState::Rgb(x, _), ColorState::Rgb(y, w)) => {
            let (h0, s0, v0) = rgb_to_hsv(*x);
            let (h1, s1, v1) = rgb_to_hsv(*y);
            // 沿色轮最短方向；一端是灰（饱和度为 0）时色相跟随另一端
            let (h0, h1) = if s0 < 1e-9 { (h1, h1) } else if s1 < 1e-9 { (h0, h0) } else { (h0, h1) };
            let mut d = h1 - h0;
            if d > 0.5 {
                d -= 1.0;
            } else if d < -0.5 {
                d += 1.0;
            }
            let t = t.clamp(0.0, 1.0);
            ColorState::Rgb(hsv_to_rgb((h0 + d * t).rem_euclid(1.0), s0 + (s1 - s0) * t, v0 + (v1 - v0) * t), *w)
        }
        _ => ColorState::lerp(a, b, t),
    }
}

/// 求值过程中的颜色状态（便于插值与 LTP 交叉淡化）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ColorState {
    /// sRGB 编码的 0~1 分量（插值在编码空间进行，观感更均匀）与白光策略。
    Rgb([f64; 3], WhiteStrategy),
    /// 色温（K）。
    Kelvin(f64),
    /// 按发光体直给（下标同 [`crate::mix`] 的发光体分量）。
    Manual([f64; EMITTERS]),
}

impl ColorState {
    /// 由颜色值得到状态。
    ///
    /// # Arguments
    ///
    /// * `v` - 颜色值。
    ///
    /// # Returns
    ///
    /// 颜色状态。
    #[must_use]
    pub fn of(v: &ColorValue) -> Self {
        match v {
            ColorValue::Rgb { rgb, white } => {
                Self::Rgb(rgb.map(|c| f64::from(c) / 255.0), white.unwrap_or_default())
            }
            ColorValue::Kelvin { kelvin } => Self::Kelvin(*kelvin),
            ColorValue::Manual { values } => {
                let mut out = [0.0; EMITTERS];
                for (f, v) in values {
                    if let Some(i) = crate::mix::emitter_index(*f) {
                        out[i] = v.clamp(0.0, 1.0);
                    }
                }
                Self::Manual(out)
            }
        }
    }

    /// 两个颜色状态之间插值：同类线性插值（色温按 mired），RGB 与色温之间按 RGB 插值，
    /// 与手动值之间在中点切换。
    ///
    /// # Arguments
    ///
    /// * `a` - 起点。
    /// * `b` - 终点。
    /// * `t` - 进度 `0..=1`。
    ///
    /// # Returns
    ///
    /// 插值结果。
    #[must_use]
    #[expect(clippy::many_single_char_names, reason = "颜色分量 a/b/t 为插值习惯命名")]
    pub fn lerp(a: &Self, b: &Self, t: f64) -> Self {
        let t = t.clamp(0.0, 1.0);
        let mix3 = |x: [f64; 3], y: [f64; 3]| [0, 1, 2].map(|i| x[i] + (y[i] - x[i]) * t);
        match (a, b) {
            (Self::Rgb(x, _), Self::Rgb(y, w)) => Self::Rgb(mix3(*x, *y), *w),
            (Self::Kelvin(x), Self::Kelvin(y)) => {
                let (mx, my) = (1e6 / x.max(1.0), 1e6 / y.max(1.0));
                Self::Kelvin(1e6 / (mx + (my - mx) * t))
            }
            (Self::Manual(x), Self::Manual(y)) => {
                let mut out = [0.0; EMITTERS];
                for i in 0..EMITTERS {
                    out[i] = x[i] + (y[i] - x[i]) * t;
                }
                Self::Manual(out)
            }
            (Self::Rgb(x, _), Self::Kelvin(k)) => Self::Rgb(mix3(*x, kelvin_srgb(*k)), WhiteStrategy::Preserve),
            (Self::Kelvin(k), Self::Rgb(y, w)) => Self::Rgb(mix3(kelvin_srgb(*k), *y), *w),
            _ => {
                if t < 0.5 {
                    *a
                } else {
                    *b
                }
            }
        }
    }

    /// 转成混色请求（RGB 按工程 Gamma 解码到线性光）。
    ///
    /// # Arguments
    ///
    /// * `gamma` - 已规整的工程 Gamma。
    ///
    /// # Returns
    ///
    /// 混色请求。
    #[must_use]
    pub fn request(&self, gamma: f64) -> ColorRequest {
        match *self {
            Self::Rgb(rgb, white) => ColorRequest::Rgb { rgb: rgb.map(|v| apply_gamma(v, gamma)), white },
            Self::Kelvin(k) => ColorRequest::Kelvin(k),
            Self::Manual(v) => ColorRequest::Manual(v),
        }
    }

    /// 色相旋转（只作用于 RGB；色温与手动值不变）。
    ///
    /// # Arguments
    ///
    /// * `degrees` - 旋转角度（度）。
    ///
    /// # Returns
    ///
    /// 旋转后的颜色。
    #[must_use]
    pub fn rotate_hue(&self, degrees: f64) -> Self {
        match *self {
            Self::Rgb(rgb, w) if degrees.abs() > 1e-9 => {
                let (h, s, v) = rgb_to_hsv(rgb);
                Self::Rgb(hsv_to_rgb((h + degrees / 360.0).rem_euclid(1.0), s, v), w)
            }
            _ => *self,
        }
    }
}

/// 色温的显示色（与 RGB 交叉淡化时用，之后与 RGB 一起按工程 Gamma 解码）。
fn kelvin_srgb(k: f64) -> [f64; 3] {
    kelvin_display(k)
}

#[expect(clippy::many_single_char_names, reason = "r/g/b/h/s/v 为颜色空间习惯命名")]
fn rgb_to_hsv([r, g, b]: [f64; 3]) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let h = if d < 1e-12 {
        0.0
    } else if (max - r).abs() < 1e-12 {
        ((g - b) / d).rem_euclid(6.0) / 6.0
    } else if (max - g).abs() < 1e-12 {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    let s = if max > 0.0 { d / max } else { 0.0 };
    (h, s, max)
}

#[expect(clippy::many_single_char_names, reason = "h/s/v 为颜色空间习惯命名")]
fn hsv_to_rgb(h: f64, s: f64, v: f64) -> [f64; 3] {
    let h6 = h.rem_euclid(1.0) * 6.0;
    let i = h6.floor();
    let f = h6 - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - s * f), v * (1.0 - s * (1.0 - f)));
    match i as u8 {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

impl ColorParam {
    /// 在片段内时刻 `u_ms` 取颜色。
    ///
    /// # Arguments
    ///
    /// * `u_ms` - 相对片段起点的时刻（毫秒）。
    ///
    /// # Returns
    ///
    /// 颜色状态；关键帧为空时为 `None`。
    #[must_use]
    pub fn sample(&self, u_ms: f64) -> Option<ColorState> {
        self.sample_at(&SampleCtx::clip(u_ms, u_ms.max(1.0)))
    }

    /// 按完整上下文取颜色（颜色序列需要周期、节拍与相位偏移）。
    ///
    /// # Arguments
    ///
    /// * `ctx` - 取值上下文。
    ///
    /// # Returns
    ///
    /// 颜色状态；关键帧或序列为空时为 `None`。
    #[must_use]
    pub fn sample_at(&self, ctx: &SampleCtx) -> Option<ColorState> {
        match self {
            Self::Value { value } => Some(ColorState::of(value)),
            Self::Keys { keys } => {
                let states: Vec<Keyframe<ColorState>> = keys
                    .iter()
                    .map(|k| Keyframe { t_ms: k.t_ms, value: ColorState::of(&k.value), curve: k.curve })
                    .collect();
                sample_keys(&states, ctx.u_ms, ColorState::lerp)
            }
            Self::Cycle { cycle } => cycle.sample_at(ctx),
        }
    }
}

/// 属性分层的外观：只写出现的层。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    /// 强度 0~100（%）。
    #[serde(default)]
    pub intensity: Option<NumParam>,
    /// 颜色。
    #[serde(default)]
    pub color: Option<ColorParam>,
    /// 其它属性（键为通道功能名，值为 0~1 DMX 分数）。
    #[serde(default)]
    pub attrs: BTreeMap<ChannelFunction, NumParam>,
    /// 引用的预设。
    #[serde(default)]
    pub preset_id: Option<String>,
}

impl Look {
    /// 叠在底层外观之上：本外观显式写出的层覆盖底层的同名层。
    ///
    /// # Arguments
    ///
    /// * `base` - 底层（通常是预设）。
    ///
    /// # Returns
    ///
    /// 合并后的外观（不含 `preset_id`）。
    #[must_use]
    pub fn over(&self, base: &Self) -> Self {
        let mut attrs = base.attrs.clone();
        attrs.extend(self.attrs.iter().map(|(k, v)| (*k, v.clone())));
        Self {
            intensity: self.intensity.clone().or_else(|| base.intensity.clone()),
            color: self.color.clone().or_else(|| base.color.clone()),
            attrs,
            preset_id: None,
        }
    }
}

/// 分布里成员顺序的来源。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpreadOrder {
    /// 轨道成员顺序（分组顺序）。
    #[default]
    Members,
    /// 反向。
    Reverse,
    /// 按舞台横坐标从左到右。
    StageX,
    /// 按舞台纵深从前到后。
    StageY,
}

/// 分布的起止值。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadRange {
    /// 第一个成员的值。
    pub from: f64,
    /// 最后一个成员的值。
    pub to: f64,
}

/// 时间级联。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadDelay {
    /// 第一个成员的延迟（毫秒）。
    pub from_ms: f64,
    /// 最后一个成员的延迟（毫秒）。
    pub to_ms: f64,
}

/// 多灯分布。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spread {
    /// 成员顺序。
    #[serde(default)]
    pub order: Option<SpreadOrder>,
    /// 分翼数：0 / 1 为不分翼，2 为左右对称。
    #[serde(default)]
    pub wings: Option<u32>,
    /// 各量的起止值（键为 `intensity`、`hue`、`phase`（数值曲线的相位偏移，周期的分数）或属性功能名）。
    #[serde(default)]
    pub values: BTreeMap<String, SpreadRange>,
    /// 时间级联。
    #[serde(default)]
    pub delay: Option<SpreadDelay>,
    /// 成块：连续 n 台视为同一个位置（取同样的值）；0 / 1 为不成块。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<u32>,
    /// 分组：每 n 个位置重复一遍分布（组内展开、各组相同）；0 / 1 为不分组。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups: Option<u32>,
    /// 打乱顺序的种子：按种子确定性地打乱成员顺序；省略为不打乱。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shuffle: Option<u32>,
    /// 静态颜色分布：沿成员铺开一组颜色（覆盖外观的颜色层）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colors: Option<SpreadColors>,
}

/// 沿成员铺开的一组颜色。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadColors {
    /// 颜色（第一个成员到最后一个成员）。
    pub colors: Vec<ColorValue>,
    /// 过渡方式：平滑 / 按色相为渐变，跳变为均分成段。
    #[serde(default)]
    pub blend: ColorBlend,
}

impl SpreadColors {
    /// 位置分数 `f` 处的颜色。
    ///
    /// # Arguments
    ///
    /// * `f` - 位置分数 `0..=1`（见 [`Spread::fraction`]）。
    ///
    /// # Returns
    ///
    /// 颜色状态；没有颜色时为 `None`。
    #[must_use]
    #[expect(clippy::many_single_char_names, reason = "插值数学记法 n/k/a/b/f 为习惯命名")]
    pub fn at(&self, f: f64) -> Option<ColorState> {
        let n = self.colors.len();
        if n == 0 {
            return None;
        }
        let f = if f.is_finite() { f.clamp(0.0, 1.0) } else { 0.0 };
        if n == 1 {
            return Some(ColorState::of(&self.colors[0]));
        }
        if self.blend == ColorBlend::Step {
            let k = ((f * n as f64).floor() as usize).min(n - 1);
            return Some(ColorState::of(&self.colors[k]));
        }
        let pos = f * (n - 1) as f64;
        let k = (pos.floor() as usize).min(n - 2);
        let a = ColorState::of(&self.colors[k]);
        let b = ColorState::of(&self.colors[k + 1]);
        Some(blend_states(&a, &b, pos - k as f64, self.blend))
    }
}

impl Spread {
    /// 成员在分布里的位置分数（0 为第一个，1 为最后一个），考虑分翼。
    ///
    /// 分翼把成员均分成若干段，每段内从 0 到 1；偶数段（第 2、4… 翼）镜像，
    /// 因此 2 翼时中间的成员取 1、两端取 0（中心向外对称）。
    ///
    /// # Arguments
    ///
    /// * `index` - 成员按分布顺序的下标。
    /// * `count` - 成员总数。
    ///
    /// # Returns
    ///
    /// 位置分数 `0..=1`；只有一个成员时为 0。
    #[must_use]
    pub fn fraction(&self, index: usize, count: usize) -> f64 {
        let (mut index, mut count) = (index, count);
        // 成块：连续 n 台合成一个位置
        if let Some(b) = self.blocks.filter(|b| *b > 1) {
            let b = b as usize;
            index /= b;
            count = count.div_ceil(b);
        }
        // 分组：每 n 个位置重复一遍
        if let Some(g) = self.groups.filter(|g| *g > 1) {
            let g = g as usize;
            if count > g {
                index %= g;
                count = g;
            }
        }
        if count <= 1 {
            return 0.0;
        }
        let wings = self.wings.unwrap_or(0).max(1) as usize;
        let size = count.div_ceil(wings).max(1);
        let wing = index / size;
        let pos = index % size;
        let span = if wing + 1 == wings { count - wing * size } else { size };
        let f = if span <= 1 { 0.0 } else { pos as f64 / (span - 1) as f64 };
        if wing % 2 == 1 { 1.0 - f } else { f }
    }

    /// 某个量在位置分数 `f` 处的值。
    ///
    /// # Arguments
    ///
    /// * `key` - `intensity`、`hue` 或属性功能名。
    /// * `f` - 位置分数（见 [`Spread::fraction`]）。
    ///
    /// # Returns
    ///
    /// 有该量的分布时返回插值结果，否则为 `None`。
    #[must_use]
    pub fn value(&self, key: &str, f: f64) -> Option<f64> {
        self.values.get(key).map(|r| r.from + (r.to - r.from) * f)
    }

    /// 位置分数 `f` 处的时间延迟（毫秒）。
    ///
    /// # Arguments
    ///
    /// * `f` - 位置分数。
    ///
    /// # Returns
    ///
    /// 延迟毫秒数（不小于 0）；没有级联时为 0。
    #[must_use]
    pub fn delay_ms(&self, f: f64) -> f64 {
        self.delay
            .map_or(0.0, |d| (d.from_ms + (d.to_ms - d.from_ms) * f).max(0.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn key(t: f64, v: f64, curve: Curve) -> Keyframe<f64> {
        Keyframe { t_ms: t, value: v, curve }
    }

    #[test]
    fn 关键帧插值_端点外保持() {
        let p = NumParam::Keys { keys: vec![key(100.0, 0.0, Curve::Linear), key(300.0, 1.0, Curve::Hold), key(500.0, 0.0, Curve::Linear)] };
        assert!(near(p.sample(0.0, 1000.0), 0.0));
        assert!(near(p.sample(200.0, 1000.0), 0.5));
        // 第二帧是保持：到第三帧之前一直是 1
        assert!(near(p.sample(450.0, 1000.0), 1.0));
        assert!(near(p.sample(900.0, 1000.0), 0.0));
        assert!(near(NumParam::Keys { keys: vec![] }.sample(5.0, 10.0), 0.0));
    }

    #[test]
    fn 数值曲线_形状与循环() {
        let c = |shape, cycles| NumParam::Curve {
            curve: Box::new(ValueCurve::basic(shape, 10.0, 20.0, cycles)),
        };
        assert!(near(c(WaveShape::Sine, 1.0).sample(0.0, 1000.0), 10.0));
        assert!(near(c(WaveShape::Sine, 1.0).sample(500.0, 1000.0), 20.0));
        assert!(near(c(WaveShape::Triangle, 2.0).sample(250.0, 1000.0), 20.0));
        assert!(near(c(WaveShape::Saw, 2.0).sample(250.0, 1000.0), 15.0));
        assert!(near(c(WaveShape::Square, 1.0).sample(400.0, 1000.0), 20.0));
        assert!(near(c(WaveShape::Square, 1.0).sample(600.0, 1000.0), 10.0));
        assert!(near(c(WaveShape::Ramp, 5.0).sample(250.0, 1000.0), 12.5));
        let r = c(WaveShape::Random, 4.0);
        assert!(near(r.sample(10.0, 1000.0), r.sample(200.0, 1000.0)), "同一周期内随机值不变");
    }

    fn curve(shape: WaveShape, edit: impl FnOnce(&mut ValueCurve)) -> NumParam {
        let mut c = ValueCurve::basic(shape, 0.0, 100.0, 1.0);
        edit(&mut c);
        NumParam::Curve { curve: Box::new(c) }
    }

    fn at(p: &NumParam, u_ms: f64) -> f64 {
        p.sample_at(&SampleCtx::clip(u_ms, 1000.0))
    }

    #[test]
    fn 按时间计周期_与片段长度无关_按拍跟随节拍() {
        let p = curve(WaveShape::Saw, |c| c.period = Some(EffectPeriod::Ms { ms: 400.0 }));
        // 片段 1000 ms、cycles 1 被忽略：每 400 ms 一个周期
        assert!(near(at(&p, 100.0), 25.0));
        assert!(near(at(&p, 500.0), 25.0));
        let beats = curve(WaveShape::Saw, |c| c.period = Some(EffectPeriod::Beats { beats: 1.0 }));
        let tempo = Some(Tempo { bpm: 60.0, offset_ms: 0.0, beats_per_bar: 4 });
        let ctx = SampleCtx { tempo, ..SampleCtx::clip(250.0, 10_000.0) };
        assert!(near(beats.sample_at(&ctx), 25.0));
        // 没有节拍：按 120 BPM（每拍 500 ms）
        assert!(near(beats.sample_at(&SampleCtx::clip(250.0, 10_000.0)), 50.0));
    }

    #[test]
    fn 节拍对齐_相位从第一拍算起() {
        let tempo = Some(Tempo { bpm: 60.0, offset_ms: 200.0, beats_per_bar: 4 });
        let clip = curve(WaveShape::Saw, |c| c.period = Some(EffectPeriod::Beats { beats: 1.0 }));
        let beat = curve(WaveShape::Saw, |c| {
            c.period = Some(EffectPeriod::Beats { beats: 1.0 });
            c.sync = Some(CurveSync::Beat);
        });
        // 片段从 1450 ms 开始，播放到 1700 ms：片段内 250 ms，距第一拍 1500 ms
        let ctx = SampleCtx { abs_ms: 1700.0, tempo, ..SampleCtx::clip(250.0, 4000.0) };
        assert!(near(clip.sample_at(&ctx), 25.0));
        assert!(near(beat.sample_at(&ctx), 50.0));
    }

    #[test]
    fn 过渡占比与缓动() {
        let tri = curve(WaveShape::Triangle, |c| c.transition = Some(0.5));
        assert!(near(at(&tri, 125.0), 50.0));
        assert!(near(at(&tri, 250.0), 100.0));
        // 过渡走完后保持在终点（三角波回到起点）
        assert!(near(at(&tri, 700.0), 0.0));
        let eased = curve(WaveShape::Saw, |c| c.ease = Some(Curve::EaseIn));
        assert!(near(at(&eased, 500.0), 25.0));
        let ramp = curve(WaveShape::Ramp, |c| c.ease = Some(Curve::EaseOut));
        assert!(near(at(&ramp, 500.0), 75.0));
    }

    #[test]
    fn 步进波形_保持或滑向下一步() {
        let hold = curve(WaveShape::Steps, |c| c.steps = vec![1.0, 0.0, 0.0, 1.0]);
        assert!(near(at(&hold, 100.0), 100.0));
        assert!(near(at(&hold, 300.0), 0.0));
        assert!(near(at(&hold, 800.0), 100.0));
        let slide = curve(WaveShape::Steps, |c| {
            c.steps = vec![1.0, 0.0, 0.0, 1.0];
            c.ease = Some(Curve::Linear);
            c.transition = Some(0.5);
        });
        // 第 3 步（0 → 1）：步内 20% → 过渡进度 40%
        assert!(near(at(&slide, 550.0), 40.0));
        assert!(near(at(&slide, 700.0), 100.0));
        assert!(near(at(&curve(WaveShape::Steps, |_| {}), 300.0), 0.0), "没有步时为起始值");
    }

    #[test]
    fn 随机与噪声_带种子时每台灯不同() {
        let shared = curve(WaveShape::Random, |c| c.cycles = 8.0);
        let seeded = curve(WaveShape::Random, |c| {
            c.cycles = 8.0;
            c.seed = Some(3);
        });
        let of = |p: &NumParam, index| p.sample_at(&SampleCtx { index, ..SampleCtx::clip(300.0, 1000.0) });
        assert!(near(of(&shared, 0), of(&shared, 1)), "没有种子：所有灯同一序列");
        assert!(!near(of(&seeded, 0), of(&seeded, 1)), "有种子：每台灯不同");
        let noise = curve(WaveShape::Noise, |c| {
            c.cycles = 4.0;
            c.seed = Some(9);
        });
        // 周期边界两侧连续
        assert!((at(&noise, 249.999) - at(&noise, 250.001)).abs() < 0.01);
        let v = at(&noise, 400.0);
        assert!((0.0..=100.0).contains(&v));
    }

    #[test]
    fn 颜色序列_平滑_跳变_按色相() {
        let red = ColorValue::Rgb { rgb: [255, 0, 0], white: None };
        let blue = ColorValue::Rgb { rgb: [0, 0, 255], white: None };
        let green = ColorValue::Rgb { rgb: [0, 255, 0], white: None };
        let cycle = |colors: Vec<ColorValue>, blend| ColorParam::Cycle {
            cycle: Box::new(ColorCycle {
                colors,
                blend,
                cycles: 1.0,
                period: None,
                sync: None,
                phase: 0.0,
                transition: None,
                ease: None,
            }),
        };
        let ctx = |u| SampleCtx::clip(u, 1000.0);
        let smooth = cycle(vec![red.clone(), blue.clone()], ColorBlend::Smooth);
        assert_eq!(smooth.sample_at(&ctx(250.0)), Some(ColorState::Rgb([0.5, 0.0, 0.5], WhiteStrategy::Preserve)));
        let step = cycle(vec![red.clone(), blue], ColorBlend::Step);
        assert_eq!(step.sample_at(&ctx(250.0)), Some(ColorState::of(&red)));
        let hue = cycle(vec![red.clone(), green], ColorBlend::Hue);
        let Some(ColorState::Rgb(y, _)) = hue.sample_at(&ctx(250.0)) else { panic!("应为 RGB") };
        assert!(near(y[0], 1.0) && near(y[1], 1.0) && near(y[2], 0.0), "红 → 绿的中点是黄：{y:?}");
        // 相位偏移半个周期：从第二种颜色开始
        let shifted = SampleCtx { phase_offset: 0.5, ..ctx(0.0) };
        assert_eq!(step.sample_at(&shifted), Some(ColorState::Rgb([0.0, 0.0, 1.0], WhiteStrategy::Preserve)));
        assert_eq!(cycle(vec![], ColorBlend::Smooth).sample_at(&ctx(0.0)), None);
        // 序列能从前端形态反序列化
        let json = r#"{"kind":"cycle","cycle":{"colors":[{"kind":"rgb","rgb":[255,0,0]},{"kind":"kelvin","kelvin":3200}],"blend":"step","period":{"kind":"beats","beats":2}}}"#;
        let parsed: ColorParam = serde_json::from_str(json).expect("颜色序列");
        assert!(matches!(parsed, ColorParam::Cycle { .. }));
    }

    #[test]
    fn 分布_成块_分组_静态颜色() {
        let blocks = Spread { blocks: Some(2), ..Spread::default() };
        let f: Vec<f64> = (0..6).map(|i| blocks.fraction(i, 6)).collect();
        assert_eq!(f, vec![0.0, 0.0, 0.5, 0.5, 1.0, 1.0]);
        let groups = Spread { groups: Some(3), ..Spread::default() };
        let f: Vec<f64> = (0..6).map(|i| groups.fraction(i, 6)).collect();
        assert_eq!(f, vec![0.0, 0.5, 1.0, 0.0, 0.5, 1.0]);
        let colors = SpreadColors {
            colors: vec![ColorValue::Rgb { rgb: [255, 0, 0], white: None }, ColorValue::Rgb { rgb: [0, 0, 255], white: None }],
            blend: ColorBlend::Smooth,
        };
        assert_eq!(colors.at(0.5), Some(ColorState::Rgb([0.5, 0.0, 0.5], WhiteStrategy::Preserve)));
        let step = SpreadColors { blend: ColorBlend::Step, ..colors };
        assert_eq!(step.at(0.6), Some(ColorState::Rgb([0.0, 0.0, 1.0], WhiteStrategy::Preserve)));
        assert_eq!(step.at(0.4), Some(ColorState::Rgb([1.0, 0.0, 0.0], WhiteStrategy::Preserve)));
    }

    #[test]
    fn 颜色插值_rgb_色温_手动() {
        let a = ColorState::of(&ColorValue::Rgb { rgb: [255, 0, 0], white: None });
        let b = ColorState::of(&ColorValue::Rgb { rgb: [0, 0, 255], white: None });
        assert_eq!(ColorState::lerp(&a, &b, 0.5), ColorState::Rgb([0.5, 0.0, 0.5], WhiteStrategy::Preserve));
        let k = ColorState::lerp(&ColorState::Kelvin(2000.0), &ColorState::Kelvin(8000.0), 0.5);
        let ColorState::Kelvin(mid) = k else { panic!("应为色温") };
        assert!(near(mid, 1e6 / f64::midpoint(500.0, 125.0)), "按 mired 插值：{mid}");
        let m = ColorState::Manual([0.0; EMITTERS]);
        assert_eq!(ColorState::lerp(&a, &m, 0.4), a);
        assert_eq!(ColorState::lerp(&a, &m, 0.6), m);
    }

    #[test]
    fn 色相旋转() {
        let red = ColorState::Rgb([1.0, 0.0, 0.0], WhiteStrategy::Preserve);
        let ColorState::Rgb(g, _) = red.rotate_hue(120.0) else { panic!() };
        assert!(near(g[0], 0.0) && near(g[1], 1.0) && near(g[2], 0.0), "{g:?}");
        assert_eq!(ColorState::Kelvin(3000.0).rotate_hue(90.0), ColorState::Kelvin(3000.0));
    }

    #[test]
    fn 外观叠加在预设之上() {
        let preset = Look {
            intensity: Some(NumParam::Value { value: 50.0 }),
            color: Some(ColorParam::Value { value: ColorValue::Kelvin { kelvin: 3200.0 } }),
            attrs: BTreeMap::from([(ChannelFunction::Pan, NumParam::Value { value: 0.2 })]),
            preset_id: None,
        };
        let look = Look {
            intensity: Some(NumParam::Value { value: 80.0 }),
            attrs: BTreeMap::from([(ChannelFunction::Tilt, NumParam::Value { value: 0.7 })]),
            preset_id: Some("p".into()),
            ..Look::default()
        };
        let m = look.over(&preset);
        assert_eq!(m.intensity, Some(NumParam::Value { value: 80.0 }));
        assert!(m.color.is_some());
        assert_eq!(m.attrs.len(), 2);
    }

    #[test]
    fn 分布_位置分数_分翼与延迟() {
        let s = Spread::default();
        let f: Vec<f64> = (0..5).map(|i| s.fraction(i, 5)).collect();
        assert_eq!(f, vec![0.0, 0.25, 0.5, 0.75, 1.0]);
        let wings = Spread { wings: Some(2), ..Spread::default() };
        let f: Vec<f64> = (0..6).map(|i| wings.fraction(i, 6)).collect();
        assert_eq!(f, vec![0.0, 0.5, 1.0, 1.0, 0.5, 0.0]);
        let d = Spread { delay: Some(SpreadDelay { from_ms: 0.0, to_ms: 400.0 }), ..Spread::default() };
        assert!(near(d.delay_ms(0.5), 200.0));
        assert!(Spread::default().value("pan", 0.5).is_none());
    }

    #[test]
    fn 前端形态的外观能反序列化() {
        let json = r#"{
            "intensity": {"kind":"curve","curve":{"shape":"sine","from":0,"to":100,"cycles":2,"phase":0}},
            "color": {"kind":"keys","keys":[{"tMs":0,"value":{"kind":"rgb","rgb":[255,0,0]},"curve":"linear"},
                                             {"tMs":1000,"value":{"kind":"kelvin","kelvin":3200},"curve":"hold"}]},
            "attrs": {"pan": {"kind":"value","value":0.5}, "gobo": {"kind":"value","value":0.25}},
            "presetId": "p1"
        }"#;
        let look: Look = serde_json::from_str(json).expect("应能解析");
        assert_eq!(look.attrs.len(), 2);
        assert!(look.attrs.contains_key(&ChannelFunction::Gobo));
        let manual: ColorValue =
            serde_json::from_str(r#"{"kind":"manual","values":{"warmWhite":0.5,"red":1}}"#).expect("手动颜色");
        let ColorState::Manual(v) = ColorState::of(&manual) else { panic!() };
        assert!(near(v[crate::mix::WW], 0.5) && near(v[crate::mix::R], 1.0));
    }
}
