//! 混色引擎：把“意图色”（RGB / 色温 / 按发光体直给）按灯具实际具备的发光体换算成各通道的线性输出。
//!
//! # 坐标与单位
//!
//! 全部计算在**线性光**空间进行：调用方先用工程 Gamma 把界面上的颜色和亮度解码成线性分数
//! （见 [`crate::envelope::apply_gamma`]），混色结果直接写入 DMX（LED 的 PWM 与光通量成正比）。
//! 对只有 RGB 的灯具，这与“先算颜色、写入前再套 Gamma”逐位等价。
//!
//! 所有以“显示色”描述的颜色都用**同一个工程 Gamma** 解码：界面上的 RGB、色温（先换成显示色）、
//! 发光体校准里的 RGB / 色温、琥珀 / 青柠 / UV 的默认颜色。预览再用 Gamma 的逆编码回显示色
//! （[`crate::envelope::encode_gamma`]），因此预览色与界面上选的颜色、与 DMX 输出三者一致。
//!
//! # 策略（Strategy）
//!
//! 每台灯具在编译时由 [`ColorMixer::for_fixture`]（工厂）按通道组成选出一种混色策略：
//!
//! | 策略 | 适用灯具 | 规则 |
//! |---|---|---|
//! | [`RgbFamily`] | 含红 / 绿 / 蓝任一 | 白光（W、CW/WW）、琥珀、青柠按发光体颜色依次从目标色里提取 |
//! | [`CctOnly`] | 只有冷白 / 暖白 | 色温按 mired 插值分配；RGB 意图按红蓝比例估计冷暖 |
//! | [`MonoEmitter`] | 只有白 / 琥珀 / UV 等单色 | 输出目标色的峰值 |
//! | 仅调光 / 仅开关 | 只有调光或开关 | 亮度乘目标色峰值 / 有光即开 |
//!
//! # 白光提取
//!
//! 每路发光体用一个线性 RGB 向量 `e` 表示（未校准时 R/G/B 为单位向量，W/CW 为理想白 `[1,1,1]`，
//! WW 为 3000K 黑体色）。对目标色 `T`，能由该发光体给出的最大份额为 `min_c(T_c / e_c)`。
//! 冷暖白同时存在时，在 `(1-a)·CW + a·WW` 上搜索使份额最大的比例 `a`。
//! [`WhiteStrategy`] 决定提取后是否从 RGB 里扣除（保色 / 增亮 / 不用白光）。

use serde::{Deserialize, Serialize};

use crate::compile::Driven;
use crate::envelope::apply_gamma;
use crate::fixture::{ChannelFunction, FixtureModel};

/// 混色结果的分量数。
pub const COMPONENTS: usize = 12;

/// 分量下标：红。
pub const R: usize = 0;
/// 分量下标：绿。
pub const G: usize = 1;
/// 分量下标：蓝。
pub const B: usize = 2;
/// 分量下标：白。
pub const W: usize = 3;
/// 分量下标：冷白。
pub const CW: usize = 4;
/// 分量下标：暖白。
pub const WW: usize = 5;
/// 分量下标：琥珀。
pub const AMBER: usize = 6;
/// 分量下标：紫外。
pub const UV: usize = 7;
/// 分量下标：青柠。
pub const LIME: usize = 8;
/// 分量下标：靛蓝。
pub const INDIGO: usize = 9;
/// 分量下标：调光。
pub const DIM: usize = 10;
/// 分量下标：开关。
pub const SW: usize = 11;

/// 发光体分量（R..=INDIGO）的个数。
pub const EMITTERS: usize = 10;

/// 一次混色的结果：各分量的线性输出 `0..=1`（灯具没有的通道恒为 0）。
pub type Components = [f64; COMPONENTS];

/// 白光策略：RGB 意图下如何使用白光类发光体。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WhiteStrategy {
    /// 不用白光，只用 RGB。
    Off,
    /// 保色：白光分量从 RGB 里扣除，颜色最准。
    #[default]
    Preserve,
    /// 增亮：RGB 保持原值并叠加白光，更亮但颜色略淡。
    Boost,
}

/// 只有冷暖白的灯具如何把色温换算成两路输出。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CctMode {
    /// 最大输出：较强的一路始终满亮（中间色温最亮）。
    #[default]
    MaxOutput,
    /// 恒定亮度：两路之和恒为 1（任意色温亮度一致）。
    ConstantSum,
}

/// 混色意图。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ColorRequest {
    /// 线性 RGB 目标色（各分量 `0..=1`）与白光策略。
    Rgb {
        /// 线性 RGB。
        rgb: [f64; 3],
        /// 白光策略。
        white: WhiteStrategy,
    },
    /// 色温（K），按灯具能力换算。
    Kelvin(f64),
    /// 按发光体直接给定（下标同 [`R`] ..= [`INDIGO`]，各 `0..=1`，为 DMX 线性分数）。
    Manual([f64; EMITTERS]),
}

/// 一路发光体的颜色向量（线性 RGB，最大分量为 1，再乘相对亮度）。
pub type EmitterVector = [f64; 3];

