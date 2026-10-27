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

use crate::effects::hash32;
use crate::envelope::apply_gamma;
use crate::fixture::ChannelFunction;
use crate::mix::{kelvin_to_linear, ColorRequest, WhiteStrategy, EMITTERS};

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
    /// 片段内的循环次数。
    #[serde(default = "one")]
    pub cycles: f64,
    /// 起始相位 0~1。
    #[serde(default)]
    pub phase: f64,
    /// 方波占空比 0~1。
    #[serde(default)]
    pub duty: Option<f64>,
}

fn one() -> f64 {
    1.0
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
        /// 曲线。
        curve: ValueCurve,
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
        match self {
            Self::Value { value } => *value,
            Self::Keys { keys } => sample_keys(keys, u_ms, |a, b, t| a + (b - a) * t).unwrap_or(0.0),
            Self::Curve { curve } => sample_curve(curve, u_ms, len_ms, phase_offset),
        }
    }
}

fn sample_curve(c: &ValueCurve, u_ms: f64, len_ms: f64, phase_offset: f64) -> f64 {
    let len = len_ms.max(1.0);
    let progress = (u_ms / len).clamp(0.0, 1.0);
    let cycles = if c.cycles.is_finite() { c.cycles.clamp(1.0, 1000.0) } else { 1.0 };
    let offset = if phase_offset.is_finite() { phase_offset } else { 0.0 };
    // 相位偏移落在 0~1（负偏移按周期折回），保证 floor 后的周期序号不为负
    let x = progress * cycles + c.phase.clamp(0.0, 1.0) + offset.rem_euclid(1.0);
    let f = x - x.floor();
    let s = match c.shape {
        WaveShape::Sine => 0.5 - 0.5 * (std::f64::consts::TAU * x).cos(),
        WaveShape::Triangle => 1.0 - (2.0 * f - 1.0).abs(),
        WaveShape::Saw => f,
        WaveShape::Square => {
            if f < c.duty.unwrap_or(0.5).clamp(0.0, 1.0) {
                1.0
            } else {
                0.0
            }
        }
        WaveShape::Ramp => progress,
        WaveShape::Random => {
            let step = x.floor().max(0.0) as u32;
            f64::from(hash32(0x5EED, 0, step)) / 4_294_967_296.0
        }
    };
    c.from + (c.to - c.from) * s
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
    #[allow(clippy::many_single_char_names)]
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

/// 色温在 sRGB 编码空间的近似颜色（插值用）。
fn kelvin_srgb(k: f64) -> [f64; 3] {
    kelvin_to_linear(k).map(crate::mix::linear_to_srgb)
}

#[allow(clippy::many_single_char_names)]
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

#[allow(clippy::many_single_char_names)]
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
        match self {
            Self::Value { value } => Some(ColorState::of(value)),
            Self::Keys { keys } => {
                let states: Vec<Keyframe<ColorState>> = keys
                    .iter()
                    .map(|k| Keyframe { t_ms: k.t_ms, value: ColorState::of(&k.value), curve: k.curve })
                    .collect();
                sample_keys(&states, u_ms, ColorState::lerp)
            }
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
            curve: ValueCurve { shape, from: 10.0, to: 20.0, cycles, phase: 0.0, duty: None },
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
