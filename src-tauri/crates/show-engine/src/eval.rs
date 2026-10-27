//! 求值：把 [`CompiledShow`] 在某个时刻渲染成各 Universe 的 DMX 帧。
//!
//! 渲染分三步：
//!
//! 1. 各轨道上处于活动状态的 Cue 按包络算出亮度级别，再把颜色映射到每台灯具的通道分数
//!    （见 [`map_color`]）；
//! 2. 多条轨道对同一灯具的结果按通道取最大值（HTP）；
//! 3. 应用 Gamma 后写入 DMX 帧；不受驱动的通道保持底图里的默认值。
//!
//! 特效 Cue 由 [`crate::effects`] 给出每台灯具的颜色与强度调制，再走同一套通道映射。

use crate::compile::{CompiledShow, DmxData, Driven};
use crate::effects;
use crate::envelope::{apply_gamma, envelope};
use crate::project::Cue;

const R: usize = 0;
const G: usize = 1;
const B: usize = 2;
const W: usize = 3;
const CW: usize = 4;
const WW: usize = 5;
const DIM: usize = 6;
const SW: usize = 7;

/// 向前回溯检查的 Cue 数：同一轨道的 Cue 不应重叠，这里仅作为对异常工程的容错。
const LOOKBACK: usize = 8;

/// 一个 Universe 的输出帧。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// Universe 编号。
    pub universe: u16,
    /// 512 个通道的值。
    pub data: DmxData,
}

/// 一次求值得到的所有 Universe 的帧，同时持有求值用的临时缓冲，可反复复用。
#[derive(Debug, Clone)]
pub struct FrameSet {
    /// 各 Universe 的帧，按 Universe 升序。
    pub frames: Vec<Frame>,
    acc: Vec<[f64; 8]>,
}

impl FrameSet {
    /// 各 Universe 的帧。
    ///
    /// # Returns
    ///
    /// 按 Universe 升序的帧切片。
    #[must_use]
    pub fn frames(&self) -> &[Frame] {
        &self.frames
    }
}

impl CompiledShow {
    /// 创建与本节目匹配的帧缓冲，内容为底图（黑场 + 默认值）。
    ///
    /// # Returns
    ///
    /// 可传给 [`CompiledShow::evaluate_into`] 反复复用的 [`FrameSet`]。
    #[must_use]
    pub fn new_frames(&self) -> FrameSet {
        FrameSet {
            frames: self
                .universes
                .iter()
                .zip(&self.base)
                .map(|(&universe, data)| Frame { universe, data: *data })
                .collect(),
            acc: vec![[0.0; 8]; self.fixtures.len()],
        }
    }

    /// 灯具是否已被编译（存在且未被跳过）。
    ///
    /// # Arguments
    ///
    /// * `fixture_id` - 灯具实例编号。
    ///
    /// # Returns
    ///
    /// 灯具会参与输出时为 `true`。
    #[must_use]
    pub fn has_fixture(&self, fixture_id: &str) -> bool {
        self.fixtures.iter().any(|f| f.id == fixture_id)
    }