/// 灯具发光体的颜色（按 [`R`] ..= [`INDIGO`] 下标）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Emitters {
    /// 各发光体的线性 RGB 向量。
    pub vectors: [EmitterVector; EMITTERS],
    /// 冷白参考色温（K）：mired 插值用。
    pub cool_kelvin: f64,
    /// 暖白参考色温（K）：mired 插值用。
    pub warm_kelvin: f64,
    /// 显示色 → 线性输出所用的 Gamma（工程 Gamma，已规整）：色温意图按它解码。
    pub gamma: f64,
}

/// 未指定工程 Gamma 时（例如单元测试）使用的 Gamma（常见 LED 的感知校正）。
///
/// 工程本身缺省为 `1.0`（关闭校正，见 `project.rs` 的 `default_gamma`），这里只给不经过工程的调用方兜底。
pub const DEFAULT_GAMMA: f64 = 2.2;

/// 未校准的冷白色温。
pub const DEFAULT_COOL_K: f64 = 6500.0;
/// 未校准的暖白色温。
pub const DEFAULT_WARM_K: f64 = 3000.0;

impl Default for Emitters {
    fn default() -> Self {
        Self::with_gamma(DEFAULT_GAMMA)
    }
}

impl Emitters {
    /// 未校准灯具的发光体颜色：显示色按 `gamma` 解码到线性。
    ///
    /// # Arguments
    ///
    /// * `gamma` - 工程 Gamma（已规整）。
    ///
    /// # Returns
    ///
    /// 理想发光体颜色（R/G/B 为单位向量，W/CW 为理想白，WW 为 3000K，琥珀 / UV / 青柠为常见颜色）。
    #[must_use]
    pub fn with_gamma(gamma: f64) -> Self {
        Self {
            vectors: [
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 1.0, 1.0],
                [1.0, 1.0, 1.0],
                kelvin_to_output(DEFAULT_WARM_K, gamma),
                display8_to_output([255, 191, 0], gamma),
                // UV 只在预览里有颜色意义，RGB 意图从不分配给它
                display8_to_output([96, 0, 255], gamma).map(|v| v * 0.3),
                display8_to_output([191, 255, 0], gamma),
                // 靛蓝（约 445 nm）：与 UV 一样只由“按发光体直给”驱动，RGB 意图不分配给它
                display8_to_output([75, 0, 255], gamma),
            ],
            cool_kelvin: DEFAULT_COOL_K,
            warm_kelvin: DEFAULT_WARM_K,
            gamma,
        }
    }

    /// 由物模型的发光体校准生成颜色向量；未声明的发光体用理想颜色。
    /// 校准里的 RGB 与色温是显示色，按工程 Gamma 解码（与界面上的颜色同一个换算）。
    ///
    /// # Arguments
    ///
    /// * `model` - 灯具物模型。
    /// * `gamma` - 工程 Gamma（已规整）。
    ///
    /// # Returns
    ///
    /// 校准后的发光体颜色。
    #[must_use]
    pub fn from_model(model: &FixtureModel, gamma: f64) -> Self {
        let mut e = Self::with_gamma(gamma);
        for cal in &model.emitters {
            let Some(index) = emitter_index(cal.function) else { continue };
            let base = if let Some(rgb) = cal.rgb {
                normalize(display8_to_output(rgb, gamma))
            } else if let Some(k) = cal.kelvin {
                kelvin_to_output(f64::from(k), gamma)
            } else {
                e.vectors[index]
            };
            let gain = if cal.intensity.is_finite() && cal.intensity > 0.0 { cal.intensity } else { 1.0 };
            e.vectors[index] = base.map(|v| v * gain);
            match (cal.function, cal.kelvin) {
                (ChannelFunction::CoolWhite, Some(k)) => e.cool_kelvin = f64::from(k),
                (ChannelFunction::WarmWhite, Some(k)) => e.warm_kelvin = f64::from(k),
                _ => {}
            }
        }
        e
    }
}

/// 发光体功能对应的分量下标。
///
/// # Arguments
///
/// * `function` - 通道功能。
///
/// # Returns
///
/// 发光体返回 `Some(下标)`，其余功能为 `None`。
#[must_use]
pub fn emitter_index(function: ChannelFunction) -> Option<usize> {
    Some(match function {
        ChannelFunction::Red => R,
        ChannelFunction::Green => G,
        ChannelFunction::Blue => B,
        ChannelFunction::White => W,
        ChannelFunction::CoolWhite => CW,
        ChannelFunction::WarmWhite => WW,
        ChannelFunction::Amber => AMBER,
        ChannelFunction::Uv => UV,
        ChannelFunction::Lime => LIME,
        ChannelFunction::Indigo => INDIGO,
        _ => return None,
    })
}

/// 灯具具备哪些分量。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Present([bool; COMPONENTS]);

impl Present {
    /// 由被驱动通道得到分量集合。
    ///
    /// # Arguments
    ///
    /// * `d` - 编译得到的被驱动通道。
    ///
    /// # Returns
    ///
    /// 每个分量是否存在。
    #[must_use]
    pub fn of(d: &Driven) -> Self {
        let mut p = [false; COMPONENTS];
        for (i, slot) in d.slots().iter().enumerate() {
            p[i] = slot.is_some();
        }
        Self(p)
    }

