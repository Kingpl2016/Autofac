//! 15 种测试图案的确定性渲染。
//!
//! 所有图案都是"相位 → 512 通道"的纯函数：相位 `phase_ms` 由 [`Clock`] 按"经过时间 × 速度"累加得到，
//! 因此调速时画面连续、不跳变；随机图案用以（Universe 序号, 时间槽）为种子的伪随机数，
//! 同一输入永远得到同一输出，便于测试。

#![allow(clippy::cast_sign_loss, clippy::cast_precision_loss)]

use serde::{Deserialize, Serialize};

/// 一个 Universe 的通道数。
pub const CHANNELS: usize = 512;

/// 速度下限（倍速）。
pub const MIN_SPEED: f64 = 0.25;
/// 速度上限（倍速）。
pub const MAX_SPEED: f64 = 4.0;
/// 界面提供的速度档位（倍速）。
pub const SPEED_STEPS: [f64; 5] = [0.25, 0.5, 1.0, 2.0, 4.0];

/// 正弦 / 方波 / 三角 / 斜坡 / 脉冲的周期（毫秒）。
const PERIOD_WAVE_MS: f64 = 2000.0;
/// 追逐扫完 512 通道的时间（毫秒）。
const PERIOD_CHASE_MS: f64 = 4000.0;
/// 彩虹一个色相周期（毫秒）。
const PERIOD_RAINBOW_MS: f64 = 3000.0;
/// 奇偶交替一个周期（毫秒）。
const PERIOD_ODD_EVEN_MS: f64 = 1000.0;
/// 频闪一个周期（毫秒）。
const PERIOD_STROBE_MS: f64 = 200.0;
/// 随机图案每隔多久换一组数据（毫秒）。
const RANDOM_SLOT_MS: f64 = 500.0;
/// 二进制计数每隔多久加一（毫秒）。
const BINARY_STEP_MS: f64 = 100.0;
/// 二进制计数使用的位数（映射到前 16 个通道）。
const BINARY_BITS: usize = 16;
/// 彩虹在相邻 Universe 之间的相位差（占一个周期的比例）。
const RAINBOW_UNIVERSE_SHIFT: f64 = 0.3;

/// 图案分组（界面按分组排布）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PatternGroup {
    /// 基础：全亮、全黑、渐变。
    Basic,
    /// 波形：正弦、方波、三角、斜坡、脉冲。
    Wave,
    /// 扫描：追逐、彩虹、奇偶、二进制计数。
    Sweep,
    /// 压力：随机、频闪。
    Stress,
}

/// 测试图案标识（序列化为 kebab-case，如 `"ramp-up"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PatternId {
    /// 全部通道 255。
    FullOn,
    /// 全部通道 0。
    Blackout,
    /// 静态渐变：ch1 = 0 到 ch512 = 255。
    Gradient,
    /// 正弦波，周期 2 秒，全通道同值。
    Sine,
    /// 方波，1 秒全亮 1 秒全黑。
    Square,
    /// 三角波，周期 2 秒。
    Triangle,
    /// 上升斜坡：0 到 255 线性上升后瞬间复位，周期 2 秒。
    RampUp,
    /// 下降斜坡：255 到 0 线性下降后瞬间复位，周期 2 秒。
    RampDown,
    /// 脉冲：瞬间全亮后指数衰减，周期 2 秒。
    Pulse,
    /// 追逐：9 通道宽的渐变亮点，4 秒扫完 512 通道。
    Chase,
    /// 彩虹：每 3 通道一组 RGB，色相随时间旋转，相邻 Universe 相位错开。
    Rainbow,
    /// 奇偶交替：奇数号与偶数号通道每 500 毫秒交替点亮。
    OddEven,
    /// 二进制计数：计数值的低 16 位映射到 ch1 到 ch16。
    Binary,
    /// 随机：每 500 毫秒换一组随机值，每个 Universe 独立。
    Random,
    /// 频闪：100 毫秒全亮 100 毫秒全黑。
    Strobe,
}

impl PatternId {
    /// 全部图案，按界面分组顺序排列。
    pub const ALL: [PatternId; 15] = [
        PatternId::FullOn,
        PatternId::Blackout,
        PatternId::Gradient,
        PatternId::Sine,
        PatternId::Square,
        PatternId::Triangle,
        PatternId::RampUp,
        PatternId::RampDown,
        PatternId::Pulse,
        PatternId::Chase,
        PatternId::Rainbow,
        PatternId::OddEven,
        PatternId::Binary,
        PatternId::Random,
        PatternId::Strobe,
    ];