    /// 渲染时刻 `t_ms` 的所有 Universe。
    ///
    /// # Arguments
    ///
    /// * `t_ms` - 节目时间（毫秒）。区间外没有活动 Cue，结果为黑场加默认值。
    /// * `out` - 由 [`CompiledShow::new_frames`] 创建的帧缓冲，原地覆盖。
    pub fn evaluate_into(&self, t_ms: i64, out: &mut FrameSet) {
        self.reset(out);
        for track in &self.tracks {
            let upper = track.cues.partition_point(|c| c.base().start_ms <= t_ms);
            let lower = upper.saturating_sub(LOOKBACK);
            for cue in &track.cues[lower..upper] {
                let env = envelope(cue.base(), t_ms);
                if env <= 0.0 {
                    continue;
                }
                let level = (cue.base().brightness / 100.0).clamp(0.0, 1.0) * env;
                match cue {
                    Cue::Static(c) => {
                        let rgb = [
                            f64::from(c.rgb[0]) / 255.0,
                            f64::from(c.rgb[1]) / 255.0,
                            f64::from(c.rgb[2]) / 255.0,
                        ];
                        for &fi in &track.fixtures {
                            let mapped = map_color(&self.fixtures[fi].driven, rgb, level);
                            merge_max(&mut out.acc[fi], &mapped);
                        }
                    }
                    Cue::Effect(e) => {
                        let (lo, hi) = (e.range[0].min(e.range[1]), e.range[0].max(e.range[1]));
                        let (lo, hi) = (lo.clamp(0.0, 100.0) / 100.0, hi.clamp(0.0, 100.0) / 100.0);
                        let elapsed = t_ms - e.base.start_ms;
                        let count = track.fixtures.len();
                        for (index, &fi) in track.fixtures.iter().enumerate() {
                            let s = effects::sample(e, self.tempo, elapsed, index, count);
                            let intensity = lo + (hi - lo) * s.modulation;
                            let mapped = map_color(&self.fixtures[fi].driven, s.rgb, level * intensity);
                            merge_max(&mut out.acc[fi], &mapped);
                        }
                    }
                }
            }
        }
        self.write_driven(out);
    }

    /// 渲染“定位”画面：只点亮指定灯具（满亮白光，其余通道为默认值），其余灯具黑场。
    ///
    /// 用于在 Patch 面板里确认某台灯具的实际位置。
    ///
    /// # Arguments
    ///
    /// * `fixture_id` - 灯具实例编号。
    /// * `out` - 由 [`CompiledShow::new_frames`] 创建的帧缓冲，原地覆盖。
    ///
    /// # Returns
    ///
    /// 灯具存在（已被编译）时为 `true`；否则 `false`，此时 `out` 为黑场。
    pub fn locate_into(&self, fixture_id: &str, out: &mut FrameSet) -> bool {
        self.reset(out);
        let Some(fi) = self.fixtures.iter().position(|f| f.id == fixture_id) else {
            return false;
        };
        let mapped = map_color(&self.fixtures[fi].driven, [1.0, 1.0, 1.0], 1.0);
        merge_max(&mut out.acc[fi], &mapped);
        self.write_driven(out);
        true
    }

    /// 渲染全黑画面（保留不受驱动通道的默认值）。
    ///
    /// # Arguments
    ///
    /// * `out` - 由 [`CompiledShow::new_frames`] 创建的帧缓冲，原地覆盖。
    pub fn blackout_into(&self, out: &mut FrameSet) {
        self.reset(out);
        self.write_driven(out);
    }

    fn reset(&self, out: &mut FrameSet) {
        // 帧缓冲应由本节目创建；防御性地处理形状不一致。
        if out.frames.len() != self.universes.len() || out.acc.len() != self.fixtures.len() {
            *out = self.new_frames();
        }
        for (frame, base) in out.frames.iter_mut().zip(&self.base) {
            frame.data = *base;
        }
        out.acc.fill([0.0; 8]);
    }

    fn write_driven(&self, out: &mut FrameSet) {
        for (fixture, acc) in self.fixtures.iter().zip(&out.acc) {
            let data = &mut out.frames[fixture.universe_index].data;
            let d = &fixture.driven;
            let g = self.gamma;
            let slots = [
                (d.red, R),
                (d.green, G),
                (d.blue, B),
                (d.white, W),
                (d.cool, CW),
                (d.warm, WW),
                (d.dimmer, DIM),
            ];
            for (slot, idx) in slots {
                if let Some(slot) = slot {
                    slot.write(data, apply_gamma(acc[idx], g));
                }
            }
            if let Some(slot) = d.switch {
                slot.write(data, acc[SW]);
            }
        }
    }
}