    /// 某个分量是否存在。
    ///
    /// # Arguments
    ///
    /// * `component` - 分量下标。
    ///
    /// # Returns
    ///
    /// 存在时为 `true`。
    #[must_use]
    pub fn has(&self, component: usize) -> bool {
        self.0.get(component).copied().unwrap_or(false)
    }

    fn any(&self, components: &[usize]) -> bool {
        components.iter().any(|&c| self.has(c))
    }
}

/// 一种混色策略。
pub trait MixStrategy {
    /// 把意图色换算成各发光体的线性份额（不含亮度级别与调光，结果各分量 `0..=1`）。
    ///
    /// # Arguments
    ///
    /// * `e` - 灯具发光体颜色。
    /// * `p` - 灯具具备的分量。
    /// * `request` - 混色意图。
    ///
    /// # Returns
    ///
    /// 各分量的份额；调光 / 开关分量由 [`ColorMixer::mix`] 统一填写。
    fn emit(&self, e: &Emitters, p: Present, request: &ColorRequest) -> Components;
}

/// RGB 系灯具（RGB / RGBW / RGBCW / RGBA / RGBAW+UV / RGBL …）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RgbFamily;

/// 只有冷白 / 暖白（可带白光）的灯具。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CctOnly {
    /// 冷暖分配方式。
    pub mode: CctMode,
}

/// 只有单色发光体（白、琥珀、UV、青柠）的灯具。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MonoEmitter;

/// 没有发光体（仅调光 / 仅开关 / 无可驱动通道）的灯具。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NoEmitter;

impl MixStrategy for RgbFamily {
    fn emit(&self, e: &Emitters, p: Present, request: &ColorRequest) -> Components {
        let (target, white) = match *request {
            ColorRequest::Rgb { rgb, white } => (rgb.map(|v| v.clamp(0.0, 1.0)), white),
            ColorRequest::Kelvin(k) => (kelvin_to_output(k, e.gamma), WhiteStrategy::Preserve),
            ColorRequest::Manual(values) => return manual(values, p),
        };
        let mut out = [0.0; COMPONENTS];
        let mut rem = target;
        let subtract = white == WhiteStrategy::Preserve;
        if white != WhiteStrategy::Off {
            if p.has(W) {
                let w = fit(rem, e.vectors[W]);
                out[W] = w;
                if subtract {
                    take(&mut rem, e.vectors[W], w);
                }
            }
            if p.any(&[CW, WW]) {
                let source = if subtract { rem } else { target };
                let (cw, ww) = best_cct_fit(source, e, p.has(CW), p.has(WW));
                out[CW] = cw;
                out[WW] = ww;
                if subtract {
                    take(&mut rem, e.vectors[CW], cw);
                    take(&mut rem, e.vectors[WW], ww);
                }
            }
            // 琥珀 / 青柠只在保色模式下参与：它们改变色相，增亮模式叠加会偏色
            if subtract {
                for k in [AMBER, LIME] {
                    if p.has(k) {
                        let v = fit(rem, e.vectors[k]);
                        out[k] = v;
                        take(&mut rem, e.vectors[k], v);
                    }
                }
            }
        }
        out[R] = rem[0];
        out[G] = rem[1];
        out[B] = rem[2];
        normalize_emitters(&mut out);
        out
    }
}

impl MixStrategy for CctOnly {
    fn emit(&self, e: &Emitters, p: Present, request: &ColorRequest) -> Components {
        let mut out = [0.0; COMPONENTS];
        let (warmth, peak) = match *request {
            ColorRequest::Manual(values) => return manual(values, p),
            ColorRequest::Kelvin(k) => (mired_warmth(k, e), 1.0),
            ColorRequest::Rgb { rgb, .. } => {
                let [r, _, b] = rgb.map(|v| v.clamp(0.0, 1.0));
                let total = r + b;
                // 红多偏暖、蓝多偏冷；红蓝都没有时取中间
                let warm = if total > 0.0 { r / total } else { 0.5 };
                (warm, rgb.iter().fold(0.0_f64, |m, v| m.max(v.clamp(0.0, 1.0))))
            }
        };
        let (cool, warm) = match (p.has(CW), p.has(WW)) {
            (true, true) => split_cct(warmth, self.mode),
            (true, false) => (1.0, 0.0),
            (false, true) => (0.0, 1.0),
            (false, false) => (0.0, 0.0),
        };
        out[CW] = cool * peak;
        out[WW] = warm * peak;
        if p.has(W) {
            out[W] = peak;
        }
        out
    }
}

