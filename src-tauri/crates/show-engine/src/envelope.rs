//! 缓动曲线、Cue 淡入淡出包络与 Gamma。
//!
//! 这些公式在前端 `lib/color.ts` 里有一份镜像（仅用于预览色块），两边共用
//! `src/features/show-editor/lib/__tests__/golden/` 下的黄金向量保证一致。

use crate::project::{CueBase, Easing};

/// 把进度 `x` 映射到缓动曲线上。
///
/// # Arguments
///
/// * `easing` - 缓动曲线。
/// * `x` - 线性进度，超出 `0..=1` 时先被夹取。
///
/// # Returns
///
/// 曲线上的值，范围 `0..=1`：线性为 `x`，`EaseInOut` 为三次缓入缓出，`SCurve` 为 smoothstep。
#[must_use]
pub fn ease(easing: Easing, x: f64) -> f64 {
    let x = if x.is_nan() { 0.0 } else { x.clamp(0.0, 1.0) };
    match easing {
        Easing::Linear => x,
        Easing::EaseInOut => {
            if x < 0.5 {
                4.0 * x * x * x
            } else {
                let k = -2.0 * x + 2.0;
                1.0 - k * k * k / 2.0
            }
        }
        Easing::SCurve => x * x * (3.0 - 2.0 * x),
    }
}

/// 计算 Cue 在时刻 `t_ms` 的淡入淡出包络。
///
/// 起点之后 `fade_in_ms` 内从 0 缓动到 1，终点之前 `fade_out_ms` 内从 1 缓动到 0；
/// 两段重叠时取较小者。Cue 的有效区间为 `[start_ms, end_ms)`。
///
/// # Arguments
///
/// * `base` - Cue 的公共字段。
/// * `t_ms` - 时刻（毫秒）。
///
/// # Returns
///
/// 包络值 `0..=1`；`t_ms` 不在 Cue 区间内时为 0。
#[must_use]
pub fn envelope(base: &CueBase, t_ms: i64) -> f64 {
    if t_ms < base.start_ms || t_ms >= base.end_ms {
        return 0.0;
    }
    let up = if base.fade_in_ms > 0 {
        ease(base.easing, (t_ms - base.start_ms) as f64 / base.fade_in_ms as f64)
    } else {
        1.0
    };
    let down = if base.fade_out_ms > 0 {
        ease(base.easing, (base.end_ms - t_ms) as f64 / base.fade_out_ms as f64)
    } else {
        1.0
    };
    up.min(down)
}

/// 规整 Gamma：非有限或非正数按线性（1.0）处理，并限制在 `0.1..=5.0`。
///
/// # Arguments
///
/// * `gamma` - 工程里配置的 Gamma。
///
/// # Returns
///
/// 可安全用于 `powf` 的 Gamma。
#[must_use]
pub fn sanitize_gamma(gamma: f64) -> f64 {
    if gamma.is_finite() && gamma > 0.0 {
        gamma.clamp(0.1, 5.0)
    } else {
        1.0
    }
}

/// 对 `0..=1` 的线性亮度分数应用 Gamma。
///
/// # Arguments
///
/// * `v` - 线性亮度分数，超出范围时先被夹取。
/// * `gamma` - 已规整的 Gamma（见 [`sanitize_gamma`]）；`1.0` 时原样返回。
///
/// # Returns
///
/// `v.powf(gamma)`，范围 `0..=1`。
#[must_use]
pub fn apply_gamma(v: f64, gamma: f64) -> f64 {
    let v = v.clamp(0.0, 1.0);
    if (gamma - 1.0).abs() < f64::EPSILON {
        v
    } else {
        v.powf(gamma)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(start: i64, end: i64, fade_in: i64, fade_out: i64, easing: Easing) -> CueBase {
        CueBase {
            id: "c".into(),
            track_id: "t".into(),
            start_ms: start,
            end_ms: end,
            brightness: 100.0,
            fade_in_ms: fade_in,
            fade_out_ms: fade_out,
            easing,
            disabled: false,
        }
    }

    #[test]
    fn 缓动端点与中点() {
        for e in [Easing::Linear, Easing::EaseInOut, Easing::SCurve] {
            assert!(ease(e, 0.0).abs() < 1e-12);
            assert!((ease(e, 1.0) - 1.0).abs() < 1e-12);
            assert!((ease(e, 0.5) - 0.5).abs() < 1e-12);
        }
        assert!((ease(Easing::EaseInOut, 0.25) - 0.0625).abs() < 1e-12);
        assert!((ease(Easing::SCurve, 0.25) - 0.15625).abs() < 1e-12);
    }

    #[test]
    fn 缓动夹取越界与_nan() {
        assert!(ease(Easing::Linear, -1.0).abs() < 1e-12);
        assert!((ease(Easing::SCurve, 7.0) - 1.0).abs() < 1e-12);
        assert!(ease(Easing::Linear, f64::NAN).abs() < 1e-12);
    }

    #[test]
    fn 包络区间半开且无淡变时为_1() {
        let b = base(100, 200, 0, 0, Easing::Linear);
        assert!(envelope(&b, 99).abs() < 1e-12);
        assert!((envelope(&b, 100) - 1.0).abs() < 1e-12);
        assert!((envelope(&b, 199) - 1.0).abs() < 1e-12);
        assert!(envelope(&b, 200).abs() < 1e-12);
    }

    #[test]
    fn 淡入淡出线性() {
        let b = base(0, 1000, 200, 400, Easing::Linear);
        assert!(envelope(&b, 0).abs() < 1e-12);
        assert!((envelope(&b, 100) - 0.5).abs() < 1e-12);
        assert!((envelope(&b, 500) - 1.0).abs() < 1e-12);
        assert!((envelope(&b, 800) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn 淡入淡出重叠取较小者() {
        let b = base(0, 1000, 800, 800, Easing::Linear);
        // t=500：淡入 0.625，淡出 0.625；t=200：淡入 0.25，淡出 1。
        assert!((envelope(&b, 500) - 0.625).abs() < 1e-12);
        assert!((envelope(&b, 200) - 0.25).abs() < 1e-12);
    }

    #[test]
    fn gamma_规整与应用() {
        assert!((sanitize_gamma(f64::NAN) - 1.0).abs() < 1e-12);
        assert!((sanitize_gamma(-2.0) - 1.0).abs() < 1e-12);
        assert!((sanitize_gamma(99.0) - 5.0).abs() < 1e-12);
        assert!((apply_gamma(0.5, 1.0) - 0.5).abs() < 1e-12);
        assert!((apply_gamma(0.5, 2.0) - 0.25).abs() < 1e-12);
        assert!((apply_gamma(2.0, 2.0) - 1.0).abs() < 1e-12);
    }
}