fn merge_max(acc: &mut [f64; 8], v: &[f64; 8]) {
    for (a, b) in acc.iter_mut().zip(v) {
        if *b > *a {
            *a = *b;
        }
    }
}

/// 把一个 RGB 颜色按灯具的通道配置映射为各通道的线性亮度分数。
///
/// 规则（所有分数均为 `0..=1`，未配置的通道恒为 0，Gamma 在写入时才应用）：
///
/// - 有 RGB：红绿蓝直接取颜色。灯具带白光或冷暖白通道时，取 `min(r,g,b)` 作为白光分量
///   并从 RGB 中扣除（冷暖白各得一份）。
/// - 只有冷暖白（无 RGB）：用 `B / (R + B)` 作为色温平衡 `t`，冷白 `min(1, 2t)`、
///   暖白 `min(1, 2(1-t))`，再乘以颜色峰值 `max(r,g,b)`。
/// - 只有白光：白光 = 峰值。
/// - 只有调光（或同时带有颜色通道）：有颜色通道时调光 = 级别，颜色通道不再乘级别；
///   没有任何颜色通道时调光 = 级别 × 峰值。
/// - 开关通道：只要可见亮度大于 0 就开。
///
/// # Arguments
///
/// * `driven` - 灯具被驱动的通道配置。
/// * `rgb` - 颜色分量，各 `0..=1`。
/// * `level` - 亮度级别（Cue 亮度 × 包络），`0..=1`。
///
/// # Returns
///
/// 八个分量依次为：红、绿、蓝、白、冷白、暖白、调光、开关。
#[must_use]
pub fn map_color(driven: &Driven, rgb: [f64; 3], level: f64) -> [f64; 8] {
    let [mut r, mut g, mut b] = rgb.map(|v| v.clamp(0.0, 1.0));
    let level = level.clamp(0.0, 1.0);
    let peak = r.max(g).max(b);
    let has_dimmer = driven.dimmer.is_some();
    let has_white = driven.white.is_some();
    let has_cct = driven.has_cct();
    // 有调光通道时亮度交给调光，颜色通道保持原值。
    let color_scale = if has_dimmer { 1.0 } else { level };
    let mut out = [0.0; 8];

    if driven.has_rgb() {
        let mut white = 0.0;
        if has_white || has_cct {
            white = r.min(g).min(b);
            r -= white;
            g -= white;
            b -= white;
        }
        out[R] = r * color_scale;
        out[G] = g * color_scale;
        out[B] = b * color_scale;
        if has_white {
            out[W] = white * color_scale;
        }
        if has_cct {
            out[CW] = white * color_scale;
            out[WW] = white * color_scale;
        }
        if has_dimmer {
            out[DIM] = level;
        }
    } else if has_cct {
        let total = r + b;
        let t = if total > 0.0 { b / total } else { 0.5 };
        let cool = (2.0 * t).min(1.0);
        let warm = (2.0 * (1.0 - t)).min(1.0);
        out[CW] = cool * peak * color_scale;
        out[WW] = warm * peak * color_scale;
        if has_white {
            out[W] = peak * color_scale;
        }
        if has_dimmer {
            out[DIM] = level;
        }
    } else if has_white {
        out[W] = peak * color_scale;
        if has_dimmer {
            out[DIM] = level;
        }
    } else if has_dimmer {
        out[DIM] = level * peak;
    }

    if driven.switch.is_some() && level * peak > 0.0 {
        out[SW] = 1.0;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::{compile, Slot};
    use crate::fixture::{ChannelFunction, FixtureModel, FixtureProperty};
    use crate::project::{
        CueBase, Easing, FixtureInstance, ShowProject, StaticCue, Track, TrackTarget,
    };

    #[allow(clippy::unnecessary_wraps)]
    fn slot(offset: u16) -> Option<Slot> {
        Some(Slot { offset, width: 1, big_endian: true })
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn rgb_按级别缩放() {
        let d = Driven { red: slot(0), green: slot(1), blue: slot(2), ..Driven::default() };
        let m = map_color(&d, [1.0, 0.5, 0.0], 0.5);
        assert!(near(m[R], 0.5) && near(m[G], 0.25) && near(m[B], 0.0));
        assert!(near(m[DIM], 0.0));
    }

    #[test]
    fn 带调光通道时颜色不缩放() {
        let d = Driven {
            red: slot(0),
            green: slot(1),
            blue: slot(2),
            dimmer: slot(3),
            ..Driven::default()
        };
        let m = map_color(&d, [1.0, 0.5, 0.0], 0.5);
        assert!(near(m[R], 1.0) && near(m[G], 0.5));
        assert!(near(m[DIM], 0.5));
    }

    #[test]
    fn rgbw_提取白光() {
        let d = Driven {
            red: slot(0),
            green: slot(1),
            blue: slot(2),
            white: slot(3),
            ..Driven::default()
        };
        let m = map_color(&d, [1.0, 0.6, 0.2], 1.0);
        assert!(near(m[W], 0.2));
        assert!(near(m[R], 0.8) && near(m[G], 0.4) && near(m[B], 0.0));
    }

    #[test]
    fn rgbcw_冷暖白各得一份() {
        let d = Driven {
            red: slot(0),
            green: slot(1),
            blue: slot(2),
            cool: slot(3),
            warm: slot(4),
            ..Driven::default()
        };
        let m = map_color(&d, [0.5, 0.5, 0.5], 1.0);
        assert!(near(m[CW], 0.5) && near(m[WW], 0.5));
        assert!(near(m[R], 0.0));
    }

    #[test]
    fn 色温灯按红蓝比例分配冷暖() {
        let d = Driven { cool: slot(0), warm: slot(1), ..Driven::default() };
        // 纯红 → 暖；纯蓝 → 冷；红蓝相等 → 都满。
        let warm = map_color(&d, [1.0, 0.0, 0.0], 1.0);
        assert!(near(warm[CW], 0.0) && near(warm[WW], 1.0));
        let cool = map_color(&d, [0.0, 0.0, 1.0], 1.0);
        assert!(near(cool[CW], 1.0) && near(cool[WW], 0.0));
        let mid = map_color(&d, [1.0, 0.0, 1.0], 0.5);
        assert!(near(mid[CW], 0.5) && near(mid[WW], 0.5));
        // 黑色：峰值为 0，全灭。
        let black = map_color(&d, [0.0, 0.0, 0.0], 1.0);
        assert!(near(black[CW], 0.0) && near(black[WW], 0.0));
    }

    #[test]
    fn 仅调光灯用峰值和级别() {
        let d = Driven { dimmer: slot(0), ..Driven::default() };
        let m = map_color(&d, [0.2, 0.8, 0.4], 0.5);
        assert!(near(m[DIM], 0.4));
    }

    #[test]
    fn 开关灯有亮度就开() {
        let d = Driven { switch: slot(0), ..Driven::default() };
        assert!(near(map_color(&d, [0.0, 0.0, 0.01], 0.5)[SW], 1.0));
        assert!(near(map_color(&d, [0.0, 0.0, 0.0], 1.0)[SW], 0.0));
        assert!(near(map_color(&d, [1.0, 1.0, 1.0], 0.0)[SW], 0.0));
    }

    fn model(id: &str, functions: &[ChannelFunction]) -> FixtureModel {
        FixtureModel {
            id: id.into(),
            name: id.into(),
            system: String::new(),
            product_type: String::new(),
            builtin: false,
            properties: functions
                .iter()
                .enumerate()
                .map(|(i, f)| FixtureProperty {
                    name: format!("{f:?}"),
                    code: format!("P{i}"),
                    function: *f,
                    channel: (i + 1) as u16,
                    width: 1,
                    big_endian: true,
                    default_value: 0,
                    value_desc: String::new(),
                    description: String::new(),
                })
                .collect(),
        }
    }

    fn cue(track: &str, start: i64, end: i64, rgb: [u8; 3], brightness: f64) -> Cue {
        Cue::Static(StaticCue {
            base: CueBase {
                id: format!("{track}-{start}"),
                track_id: track.into(),
                start_ms: start,
                end_ms: end,
                brightness,
                fade_in_ms: 0,
                fade_out_ms: 0,
                easing: Easing::Linear,
            },
            rgb,
        })
    }

    /// 两台 RGB 灯（f0 在 Universe 0 地址 1，f1 在 Universe 2 地址 10）。
    fn rig() -> ShowProject {
        use ChannelFunction::{Blue, Green, Red};
        let mut p: ShowProject = serde_json::from_str(r#"{"durationMs":10000}"#).unwrap();
        p.output.gamma = 1.0;
        p.fixture_models.push(model("m", &[Red, Green, Blue]));
        for (i, (u, a)) in [(0u16, 1u16), (2, 10)].into_iter().enumerate() {
            p.fixtures.push(FixtureInstance {
                id: format!("f{i}"),
                name: String::new(),
                model_id: "m".into(),
                universe: u,
                address: a,
            });
            p.tracks.push(Track {
                id: format!("t{i}"),
                target: TrackTarget::Fixture { id: format!("f{i}") },
                mute: false,
                solo: false,
            });
        }
        p
    }

    fn frame_at(set: &FrameSet, universe: u16) -> &DmxData {
        &set.frames.iter().find(|f| f.universe == universe).expect("应有该 Universe").data
    }

    #[test]
    fn 静态_cue_在区间内输出颜色_区间外黑场() {
        let mut p = rig();
        p.cues.push(cue("t0", 1000, 2000, [255, 128, 0], 100.0));
        let c = compile(&p);
        let mut set = c.new_frames();
        c.evaluate_into(500, &mut set);
        assert_eq!(&frame_at(&set, 0)[0..3], &[0, 0, 0]);
        c.evaluate_into(1500, &mut set);
        assert_eq!(&frame_at(&set, 0)[0..3], &[255, 128, 0]);
        // 另一台灯不受影响。
        assert_eq!(&frame_at(&set, 2)[9..12], &[0, 0, 0]);
        c.evaluate_into(2000, &mut set);
        assert_eq!(&frame_at(&set, 0)[0..3], &[0, 0, 0]);
    }

    #[test]
    fn 亮度与_gamma_作用于输出() {
        let mut p = rig();
        p.cues.push(cue("t0", 0, 1000, [255, 255, 255], 50.0));
        p.output.gamma = 2.0;
        let c = compile(&p);
        let mut set = c.new_frames();
        c.evaluate_into(10, &mut set);
        // 0.5^2 * 255 = 63.75 → 64
        assert_eq!(&frame_at(&set, 0)[0..3], &[64, 64, 64]);
    }

    #[test]
    fn 多轨道对同一灯具取最大值() {
        let mut p = rig();
        p.tracks.push(Track {
            id: "t2".into(),
            target: TrackTarget::Fixture { id: "f0".into() },
            mute: false,
            solo: false,
        });
        p.cues.push(cue("t0", 0, 1000, [200, 0, 0], 100.0));
        p.cues.push(cue("t2", 0, 1000, [100, 100, 0], 100.0));
        let c = compile(&p);
        let mut set = c.new_frames();
        c.evaluate_into(10, &mut set);
        assert_eq!(&frame_at(&set, 0)[0..3], &[200, 100, 0]);
    }

    #[test]
    fn 淡入过程中输出渐变() {
        let mut p = rig();
        let mut c0 = cue("t0", 0, 1000, [200, 0, 0], 100.0);
        if let Cue::Static(s) = &mut c0 {
            s.base.fade_in_ms = 400;
        }
        p.cues.push(c0);
        let c = compile(&p);
        let mut set = c.new_frames();
        c.evaluate_into(200, &mut set);
        assert_eq!(frame_at(&set, 0)[0], 100);
    }

    #[test]
    fn 同轨道连续_cue_按起点定位() {
        let mut p = rig();
        for i in 0..50 {
            let v = (i * 5) as u8;
            p.cues.push(cue("t0", i * 100, i * 100 + 100, [v, 0, 0], 100.0));
        }
        let c = compile(&p);
        let mut set = c.new_frames();
        c.evaluate_into(2350, &mut set);
        assert_eq!(frame_at(&set, 0)[0], 115);
        c.evaluate_into(99_999, &mut set);
        assert_eq!(frame_at(&set, 0)[0], 0);
    }

    #[test]
    fn 定位只点亮目标灯具() {
        let p = rig();
        let c = compile(&p);
        let mut set = c.new_frames();
        assert!(c.locate_into("f1", &mut set));
        assert_eq!(&frame_at(&set, 2)[9..12], &[255, 255, 255]);
        assert_eq!(&frame_at(&set, 0)[0..3], &[0, 0, 0]);
        assert!(!c.locate_into("ghost", &mut set));
        assert_eq!(&frame_at(&set, 2)[9..12], &[0, 0, 0]);
    }

    #[test]
    fn 黑场保留默认值() {
        use ChannelFunction::{Red, Shutter};
        let mut p = rig();
        let mut m = model("h", &[Red, Shutter]);
        m.properties[1].default_value = 105;
        p.fixture_models.push(m);
        p.fixtures.push(FixtureInstance {
            id: "h".into(),
            name: String::new(),
            model_id: "h".into(),
            universe: 0,
            address: 100,
        });
        let c = compile(&p);
        let mut set = c.new_frames();
        c.blackout_into(&mut set);
        assert_eq!(&frame_at(&set, 0)[99..101], &[0, 105]);
    }

    /// 回归保护：大工程（2000 个 Cue、100 台灯具）每帧求值要远小于 33 ms 的帧预算。
    #[test]
    fn 大工程每帧求值足够快() {
        use ChannelFunction::{Blue, Green, Red};
        let mut p: ShowProject = serde_json::from_str(r#"{"durationMs":600000}"#).unwrap();
        p.fixture_models.push(model("m", &[Red, Green, Blue]));
        for i in 0..100u16 {
            p.fixtures.push(FixtureInstance {
                id: format!("f{i}"),
                name: String::new(),
                model_id: "m".into(),
                universe: i / 100 + (i % 4),
                address: 1 + (i % 100) * 3 % 500,
            });
            p.tracks.push(Track {
                id: format!("t{i}"),
                target: TrackTarget::Fixture { id: format!("f{i}") },
                mute: false,
                solo: false,
            });
            for k in 0..20i64 {
                p.cues.push(cue(&format!("t{i}"), k * 30_000, k * 30_000 + 20_000, [200, 100, 50], 100.0));
            }
        }
        assert_eq!(p.cues.len(), 2000);
        let c = compile(&p);
        let mut set = c.new_frames();
        let started = std::time::Instant::now();
        for frame in 0..300i64 {
            c.evaluate_into(frame * 33, &mut set);
        }
        let per_frame = started.elapsed() / 300;
        // 调试构建比发布构建慢一个数量级；即便如此也应远低于一帧的预算
        assert!(per_frame < std::time::Duration::from_millis(5), "每帧 {per_frame:?}");
    }

    #[test]
    fn 空工程可编译求值() {
        let p: ShowProject = serde_json::from_str(r#"{"durationMs":1000}"#).unwrap();
        let c = compile(&p);
        let mut set = c.new_frames();
        c.evaluate_into(0, &mut set);
        assert!(set.frames().is_empty());
    }
}