impl MixStrategy for MonoEmitter {
    fn emit(&self, _e: &Emitters, p: Present, request: &ColorRequest) -> Components {
        let peak = match *request {
            ColorRequest::Manual(values) => return manual(values, p),
            ColorRequest::Kelvin(_) => 1.0,
            ColorRequest::Rgb { rgb, .. } => rgb.iter().fold(0.0_f64, |m, v| m.max(v.clamp(0.0, 1.0))),
        };
        let mut out = [0.0; COMPONENTS];
        for (k, v) in out.iter_mut().enumerate().take(EMITTERS) {
            if p.has(k) {
                *v = peak;
            }
        }
        out
    }
}

impl MixStrategy for NoEmitter {
    fn emit(&self, _e: &Emitters, _p: Present, _request: &ColorRequest) -> Components {
        [0.0; COMPONENTS]
    }
}

/// 一台灯具的混色器：编译时按通道组成选定策略（工厂），求值时逐帧调用。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorMixer {
    strategy: Strategy,
    present: Present,
    emitters: Emitters,
}

/// 策略的枚举分发（避免每台灯具一次堆分配，也便于克隆编译结果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Strategy {
    Rgb(RgbFamily),
    Cct(CctOnly),
    Mono(MonoEmitter),
    None(NoEmitter),
}

impl ColorMixer {
    /// 工厂：按灯具的被驱动通道与发光体校准选出混色策略。
    ///
    /// # Arguments
    ///
    /// * `driven` - 编译得到的被驱动通道。
    /// * `emitters` - 发光体颜色（见 [`Emitters::from_model`]）。
    ///
    /// # Returns
    ///
    /// 该灯具的混色器。
    #[must_use]
    pub fn for_fixture(driven: &Driven, emitters: Emitters) -> Self {
        let present = Present::of(driven);
        let strategy = if present.any(&[R, G, B]) {
            Strategy::Rgb(RgbFamily)
        } else if present.any(&[CW, WW]) {
            Strategy::Cct(CctOnly::default())
        } else if present.any(&[W, AMBER, UV, LIME, INDIGO]) {
            Strategy::Mono(MonoEmitter)
        } else {
            Strategy::None(NoEmitter)
        };
        Self { strategy, present, emitters }
    }

    /// 灯具具备的分量。
    ///
    /// # Returns
    ///
    /// 分量集合。
    #[must_use]
    pub fn present(&self) -> Present {
        self.present
    }

    /// 是否有加色发光体（否则只有调光 / 开关，颜色靠 CMY 或色轮）。
    ///
    /// # Returns
    ///
    /// 选中的策略不是“仅调光 / 开关”时为 `true`。
    #[must_use]
    pub fn has_emitters(&self) -> bool {
        !matches!(self.strategy, Strategy::None(_))
    }

    /// 混色：意图色 + 线性亮度级别 → 各分量线性输出。
    ///
    /// 有调光通道时颜色保持满值、亮度交给调光；没有时各发光体按级别缩放。
    /// 没有发光体时调光输出“级别 × 目标色峰值”。开关在有光时打开。
    ///
    /// # Arguments
    ///
    /// * `request` - 混色意图。
    /// * `level` - 线性亮度级别 `0..=1`（已含包络与 Gamma 解码）。
    ///
    /// # Returns
    ///
    /// 各分量的线性输出，范围 `0..=1`；灯具没有的分量恒为 0。
    #[must_use]
    pub fn mix(&self, request: &ColorRequest, level: f64) -> Components {
        let level = if level.is_finite() { level.clamp(0.0, 1.0) } else { 0.0 };
        let mut out = match self.strategy {
            Strategy::Rgb(s) => s.emit(&self.emitters, self.present, request),
            Strategy::Cct(s) => s.emit(&self.emitters, self.present, request),
            Strategy::Mono(s) => s.emit(&self.emitters, self.present, request),
            Strategy::None(s) => s.emit(&self.emitters, self.present, request),
        };
        let has_emitters = !matches!(self.strategy, Strategy::None(_));
        let peak = request_peak(request);
        if self.present.has(DIM) {
            out[DIM] = if has_emitters { level } else { level * peak };
        } else {
            for v in &mut out[..EMITTERS] {
                *v *= level;
            }
        }
        if self.present.has(SW) && level * peak > 0.0 {
            out[SW] = 1.0;
        }
        for (k, v) in out.iter_mut().enumerate() {
            if !self.present.has(k) {
                *v = 0.0;
            }
        }
        out
    }

    /// 由混色结果推算灯具实际发出的颜色（线性 RGB），供预览显示“实际输出”。
    ///
    /// # Arguments
    ///
    /// * `c` - [`ColorMixer::mix`] 的结果（或多路合成后的结果）。
    ///
    /// # Returns
    ///
    /// 线性 RGB，各分量 `0..=1`（超出时整体压缩，保持色相）。
    #[must_use]
    pub fn emitted_rgb(&self, c: &Components) -> [f64; 3] {
        let dim = if self.present.has(DIM) { c[DIM] } else { 1.0 };
        let mut rgb = [0.0; 3];
        if matches!(self.strategy, Strategy::None(_)) {
            // 仅调光 / 开关灯：按白光显示
            let v = if self.present.has(DIM) { c[DIM] } else { c[SW] };
            return [v; 3];
        }
        for (amount, vector) in c.iter().zip(&self.emitters.vectors) {
            for (acc, e) in rgb.iter_mut().zip(vector) {
                *acc += amount * e;
            }
        }
        let peak = rgb.iter().fold(0.0_f64, |m, v| m.max(*v));
        let scale = if peak > 1.0 { dim / peak } else { dim };
        rgb.map(|v| (v * scale).clamp(0.0, 1.0))
    }
}