    /// 所属分组。
    ///
    /// # Returns
    ///
    /// 该图案在界面上归属的 [`PatternGroup`]。
    #[must_use]
    pub fn group(self) -> PatternGroup {
        match self {
            PatternId::FullOn | PatternId::Blackout | PatternId::Gradient => PatternGroup::Basic,
            PatternId::Sine
            | PatternId::Square
            | PatternId::Triangle
            | PatternId::RampUp
            | PatternId::RampDown
            | PatternId::Pulse => PatternGroup::Wave,
            PatternId::Chase | PatternId::Rainbow | PatternId::OddEven | PatternId::Binary => {
                PatternGroup::Sweep
            }
            PatternId::Random | PatternId::Strobe => PatternGroup::Stress,
        }
    }

    /// 是否为静态图案（输出与时间无关，速度控件对它无效）。
    ///
    /// # Returns
    ///
    /// 全亮、全黑、渐变返回 `true`，其余返回 `false`。
    #[must_use]
    pub fn is_static(self) -> bool {
        matches!(
            self,
            PatternId::FullOn | PatternId::Blackout | PatternId::Gradient
        )
    }

    /// 是否会产生高频明暗闪烁（界面据此给出光敏风险提示）。
    ///
    /// # Returns
    ///
    /// 只有 [`PatternId::Strobe`]（默认 5Hz 的全通道明暗切换）返回 `true`。
    #[must_use]
    pub fn is_flashing(self) -> bool {
        matches!(self, PatternId::Strobe)
    }
}

/// 图案元数据（供界面渲染分组与禁用速度控件；文案由前端按 `id` 本地化）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternInfo {
    /// 图案标识。
    pub id: PatternId,
    /// 所属分组。
    pub group: PatternGroup,
    /// 是否为静态图案。
    pub is_static: bool,
    /// 是否会高频闪烁。
    pub is_flashing: bool,
}

/// 列出全部图案的元数据。
///
/// # Returns
///
/// 按界面分组顺序排列的 15 项 [`PatternInfo`]。
#[must_use]
pub fn all_patterns() -> Vec<PatternInfo> {
    PatternId::ALL
        .iter()
        .map(|&id| PatternInfo {
            id,
            group: id.group(),
            is_static: id.is_static(),
            is_flashing: id.is_flashing(),
        })
        .collect()
}

/// 把速度限制在 [`MIN_SPEED`, `MAX_SPEED`]。
///
/// # Arguments
///
/// * `speed` - 请求的倍速。
///
/// # Returns
///
/// 夹紧后的倍速；`NaN` 与无穷大回落为 `1.0`。
#[must_use]
pub fn clamp_speed(speed: f64) -> f64 {
    if speed.is_finite() {
        speed.clamp(MIN_SPEED, MAX_SPEED)
    } else {
        1.0
    }
}

/// 相位时钟：把"经过的真实时间 × 速度"累加成图案相位。
///
/// 相位只在 [`Clock::advance`] 时增长，因此运行中改速度不会让当前相位跳变。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Clock {
    phase_ms: f64,
}

impl Clock {
    /// 创建从 0 开始的时钟。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前相位（毫秒）。
    ///
    /// # Returns
    ///
    /// 自开始（或上次重置）以来按速度累加的毫秒数。
    #[must_use]
    pub fn phase_ms(&self) -> f64 {
        self.phase_ms
    }

    /// 推进时钟。
    ///
    /// # Arguments
    ///
    /// * `dt_ms` - 本次经过的真实时间（毫秒）；负数与非有限值按 0 处理。
    /// * `speed` - 这段时间内的倍速，经 [`clamp_speed`] 夹紧。
    pub fn advance(&mut self, dt_ms: f64, speed: f64) {
        let dt = if dt_ms.is_finite() { dt_ms.max(0.0) } else { 0.0 };
        self.phase_ms += dt * clamp_speed(speed);
    }

    /// 重置相位为 0。
    pub fn reset(&mut self) {
        self.phase_ms = 0.0;
    }
}