/// 意图色的峰值（仅调光 / 开关灯用它决定亮度）。
fn request_peak(request: &ColorRequest) -> f64 {
    match request {
        ColorRequest::Rgb { rgb, .. } => rgb.iter().fold(0.0_f64, |m, v| m.max(v.clamp(0.0, 1.0))),
        ColorRequest::Kelvin(_) => 1.0,
        ColorRequest::Manual(values) => values.iter().fold(0.0_f64, |m, v| m.max(v.clamp(0.0, 1.0))),
    }
}

/// 按发光体直给：只保留灯具具备的分量。
fn manual(values: [f64; EMITTERS], p: Present) -> Components {
    let mut out = [0.0; COMPONENTS];
    for (k, v) in values.into_iter().enumerate() {
        if p.has(k) {
            out[k] = if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
        }
    }
    out
}

/// 目标色里最多能由发光体 `e` 给出多少份额：`min_c(T_c / e_c)`（只看 `e_c > 0` 的分量）。
fn fit(target: [f64; 3], e: EmitterVector) -> f64 {
    let mut best = f64::INFINITY;
    for c in 0..3 {
        if e[c] > 1e-9 {
            best = best.min(target[c].max(0.0) / e[c]);
        }
    }
    if best.is_finite() { best.clamp(0.0, 1.0) } else { 0.0 }
}

/// 从剩余色里扣除 `amount × e`（不小于 0）。
fn take(rem: &mut [f64; 3], e: EmitterVector, amount: f64) {
    for c in 0..3 {
        rem[c] = (rem[c] - amount * e[c]).max(0.0);
    }
}

/// 冷暖白的最佳组合：在 `(1-a)·CW + a·WW` 上搜索使可提取份额最大的 `a`。
///
/// 份额相同时取更冷的一侧（`a` 较小），保证结果确定。
fn best_cct_fit(target: [f64; 3], e: &Emitters, cool: bool, warm: bool) -> (f64, f64) {
    match (cool, warm) {
        (true, false) => (fit(target, e.vectors[CW]), 0.0),
        (false, true) => (0.0, fit(target, e.vectors[WW])),
        (false, false) => (0.0, 0.0),
        (true, true) => {
            const STEPS: u32 = 64;
            let (mut best_w, mut best_a) = (-1.0, 0.0);
            for i in 0..=STEPS {
                let a = f64::from(i) / f64::from(STEPS);
                let mix = blend(e.vectors[CW], e.vectors[WW], a);
                let w = fit(target, mix);
                if w > best_w + 1e-12 {
                    best_w = w;
                    best_a = a;
                }
            }
            let w = best_w.max(0.0);
            (w * (1.0 - best_a), w * best_a)
        }
    }
}

fn blend(a: EmitterVector, b: EmitterVector, t: f64) -> EmitterVector {
    [0, 1, 2].map(|c| a[c] * (1.0 - t) + b[c] * t)
}

/// 色温在冷暖白之间的“暖度”：按 mired（`1e6 / K`）线性插值，`0` 为全冷、`1` 为全暖。
fn mired_warmth(kelvin: f64, e: &Emitters) -> f64 {
    let m = 1e6 / kelvin.clamp(1000.0, 20000.0);
    let m_cool = 1e6 / e.cool_kelvin.max(1.0);
    let m_warm = 1e6 / e.warm_kelvin.max(1.0);
    if (m_warm - m_cool).abs() < 1e-9 {
        return 0.5;
    }
    ((m - m_cool) / (m_warm - m_cool)).clamp(0.0, 1.0)
}

/// 由暖度得到冷暖两路的份额。
fn split_cct(warmth: f64, mode: CctMode) -> (f64, f64) {
    let warm = warmth.clamp(0.0, 1.0);
    let cool = 1.0 - warm;
    match mode {
        CctMode::ConstantSum => (cool, warm),
        CctMode::MaxOutput => ((2.0 * cool).min(1.0), (2.0 * warm).min(1.0)),
    }
}

/// 发光体分量里有超过 1 的，整体等比压缩（保持色相）。
fn normalize_emitters(out: &mut Components) {
    let peak = out[..EMITTERS].iter().fold(0.0_f64, |m, v| m.max(*v));
    if peak > 1.0 {
        for v in &mut out[..EMITTERS] {
            *v /= peak;
        }
    }
}

fn normalize(v: [f64; 3]) -> [f64; 3] {
    let peak = v.iter().fold(0.0_f64, |m, x| m.max(*x));
    if peak > 0.0 { v.map(|x| x / peak) } else { [1.0, 1.0, 1.0] }
}

/// sRGB 传递函数解码（`0..=1` → 线性）。
///
/// # Arguments
///
/// * `v` - sRGB 编码值 `0..=1`。
///
/// # Returns
///
/// 线性值 `0..=1`。
#[must_use]
pub fn srgb_to_linear(v: f64) -> f64 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// sRGB 传递函数编码（线性 → `0..=1`）。
///
/// # Arguments
///
/// * `v` - 线性值 `0..=1`。
///
/// # Returns
///
/// sRGB 编码值 `0..=1`。
#[must_use]
pub fn linear_to_srgb(v: f64) -> f64 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// 8 位显示色 → 线性输出（按工程 Gamma 解码，与界面颜色同一个换算）。
fn display8_to_output(c: [u8; 3], gamma: f64) -> [f64; 3] {
    c.map(|v| apply_gamma(f64::from(v) / 255.0, gamma))
}

/// 色温（K）→ 显示色（sRGB 编码空间，最大分量为 1）：Tanner Helland 对黑体辐射数据的拟合，
/// 与前端色块用的 `kelvinToRgb` 同一公式。
///
/// # Arguments
///
/// * `kelvin` - 色温，超出 1000~40000 时被夹取。
///
/// # Returns
///
/// 显示色 `0..=1`。
#[must_use]
pub fn kelvin_display(kelvin: f64) -> [f64; 3] {
    let t = kelvin.clamp(1000.0, 40000.0) / 100.0;
    let r = if t <= 66.0 { 255.0 } else { 329.698_727_446 * (t - 60.0).powf(-0.133_204_759_2) };
    let g = if t <= 66.0 {
        99.470_802_586_1 * t.ln() - 161.119_568_166_1
    } else {
        288.122_169_528_3 * (t - 60.0).powf(-0.075_514_849_2)
    };
    let b = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        138.517_731_223_1 * (t - 10.0).ln() - 305.044_792_730_7
    };
    normalize([r, g, b].map(|v| v.clamp(0.0, 255.0) / 255.0))
}

/// 色温（K）→ 线性输出：显示色按工程 Gamma 解码（最大分量为 1）。
///
/// # Arguments
///
/// * `kelvin` - 色温。
/// * `gamma` - 工程 Gamma（已规整）。
///
/// # Returns
///
/// 线性输出 `0..=1`。
#[must_use]
pub fn kelvin_to_output(kelvin: f64, gamma: f64) -> [f64; 3] {
    kelvin_display(kelvin).map(|v| apply_gamma(v, gamma))
}