/// 渲染一个 Universe 的 512 通道。
///
/// # Arguments
///
/// * `pattern` - 要渲染的图案。
/// * `phase_ms` - 图案相位（毫秒，通常来自 [`Clock::phase_ms`]）；负数按周期回绕，
///   非有限值按 0 处理。
/// * `universe_index` - 该 Universe 在本次发送范围内的序号（从 0 起）。只有彩虹（相位错开）
///   与随机（独立种子）会用到它，其余图案对所有 Universe 输出相同。
///
/// # Returns
///
/// 512 个通道值。
#[must_use]
pub fn render(pattern: PatternId, phase_ms: f64, universe_index: usize) -> [u8; CHANNELS] {
    let phase = if phase_ms.is_finite() { phase_ms } else { 0.0 };
    let mut out = [0u8; CHANNELS];
    match pattern {
        PatternId::FullOn => out.fill(255),
        PatternId::Blackout => {}
        PatternId::Gradient => {
            for (i, v) in out.iter_mut().enumerate() {
                *v = level(i as f64 / (CHANNELS - 1) as f64 * 255.0);
            }
        }
        PatternId::Sine => {
            let t = fraction(phase, PERIOD_WAVE_MS);
            out.fill(level((std::f64::consts::TAU * t).sin().midpoint(1.0) * 255.0));
        }
        PatternId::Square => {
            let on = phase.rem_euclid(PERIOD_WAVE_MS) < PERIOD_WAVE_MS / 2.0;
            out.fill(if on { 255 } else { 0 });
        }
        PatternId::Triangle => {
            let t = fraction(phase, PERIOD_WAVE_MS);
            let v = if t < 0.5 { t * 2.0 } else { (1.0 - t) * 2.0 };
            out.fill(level(v * 255.0));
        }
        PatternId::RampUp => out.fill(level(fraction(phase, PERIOD_WAVE_MS) * 255.0)),
        PatternId::RampDown => out.fill(level((1.0 - fraction(phase, PERIOD_WAVE_MS)) * 255.0)),
        PatternId::Pulse => {
            let t = fraction(phase, PERIOD_WAVE_MS);
            out.fill(level(255.0 * (-5.0 * t).exp()));
        }
        PatternId::Chase => render_chase(&mut out, phase),
        PatternId::Rainbow => render_rainbow(&mut out, phase, universe_index),
        PatternId::OddEven => {
            // 第一半周期点亮奇数号通道（ch1、ch3…，即下标 0、2…），第二半周期点亮偶数号通道
            let first_half = phase.rem_euclid(PERIOD_ODD_EVEN_MS) < PERIOD_ODD_EVEN_MS / 2.0;
            for (i, v) in out.iter_mut().enumerate() {
                let odd_numbered = i % 2 == 0;
                *v = if odd_numbered == first_half { 255 } else { 0 };
            }
        }
        PatternId::Binary => {
            let counter = (phase.max(0.0) / BINARY_STEP_MS).floor() as u64;
            for (bit, v) in out.iter_mut().take(BINARY_BITS).enumerate() {
                *v = if (counter >> bit) & 1 == 1 { 255 } else { 0 };
            }
        }
        PatternId::Random => {
            let slot = (phase.max(0.0) / RANDOM_SLOT_MS).floor() as u64;
            let mut rng = SplitMix64::new(mix_seed(universe_index as u64, slot));
            for v in &mut out {
                *v = (rng.next() >> 56) as u8;
            }
        }
        PatternId::Strobe => {
            let on = phase.rem_euclid(PERIOD_STROBE_MS) < PERIOD_STROBE_MS / 2.0;
            out.fill(if on { 255 } else { 0 });
        }
    }
    out
}

/// 追逐：一个 9 通道宽、两侧线性变暗的亮点，从 ch1 扫到 ch512。
fn render_chase(out: &mut [u8; CHANNELS], phase: f64) {
    let t = fraction(phase, PERIOD_CHASE_MS);
    let active = ((t * CHANNELS as f64).floor() as usize).min(CHANNELS - 1);
    for offset in -4isize..=4 {
        let Some(ch) = active.checked_add_signed(offset) else {
            continue;
        };
        if ch < CHANNELS {
            let falloff = 1.0 - offset.unsigned_abs() as f64 / 5.0;
            out[ch] = level(255.0 * falloff);
        }
    }
}