/// 色温（K）→ 线性 RGB（最大分量为 1）。
///
/// 采用 Tanner Helland 对黑体辐射数据（CIE 1964 10° 标准观察者）的拟合公式，适用于
/// 1000K~40000K；结果先按 sRGB 解码到线性，再归一化。6500K 附近接近白点。
///
/// # Arguments
///
/// * `kelvin` - 色温，超出 1000~40000 时被夹取。
///
/// # Returns
///
/// 线性 RGB。
#[must_use]
pub fn kelvin_to_linear(kelvin: f64) -> [f64; 3] {
    normalize(kelvin_display(kelvin).map(srgb_to_linear))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::Slot;

    #[expect(clippy::unnecessary_wraps, reason = "测试辅助：与被测 API 的 Option 签名对齐")]
    fn slot(offset: u16) -> Option<Slot> {
        Some(Slot { offset, width: 1, big_endian: true, invert: false })
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    fn mixer(d: Driven) -> ColorMixer {
        ColorMixer::for_fixture(&d, Emitters::default())
    }

    fn rgb_req(rgb: [f64; 3]) -> ColorRequest {
        ColorRequest::Rgb { rgb, white: WhiteStrategy::Preserve }
    }

    fn rgb_fixture() -> Driven {
        Driven { red: slot(0), green: slot(1), blue: slot(2), ..Driven::default() }
    }

    #[test]
    fn rgb_按级别缩放() {
        let m = mixer(rgb_fixture()).mix(&rgb_req([1.0, 0.5, 0.0]), 0.5);
        assert!(near(m[R], 0.5) && near(m[G], 0.25) && near(m[B], 0.0));
        assert!(near(m[DIM], 0.0));
    }

    #[test]
    fn 带调光通道时颜色不缩放() {
        let d = Driven { dimmer: slot(3), ..rgb_fixture() };
        let m = mixer(d).mix(&rgb_req([1.0, 0.5, 0.0]), 0.5);
        assert!(near(m[R], 1.0) && near(m[G], 0.5));
        assert!(near(m[DIM], 0.5));
    }

    #[test]
    fn rgbw_保色提取白光() {
        let d = Driven { white: slot(3), ..rgb_fixture() };
        let m = mixer(d).mix(&rgb_req([1.0, 0.6, 0.2]), 1.0);
        assert!(near(m[W], 0.2));
        assert!(near(m[R], 0.8) && near(m[G], 0.4) && near(m[B], 0.0));
    }

    #[test]
    fn rgbw_增亮与不用白光() {
        let mx = mixer(Driven { white: slot(3), ..rgb_fixture() });
        let boost = mx.mix(&ColorRequest::Rgb { rgb: [1.0, 0.6, 0.2], white: WhiteStrategy::Boost }, 1.0);
        assert!(near(boost[R], 1.0) && near(boost[B], 0.2) && near(boost[W], 0.2));
        let off = mx.mix(&ColorRequest::Rgb { rgb: [1.0, 0.6, 0.2], white: WhiteStrategy::Off }, 1.0);
        assert!(near(off[W], 0.0) && near(off[R], 1.0));
    }

    #[test]
    fn 校准过的白光按实际颜色提取() {
        let mut e = Emitters::default();
        e.vectors[W] = [1.0, 0.8, 0.5]; // 偏暖的白光 LED
        let mx = ColorMixer::for_fixture(&Driven { white: slot(3), ..rgb_fixture() }, e);
        let m = mx.mix(&rgb_req([1.0, 0.8, 0.5]), 1.0);
        // 目标色正好是白光 LED 的颜色：全部由白光给出
        assert!(near(m[W], 1.0));
        assert!(m[R] < 1e-6 && m[G] < 1e-6 && m[B] < 1e-6);
    }

    #[test]
    fn rgbcw_中性灰只用冷白_暖色更多用暖白() {
        let mx = mixer(Driven { cool: slot(3), warm: slot(4), ..rgb_fixture() });
        let grey = mx.mix(&rgb_req([0.5, 0.5, 0.5]), 1.0);
        assert!(near(grey[CW], 0.5) && near(grey[WW], 0.0));
        assert!(grey[R] < 1e-6 && grey[G] < 1e-6 && grey[B] < 1e-6);

        let warm_target = kelvin_to_output(3000.0, DEFAULT_GAMMA);
        let warm = mx.mix(&rgb_req(warm_target), 1.0);
        assert!(warm[WW] > 0.99, "暖白应接近满亮：{warm:?}");
        assert!(warm[CW] < 0.02);
    }

    #[test]
    fn 色温意图_rgbcw_由白光给出() {
        let mx = mixer(Driven { cool: slot(3), warm: slot(4), ..rgb_fixture() });
        let m = mx.mix(&ColorRequest::Kelvin(6500.0), 1.0);
        // 黑体 6500K 比理想白略暖：冷白为主，掺一点暖白把红色补满
        assert!(m[CW] > 0.9 && m[WW] < 0.1, "{m:?}");
        assert!(m[R] < 0.05 && m[G] < 0.05 && m[B] < 0.05);
        let emitted = mx.emitted_rgb(&m);
        assert!(emitted.iter().all(|v| *v > 0.9), "6500K 应接近白：{emitted:?}");
    }

    #[test]
    fn 琥珀从红绿余量里提取() {
        let mx = mixer(Driven { amber: slot(3), ..rgb_fixture() });
        let a = Emitters::default().vectors[AMBER];
        let m = mx.mix(&rgb_req(a), 1.0);
        assert!(near(m[AMBER], 1.0));
        assert!(m[R] < 1e-6 && m[G] < 1e-6);
        // 不经琥珀能表达的蓝色保留在蓝通道
        let m = mx.mix(&rgb_req([0.0, 0.0, 1.0]), 1.0);
        assert!(near(m[B], 1.0) && near(m[AMBER], 0.0));
    }

    #[test]
    fn 仅冷暖白_红蓝比例与色温插值() {
        let mx = mixer(Driven { cool: slot(0), warm: slot(1), ..Driven::default() });
        let red = mx.mix(&rgb_req([1.0, 0.0, 0.0]), 1.0);
        assert!(near(red[WW], 1.0) && near(red[CW], 0.0));
        let blue = mx.mix(&rgb_req([0.0, 0.0, 1.0]), 1.0);
        assert!(near(blue[CW], 1.0) && near(blue[WW], 0.0));
        let both = mx.mix(&rgb_req([1.0, 0.0, 1.0]), 0.5);
        assert!(near(both[CW], 0.5) && near(both[WW], 0.5));

        // 色温：两端分别全冷 / 全暖，中点 mired 处两路都满（最大输出）
        let cool = mx.mix(&ColorRequest::Kelvin(6500.0), 1.0);
        assert!(near(cool[CW], 1.0) && near(cool[WW], 0.0));
        let warm = mx.mix(&ColorRequest::Kelvin(3000.0), 1.0);
        assert!(near(warm[CW], 0.0) && near(warm[WW], 1.0));
        let mid_k = 1e6 / f64::midpoint(1e6 / 6500.0, 1e6 / 3000.0);
        let mid = mx.mix(&ColorRequest::Kelvin(mid_k), 1.0);
        assert!(near(mid[CW], 1.0) && near(mid[WW], 1.0));
    }

    #[test]
    fn 恒定亮度模式两路之和为一() {
        let (c, w) = split_cct(0.25, CctMode::ConstantSum);
        assert!(near(c + w, 1.0) && near(w, 0.25));
        let (c, w) = split_cct(0.25, CctMode::MaxOutput);
        assert!(near(c, 1.0) && near(w, 0.5));
    }

    #[test]
    fn 仅调光灯用峰值和级别_开关灯有光即开() {
        let dim = mixer(Driven { dimmer: slot(0), ..Driven::default() });
        assert!(near(dim.mix(&rgb_req([0.2, 0.8, 0.4]), 0.5)[DIM], 0.4));
        let sw = mixer(Driven { switch: slot(0), ..Driven::default() });
        assert!(near(sw.mix(&rgb_req([0.0, 0.0, 0.01]), 0.5)[SW], 1.0));
        assert!(near(sw.mix(&rgb_req([0.0, 0.0, 0.0]), 1.0)[SW], 0.0));
    }

    #[test]
    fn 按发光体直给只保留灯具具备的分量() {
        let mx = mixer(Driven { white: slot(3), ..rgb_fixture() });
        let mut v = [0.0; EMITTERS];
        v[R] = 0.3;
        v[W] = 0.7;
        v[AMBER] = 1.0; // 灯具没有琥珀
        let m = mx.mix(&ColorRequest::Manual(v), 1.0);
        assert!(near(m[R], 0.3) && near(m[W], 0.7) && near(m[AMBER], 0.0));
    }

    #[test]
    fn 靛蓝只由手动直给驱动_rgb_意图不分配() {
        let mx = mixer(Driven { indigo: slot(3), ..rgb_fixture() });
        let blue = mx.mix(&rgb_req([0.0, 0.0, 1.0]), 1.0);
        assert!(near(blue[B], 1.0) && near(blue[INDIGO], 0.0));
        let mut v = [0.0; EMITTERS];
        v[INDIGO] = 0.8;
        let m = mx.mix(&ColorRequest::Manual(v), 1.0);
        assert!(near(m[INDIGO], 0.8));
        let rgb = mx.emitted_rgb(&m);
        assert!(rgb[2] > rgb[0] && rgb[1] < 1e-9, "靛蓝预览应偏蓝紫：{rgb:?}");
    }

    #[test]
    fn 色温换算() {
        let white = kelvin_to_linear(6600.0);
        assert!(white.iter().all(|v| *v > 0.97));
        let warm = kelvin_to_linear(2000.0);
        assert!(near(warm[0], 1.0) && warm[2] < 0.05);
        let cold = kelvin_to_linear(15000.0);
        assert!(near(cold[2], 1.0) && cold[0] < 0.8);
        assert!(near(linear_to_srgb(srgb_to_linear(0.42)), 0.42));
    }

    #[test]
    fn 发光体校准来自物模型() {
        use crate::fixture::Emitter;
        let model = FixtureModel {
            emitters: vec![
                Emitter { function: ChannelFunction::WarmWhite, kelvin: Some(2700), intensity: 1.0, rgb: None },
                Emitter { function: ChannelFunction::White, rgb: Some([255, 255, 255]), intensity: 0.5, kelvin: None },
            ],
            ..FixtureModel::default()
        };
        let e = Emitters::from_model(&model, 2.0);
        assert!(near(e.warm_kelvin, 2700.0));
        assert!(near(e.vectors[W][0], 0.5));
        assert_eq!(e.vectors[WW], kelvin_to_output(2700.0, 2.0));
    }

    /// 同一个显示色无论写成意图 RGB、色温，还是发光体校准，都按同一个 Gamma 解码：
    /// 意图正好等于校准过的白光颜色时，全部由白光给出（任意 Gamma）。
    #[test]
    fn 意图与校准用同一个_gamma_解码() {
        use crate::fixture::Emitter;
        for gamma in [1.0, 2.0, 2.2, 2.8] {
            let model = FixtureModel {
                emitters: vec![Emitter { function: ChannelFunction::White, rgb: Some([255, 230, 200]), intensity: 1.0, kelvin: None }],
                ..FixtureModel::default()
            };
            let mx = ColorMixer::for_fixture(&Driven { white: slot(3), ..rgb_fixture() }, Emitters::from_model(&model, gamma));
            let target = [255.0, 230.0, 200.0].map(|v: f64| apply_gamma(v / 255.0, gamma));
            let m = mx.mix(&rgb_req(target), 1.0);
            assert!(near(m[W], 1.0) && m[R] < 1e-6 && m[G] < 1e-6 && m[B] < 1e-6, "gamma={gamma} {m:?}");
            // 色温意图：线性输出就是色温显示色按 Gamma 解码
            let k = ColorMixer::for_fixture(&rgb_fixture(), Emitters::with_gamma(gamma)).mix(&ColorRequest::Kelvin(3200.0), 1.0);
            let want = kelvin_to_output(3200.0, gamma);
            assert!(near(k[R], want[0]) && near(k[G], want[1]) && near(k[B], want[2]), "gamma={gamma} {k:?}");
        }
    }

    #[test]
    fn 实际输出颜色_rgbw() {
        let mx = mixer(Driven { white: slot(3), ..rgb_fixture() });
        let target = [1.0, 0.6, 0.2];
        let m = mx.mix(&rgb_req(target), 1.0);
        let out = mx.emitted_rgb(&m);
        for c in 0..3 {
            assert!(near(out[c], target[c]), "{out:?}");
        }
    }
}