/// 彩虹：每 3 个通道一组 RGB，色相沿通道排布并随时间旋转；相邻 Universe 相位错开。
fn render_rainbow(out: &mut [u8; CHANNELS], phase: f64, universe_index: usize) {
    let base = (fraction(phase, PERIOD_RAINBOW_MS) + universe_index as f64 * RAINBOW_UNIVERSE_SHIFT)
        .rem_euclid(1.0);
    for group in 0..CHANNELS / 3 {
        let start = group * 3;
        let hue = (base + start as f64 / CHANNELS as f64).rem_euclid(1.0) * 360.0;
        let (r, g, b) = hue_to_rgb(hue);
        out[start] = r;
        out[start + 1] = g;
        out[start + 2] = b;
    }
}

/// 饱和度 100%、明度 50% 的色相（度）转 RGB。
fn hue_to_rgb(hue: f64) -> (u8, u8, u8) {
    let sector = hue / 60.0;
    let x = 1.0 - (sector.rem_euclid(2.0) - 1.0).abs();
    let (r, g, b) = match sector as u32 {
        0 => (1.0, x, 0.0),
        1 => (x, 1.0, 0.0),
        2 => (0.0, 1.0, x),
        3 => (0.0, x, 1.0),
        4 => (x, 0.0, 1.0),
        _ => (1.0, 0.0, x),
    };
    (level(r * 255.0), level(g * 255.0), level(b * 255.0))
}

/// 取相位在一个周期内的归一化位置，范围 `[0, 1)`。
fn fraction(phase_ms: f64, period_ms: f64) -> f64 {
    phase_ms.rem_euclid(period_ms) / period_ms
}

/// 四舍五入并夹紧到 `0..=255`。
fn level(v: f64) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

/// 把 Universe 序号与时间槽混合成随机种子。
fn mix_seed(universe_index: u64, slot: u64) -> u64 {
    universe_index
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(slot.wrapping_mul(0xD1B5_4A32_D192_ED03))
        .wrapping_add(0x2545_F491_4F6C_DD1D)
}

/// SplitMix64 伪随机数生成器：种子相同则序列相同，足够做"看起来随机"的测试数据。
struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp, clippy::naive_bytecount)] // 测试里要的就是精确值比较与简单计数
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn uniform(frame: &[u8; CHANNELS]) -> Option<u8> {
        let first = frame[0];
        frame.iter().all(|&v| v == first).then_some(first)
    }

    #[test]
    fn catalog_has_fifteen_unique_patterns_in_group_order() {
        assert_eq!(PatternId::ALL.len(), 15);
        let unique: HashSet<_> = PatternId::ALL.iter().collect();
        assert_eq!(unique.len(), 15);
        assert_eq!(all_patterns().len(), 15);

        // 同一分组的图案在 ALL 里连续排列，界面按顺序分组时不会出现重复标题
        let mut seen = Vec::new();
        for id in PatternId::ALL {
            let g = id.group();
            if seen.last() != Some(&g) {
                assert!(!seen.contains(&g), "分组 {g:?} 被拆开了");
                seen.push(g);
            }
        }
        assert_eq!(seen.len(), 4);
    }

    #[test]
    fn ids_serialize_as_kebab_case() {
        let json = |p: PatternId| serde_json::to_string(&p).unwrap();
        assert_eq!(json(PatternId::RampUp), "\"ramp-up\"");
        assert_eq!(json(PatternId::OddEven), "\"odd-even\"");
        assert_eq!(json(PatternId::FullOn), "\"full-on\"");
        assert_eq!(json(PatternId::Sine), "\"sine\"");
    }

    #[test]
    fn only_basic_patterns_are_static() {
        for id in PatternId::ALL {
            assert_eq!(id.is_static(), id.group() == PatternGroup::Basic, "{id:?}");
        }
        // 静态图案与相位、Universe 序号无关
        for id in [PatternId::FullOn, PatternId::Blackout, PatternId::Gradient] {
            assert_eq!(render(id, 0.0, 0), render(id, 1234.5, 7), "{id:?}");
        }
    }

    #[test]
    fn full_on_blackout_and_gradient() {
        assert_eq!(uniform(&render(PatternId::FullOn, 0.0, 0)), Some(255));
        assert_eq!(uniform(&render(PatternId::Blackout, 0.0, 0)), Some(0));

        let g = render(PatternId::Gradient, 0.0, 0);
        assert_eq!(g[0], 0);
        assert_eq!(g[511], 255);
        assert_eq!(g[255], 127);
        assert!(g.windows(2).all(|w| w[0] <= w[1]), "渐变应单调不减");
    }

    #[test]
    fn sine_hits_midpoint_peak_and_trough() {
        let at = |ms: f64| uniform(&render(PatternId::Sine, ms, 0)).unwrap();
        assert_eq!(at(0.0), 128); // sin(0)=0，(0+1)/2*255 = 127.5 → 128
        assert_eq!(at(500.0), 255);
        assert_eq!(at(1000.0), 128);
        assert_eq!(at(1500.0), 0);
        assert_eq!(at(2000.0), 128); // 周期回绕
    }

    #[test]
    fn square_flips_every_second() {
        let at = |ms: f64| uniform(&render(PatternId::Square, ms, 0)).unwrap();
        assert_eq!(at(0.0), 255);
        assert_eq!(at(999.0), 255);
        assert_eq!(at(1000.0), 0);
        assert_eq!(at(1999.0), 0);
        assert_eq!(at(2000.0), 255);
    }

    #[test]
    fn triangle_rises_then_falls() {
        let at = |ms: f64| uniform(&render(PatternId::Triangle, ms, 0)).unwrap();
        assert_eq!(at(0.0), 0);
        assert_eq!(at(500.0), 128);
        assert_eq!(at(1000.0), 255);
        assert_eq!(at(1500.0), 128);
        assert!(at(1999.0) <= 1);
    }

    #[test]
    fn ramps_are_mirror_images() {
        let up = |ms: f64| uniform(&render(PatternId::RampUp, ms, 0)).unwrap();
        let down = |ms: f64| uniform(&render(PatternId::RampDown, ms, 0)).unwrap();
        assert_eq!(up(0.0), 0);
        assert_eq!(up(1000.0), 128);
        assert!(up(1999.0) >= 254);
        assert_eq!(down(0.0), 255);
        assert_eq!(down(1000.0), 128);
        assert!(down(1999.0) <= 1);
        // 到周期末尾瞬间复位
        assert_eq!(up(2000.0), 0);
        assert_eq!(down(2000.0), 255);
    }

    #[test]
    fn pulse_flashes_then_decays_exponentially() {
        let at = |ms: f64| uniform(&render(PatternId::Pulse, ms, 0)).unwrap();
        assert_eq!(at(0.0), 255);
        assert_eq!(at(400.0), 94); // 255 * e^-1 = 93.8
        assert!(at(1999.0) <= 2);
        assert_eq!(at(2000.0), 255);
    }

    #[test]
    fn chase_is_a_nine_wide_fading_spot() {
        let f = render(PatternId::Chase, 0.0, 0);
        assert_eq!(&f[0..6], &[255, 204, 153, 102, 51, 0]);
        assert!(f[6..].iter().all(|&v| v == 0));

        // 扫到最后一个通道：右侧越界的部分被截断，不会写出数组
        let end = render(PatternId::Chase, 3999.0, 0);
        assert_eq!(end[511], 255);
        assert_eq!(&end[507..511], &[51, 102, 153, 204]);
        assert_eq!(end[506], 0);

        // 同一时刻只有 9 个通道非零
        let mid = render(PatternId::Chase, 2000.0, 0);
        assert_eq!(mid.iter().filter(|&&v| v > 0).count(), 9);
    }

    #[test]
    fn rainbow_starts_red_and_shifts_per_universe() {
        let u0 = render(PatternId::Rainbow, 0.0, 0);
        assert_eq!(&u0[0..3], &[255, 0, 0]);
        assert_eq!(&u0[3..6], &[255, 9, 0]); // 色相只前进了 3/512 圈
        // 512 不能被 3 整除，最后 2 个通道不属于任何 RGB 组
        assert_eq!(&u0[510..512], &[0, 0]);

        // 相邻 Universe 相位差 0.3 圈 = 108°
        let u1 = render(PatternId::Rainbow, 0.0, 1);
        assert_eq!(&u1[0..3], &[51, 255, 0]);
        assert_ne!(u0, u1);

        // 3 秒后回到同一画面
        assert_eq!(render(PatternId::Rainbow, 3000.0, 0), u0);
    }

    #[test]
    fn odd_even_alternates_every_half_second() {
        let a = render(PatternId::OddEven, 0.0, 0);
        assert_eq!((a[0], a[1], a[2], a[3]), (255, 0, 255, 0));
        let b = render(PatternId::OddEven, 500.0, 0);
        assert_eq!((b[0], b[1], b[2], b[3]), (0, 255, 0, 255));
        assert_eq!(render(PatternId::OddEven, 1000.0, 0), a);
        // 任意时刻恰好一半通道点亮
        assert_eq!(a.iter().filter(|&&v| v == 255).count(), 256);
    }

    #[test]
    fn binary_counts_in_the_first_sixteen_channels() {
        let bits = |ms: f64| {
            let f = render(PatternId::Binary, ms, 0);
            assert!(f[16..].iter().all(|&v| v == 0), "只有前 16 个通道参与");
            (0..16).map(|i| u32::from(f[i] == 255) << i).sum::<u32>()
        };
        assert_eq!(bits(0.0), 0);
        assert_eq!(bits(99.0), 0);
        assert_eq!(bits(100.0), 1);
        assert_eq!(bits(300.0), 3);
        assert_eq!(bits(500.0), 0b101);
        // 计数到 65536 时 16 位全部回零
        assert_eq!(bits(65_536.0 * BINARY_STEP_MS), 0);
        assert_eq!(bits(65_535.0 * BINARY_STEP_MS), 0xFFFF);
    }

    #[test]
    fn random_is_stable_within_a_slot_and_independent_per_universe() {
        let a = render(PatternId::Random, 0.0, 0);
        assert_eq!(render(PatternId::Random, 499.0, 0), a, "同一时间槽内数据不变");
        assert_ne!(render(PatternId::Random, 500.0, 0), a, "换槽后换一组");
        assert_ne!(render(PatternId::Random, 0.0, 1), a, "不同 Universe 数据不同");
        assert_eq!(render(PatternId::Random, 0.0, 0), a, "同一输入永远同一输出");
        // 数据确实"随机"：用到了大量不同的取值
        let distinct: HashSet<_> = a.iter().collect();
        assert!(distinct.len() > 100);
    }

    #[test]
    fn strobe_alternates_every_hundred_ms() {
        let at = |ms: f64| uniform(&render(PatternId::Strobe, ms, 0)).unwrap();
        assert_eq!(at(0.0), 255);
        assert_eq!(at(99.0), 255);
        assert_eq!(at(100.0), 0);
        assert_eq!(at(199.0), 0);
        assert_eq!(at(200.0), 255);
        assert!(PatternId::Strobe.is_flashing());
        assert!(!PatternId::Sine.is_flashing());
    }

    #[test]
    fn negative_and_non_finite_phases_are_safe() {
        for id in PatternId::ALL {
            let zero = render(id, 0.0, 0);
            assert_eq!(render(id, f64::NAN, 0), zero, "{id:?} NaN");
            assert_eq!(render(id, f64::INFINITY, 0), zero, "{id:?} inf");
            let _ = render(id, -123_456.7, 3); // 不 panic
        }
        // 负相位按周期回绕：-500ms 等价于 1500ms
        assert_eq!(
            render(PatternId::Sine, -500.0, 0),
            render(PatternId::Sine, 1500.0, 0)
        );
    }

    #[test]
    fn clock_accumulates_phase_with_speed() {
        let mut c = Clock::new();
        c.advance(500.0, 1.0);
        c.advance(500.0, 2.0);
        assert!((c.phase_ms() - 1500.0).abs() < 1e-9);
        c.reset();
        assert_eq!(c.phase_ms(), 0.0);
    }

    #[test]
    fn changing_speed_does_not_jump_the_phase() {
        let mut c = Clock::new();
        c.advance(1000.0, 1.0);
        let before = render(PatternId::Sine, c.phase_ms(), 0);
        // 改速度本身不动相位；只有之后的 advance 才按新速度走
        c.advance(0.0, 4.0);
        assert_eq!(render(PatternId::Sine, c.phase_ms(), 0), before);
        c.advance(10.0, 4.0);
        assert!((c.phase_ms() - 1040.0).abs() < 1e-9);
    }

    #[test]
    fn speed_is_clamped_and_bad_values_fall_back() {
        assert_eq!(clamp_speed(100.0), MAX_SPEED);
        assert_eq!(clamp_speed(0.0), MIN_SPEED);
        assert_eq!(clamp_speed(-3.0), MIN_SPEED);
        assert_eq!(clamp_speed(f64::NAN), 1.0);
        assert_eq!(clamp_speed(f64::INFINITY), 1.0);
        assert!(SPEED_STEPS.iter().all(|&s| clamp_speed(s) == s));

        let mut c = Clock::new();
        c.advance(f64::NAN, 1.0);
        c.advance(-100.0, 1.0);
        assert_eq!(c.phase_ms(), 0.0);
    }
}
