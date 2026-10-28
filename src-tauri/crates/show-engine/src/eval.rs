//! 求值：把 [`CompiledShow`] 在某个时刻渲染成各 Universe 的 DMX 帧。
//!
//! 渲染分三步：
//!
//! 1. 各轨道上处于活动状态的 Cue 按包络算出亮度级别；颜色与级别先用工程 Gamma 解码到线性光，
//!    再由每台灯具的混色器（见 [`crate::mix::ColorMixer`]）换算成各发光体 / 调光 / 开关的线性输出；
//! 2. 多条轨道对同一灯具的结果按分量取最大值（HTP）；
//! 3. 线性输出直接写入 DMX 帧；不受驱动的通道保持底图里的默认值。
//!
//! 特效 Cue 由 [`crate::effects`] 给出每台灯具的颜色与强度调制，再走同一套混色。

use crate::compile::{CompiledCue, CompiledShow, DmxData};
use crate::effects;
use crate::envelope::{apply_gamma, envelope};
use crate::look::ColorState;
use crate::mix::{linear_to_srgb, ColorRequest, Components, WhiteStrategy, COMPONENTS};
use crate::project::{Cue, CueBase};

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
    /// 各灯具的混色结果（HTP 合成后）。
    acc: Vec<Components>,
    /// 各灯具的分层状态（外观 / 场景片段）。
    layers: Vec<LayerState>,
    /// 各灯具各属性通道的取值（用户空间分数），`None` 为保持默认值。
    attrs: Vec<Vec<Option<f64>>>,
    /// 本帧的分层贡献（按片段起点排序后依次应用，实现 LTP）。
    events: Vec<LayerEvent>,
}

/// 一台灯具的分层状态。
#[derive(Debug, Clone, Copy, Default)]
struct LayerState {
    /// 有片段写过强度或颜色。
    touched: bool,
    /// 强度（HTP，0~1，尚未解码 Gamma）。
    intensity: f64,
    /// 颜色（LTP）。
    color: Option<ColorState>,
}

/// 一个分层贡献：某个片段对某台灯具。
#[derive(Debug, Clone, Copy)]
struct LayerEvent {
    /// 来自置顶层轨道：排在所有普通贡献之后。
    top: bool,
    start: i64,
    track: u32,
    cue: u32,
    fixture: u32,
    /// 外观片段：成员在分布里的序号；场景片段：条目下标。
    slot: u32,
    /// 外观片段的成员总数。
    count: u32,
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
            acc: vec![[0.0; COMPONENTS]; self.fixtures.len()],
            layers: vec![LayerState::default(); self.fixtures.len()],
            attrs: self.fixtures.iter().map(|f| vec![None; f.attrs.len()]).collect(),
            events: Vec::new(),
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
        let g = self.gamma;
        let linear = |rgb: [f64; 3]| rgb.map(|v| apply_gamma(v, g));
        out.events.clear();
        for (ti, track) in self.tracks.iter().enumerate() {
            let upper = track.cues.partition_point(|c| c.base().start_ms <= t_ms);
            let lower = upper.saturating_sub(LOOKBACK);
            for (ci, compiled) in track.cues[lower..upper].iter().enumerate() {
                let ci = (lower + ci) as u32;
                let cue = match compiled {
                    CompiledCue::Legacy(c) => c,
                    CompiledCue::Look { base, members, .. } => {
                        if t_ms < base.end_ms {
                            let count = members.len() as u32;
                            for (pos, &fi) in members.iter().enumerate() {
                                out.events.push(LayerEvent {
                                    top: track.on_top,
                                    start: base.start_ms,
                                    track: ti as u32,
                                    cue: ci,
                                    fixture: fi as u32,
                                    slot: pos as u32,
                                    count,
                                });
                            }
                        }
                        continue;
                    }
                    CompiledCue::Scene { base, entries } => {
                        if t_ms < base.end_ms {
                            for (ei, (fi, _)) in entries.iter().enumerate() {
                                out.events.push(LayerEvent {
                                    top: track.on_top,
                                    start: base.start_ms,
                                    track: ti as u32,
                                    cue: ci,
                                    fixture: *fi as u32,
                                    slot: ei as u32,
                                    count: 1,
                                });
                            }
                        }
                        continue;
                    }
                };
                let env = envelope(cue.base(), t_ms);
                if env <= 0.0 {
                    continue;
                }
                let level = (cue.base().brightness / 100.0).clamp(0.0, 1.0) * env;
                match cue {
                    Cue::Static(c) => {
                        let rgb = linear(c.rgb.map(|v| f64::from(v) / 255.0));
                        let request = ColorRequest::Rgb { rgb, white: WhiteStrategy::Preserve };
                        let level = apply_gamma(level, g);
                        for &fi in &track.fixtures {
                            let mixed = self.fixtures[fi].mixer.mix(&request, level);
                            merge_max(&mut out.acc[fi], &mixed);
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
                            let request = ColorRequest::Rgb { rgb: linear(s.rgb), white: WhiteStrategy::Preserve };
                            let mixed = self.fixtures[fi].mixer.mix(&request, apply_gamma(level * intensity, g));
                            merge_max(&mut out.acc[fi], &mixed);
                        }
                    }
                    // 外观 / 场景片段已在上面转成分层贡献
                    Cue::Look(_) | Cue::Scene(_) => {}
                }
            }
        }
        self.apply_layers(t_ms, out);
        self.write_driven(out);
    }

    /// 按片段起点（同起点按轨道、片段顺序）依次应用分层贡献，置顶层轨道的贡献排在最后：
    /// 强度取最大（HTP），颜色与属性后来者优先（LTP，淡入期间从前一个值交叉淡化）。
    /// 最后把每台灯具的“强度 + 颜色”交给混色器，与 v1 片段的结果逐分量取最大。
    fn apply_layers(&self, t_ms: i64, out: &mut FrameSet) {
        let mut events = std::mem::take(&mut out.events);
        events.sort_by_key(|e| (e.top, e.start, e.track, e.cue));
        for e in &events {
            self.apply_event(e, t_ms, out);
        }
        out.events = events;

        let g = self.gamma;
        for (fi, state) in out.layers.iter().enumerate() {
            if !state.touched {
                continue;
            }
            let color = state.color.unwrap_or(ColorState::Rgb([1.0; 3], WhiteStrategy::Preserve));
            let mixed = self.fixtures[fi].mixer.mix(&color.request(g), apply_gamma(state.intensity, g));
            merge_max(&mut out.acc[fi], &mixed);
        }
    }

    fn apply_event(&self, e: &LayerEvent, t_ms: i64, out: &mut FrameSet) {
        let (base, look, spread) = match &self.tracks[e.track as usize].cues[e.cue as usize] {
            CompiledCue::Look { base, look, spread, .. } => (base, look, spread.as_ref()),
            CompiledCue::Scene { base, entries } => (base, &entries[e.slot as usize].1, None),
            CompiledCue::Legacy(_) => return,
        };
        let f = spread.map_or(0.0, |s| s.spread.fraction(e.slot as usize, e.count as usize));
        // 时间级联：推迟这台灯具的起点（终点不变）
        let delay = spread.map_or(0.0, |s| s.spread.delay_ms(f)).round() as i64;
        let start = base.start_ms + delay;
        if start >= base.end_ms {
            return;
        }
        let shifted = CueBase { start_ms: start, ..base.clone() };
        let env = envelope(&shifted, t_ms);
        if env <= 0.0 {
            return;
        }
        let u = (t_ms - start) as f64;
        let len = (base.end_ms - start) as f64;
        let fi = e.fixture as usize;
        let at = |r: &crate::look::SpreadRange| r.from + (r.to - r.from) * f;
        // 相位分布：数值曲线按成员错开相位（追逐 / 波浪），周期一致
        let phase = spread.and_then(|s| s.phase.as_ref().map(at)).unwrap_or(0.0);

        let state = &mut out.layers[fi];
        let pct = spread
            .and_then(|s| s.intensity.as_ref().map(at))
            .or_else(|| look.intensity.as_ref().map(|p| p.sample_phased(u, len, phase)));
        if let Some(pct) = pct {
            let level = (pct / 100.0).clamp(0.0, 1.0) * (base.brightness / 100.0).clamp(0.0, 1.0) * env;
            state.intensity = state.intensity.max(level);
            state.touched = true;
        }
        if let Some(mut color) = look.color.as_ref().and_then(|c| c.sample(u)) {
            if let Some(h) = spread.and_then(|s| s.hue.as_ref().map(at)) {
                color = color.rotate_hue(h);
            }
            state.color = Some(match &state.color {
                Some(prev) => ColorState::lerp(prev, &color, env),
                None => color,
            });
            state.touched = true;
        }

        let fixture = &self.fixtures[fi];
        if fixture.attrs.is_empty() {
            return;
        }
        let values = &mut out.attrs[fi];
        let mut set = |function, v: f64| {
            for (si, slot) in fixture.attrs.iter().enumerate() {
                if slot.function == function {
                    let prev = values[si].unwrap_or(slot.default);
                    values[si] = Some(prev + (v.clamp(0.0, 1.0) - prev) * env);
                }
            }
        };
        for (function, param) in &look.attrs {
            let spread_value = spread.and_then(|s| s.attrs.iter().find(|(k, _)| k == function).map(|(_, r)| at(r)));
            set(*function, spread_value.unwrap_or_else(|| param.sample_phased(u, len, phase)));
        }
        // 只在分布里出现、外观里没有的属性也照样展开
        for (function, range) in spread.map(|s| s.attrs.as_slice()).unwrap_or_default() {
            if !look.attrs.contains_key(function) {
                set(*function, at(range));
            }
        }
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
        let request = ColorRequest::Rgb { rgb: [1.0; 3], white: WhiteStrategy::Preserve };
        let mixed = self.fixtures[fi].mixer.mix(&request, 1.0);
        merge_max(&mut out.acc[fi], &mixed);
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

    /// 最近一次求值后各灯具实际发出的颜色（sRGB 0~255），供预览显示。
    ///
    /// 由各发光体的输出与其颜色向量合成，再按 sRGB 编码；调光通道的级别已计入。
    ///
    /// # Arguments
    ///
    /// * `out` - 刚经过 [`CompiledShow::evaluate_into`] 等方法渲染的帧缓冲。
    ///
    /// # Returns
    ///
    /// `(灯具实例编号, [r, g, b])`，顺序与编译后的灯具顺序一致。
    #[must_use]
    pub fn preview_colors<'a>(&'a self, out: &FrameSet) -> Vec<(&'a str, [u8; 3])> {
        self.fixtures
            .iter()
            .zip(&out.acc)
            .map(|(f, acc)| {
                let rgb = f.mixer.emitted_rgb(acc).map(|v| (linear_to_srgb(v) * 255.0).round() as u8);
                (f.id.as_str(), rgb)
            })
            .collect()
    }

    fn reset(&self, out: &mut FrameSet) {
        // 帧缓冲应由本节目创建；防御性地处理形状不一致。
        if out.frames.len() != self.universes.len() || out.acc.len() != self.fixtures.len() {
            *out = self.new_frames();
        }
        for (frame, base) in out.frames.iter_mut().zip(&self.base) {
            frame.data = *base;
        }
        out.acc.fill([0.0; COMPONENTS]);
        out.layers.fill(LayerState::default());
        for values in &mut out.attrs {
            values.fill(None);
        }
    }

    fn write_driven(&self, out: &mut FrameSet) {
        for ((fixture, acc), attrs) in self.fixtures.iter().zip(&out.acc).zip(&out.attrs) {
            let data = &mut out.frames[fixture.universe_index].data;
            for (component, slot) in fixture.driven.slots().into_iter().enumerate() {
                if let Some(slot) = slot {
                    slot.write(data, acc[component]);
                }
            }
            for &(component, slot) in &fixture.mirrors {
                slot.write(data, acc[component]);
            }
            for (a, v) in fixture.attrs.iter().zip(attrs) {
                if let Some(v) = v {
                    a.slot.write(data, if a.invert { 1.0 - v } else { *v });
                }
            }
        }
        // 多重配接：把灯具占用的整段通道复制到副本地址
        for fixture in &self.fixtures {
            let (s, n) = (usize::from(fixture.span.0), usize::from(fixture.span.1));
            for &(ui, dest) in &fixture.copies {
                let d = usize::from(dest);
                let (src, dst) = split_frames(&mut out.frames, fixture.universe_index, ui);
                match dst {
                    Some(dst) => dst[d..d + n].copy_from_slice(&src[s..s + n]),
                    None => src.copy_within(s..s + n, d),
                }
            }
        }
        for &(ui, offset, value) in &self.park {
            out.frames[ui].data[usize::from(offset)] = value;
        }
    }
}

/// 同时借出两个 Universe 帧的数据（相同下标时只借一个）。
fn split_frames(frames: &mut [Frame], a: usize, b: usize) -> (&mut DmxData, Option<&mut DmxData>) {
    if a == b {
        return (&mut frames[a].data, None);
    }
    if a < b {
        let (lo, hi) = frames.split_at_mut(b);
        (&mut lo[a].data, Some(&mut hi[0].data))
    } else {
        let (lo, hi) = frames.split_at_mut(a);
        (&mut hi[0].data, Some(&mut lo[b].data))
    }
}

fn merge_max(acc: &mut Components, v: &Components) {
    for (a, b) in acc.iter_mut().zip(v) {
        if *b > *a {
            *a = *b;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::compile;
    use crate::fixture::{ChannelFunction, FixtureModel, FixtureProperty};
    use crate::project::{
        CueBase, Easing, FixtureInstance, ShowProject, StaticCue, Track, TrackTarget,
    };
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
                    ..FixtureProperty::default()
                })
                .collect(),
            ..FixtureModel::default()
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
                disabled: false,
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
                mode_id: None,
                stage: None,
                mirrors: Vec::new(),
            });
            p.tracks.push(Track {
                id: format!("t{i}"),
                target: TrackTarget::Fixture { id: format!("f{i}") },
                mute: false,
                solo: false,
                on_top: false,
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
    fn 禁用的片段不输出_也能从前端形态解析() {
        let mut p = rig();
        p.cues.push(cue("t0", 1000, 2000, [255, 128, 0], 100.0));
        if let Cue::Static(s) = &mut p.cues[0] {
            s.base.disabled = true;
        }
        let c = compile(&p);
        let mut set = c.new_frames();
        c.evaluate_into(1500, &mut set);
        assert_eq!(&frame_at(&set, 0)[0..3], &[0, 0, 0]);
        // 序列化时 `disabled: false` 省略，`true` 写出；缺省为启用
        let json = serde_json::to_value(&p.cues[0]).unwrap();
        assert_eq!(json["disabled"], serde_json::json!(true));
        let parsed: Cue = serde_json::from_str(
            r#"{"kind":"static","id":"c","trackId":"t0","startMs":0,"endMs":10,"brightness":100,"fadeInMs":0,"fadeOutMs":0,"easing":"linear","rgb":[1,2,3]}"#,
        )
        .unwrap();
        assert!(!parsed.base().disabled);
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
            on_top: false,
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
            mode_id: None,
            stage: None,
            mirrors: Vec::new(),
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
                mode_id: None,
                stage: None,
                mirrors: Vec::new(),
            });
            p.tracks.push(Track {
                id: format!("t{i}"),
                target: TrackTarget::Fixture { id: format!("f{i}") },
                mute: false,
                solo: false,
                on_top: false,
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

    #[test]
    fn rgbcw_灯中性白只点冷白_并且有_gamma_时按线性光提取() {
        use ChannelFunction::{Blue, CoolWhite, Green, Red, WarmWhite};
        let mut p = rig();
        p.fixture_models.push(model("cw", &[Red, Green, Blue, CoolWhite, WarmWhite]));
        p.fixtures.push(FixtureInstance {
            id: "x".into(),
            name: String::new(),
            model_id: "cw".into(),
            universe: 0,
            address: 50,
            mode_id: None,
            stage: None,
            mirrors: Vec::new(),
        });
        p.tracks.push(Track {
            id: "tx".into(),
            target: TrackTarget::Fixture { id: "x".into() },
            mute: false,
            solo: false,
            on_top: false,
        });
        p.cues.push(cue("tx", 0, 1000, [128, 128, 128], 100.0));
        p.output.gamma = 2.0;
        let c = compile(&p);
        let mut set = c.new_frames();
        c.evaluate_into(10, &mut set);
        // (128/255)^2 * 255 ≈ 64：全部由冷白给出，暖白与 RGB 为 0
        assert_eq!(&frame_at(&set, 0)[49..54], &[0, 0, 0, 64, 0]);
        let colors = c.preview_colors(&set);
        let (_, rgb) = colors.iter().find(|(id, _)| *id == "x").expect("预览色");
        assert!(rgb.iter().all(|v| *v > 120 && *v < 140), "{rgb:?}");
    }
    // ---------- v2：外观 / 场景片段、关键帧、分布、预设、Park、多重配接 ----------

    /// 由 JSON 片段拼出工程：一台 RGBW+Pan(16 位)+Tilt 灯 f0 @U0/1，四台同型灯 g1..g4 组成分组 g。
    fn v2_project(tracks: &str, cues: &str, extra: &str) -> ShowProject {
        let model = r#"{"id":"m","name":"m","properties":[
            {"name":"d","code":"D","function":"dimmer","channel":1,"width":1,"bigEndian":true,"defaultValue":0},
            {"name":"r","code":"R","function":"red","channel":2,"width":1,"bigEndian":true,"defaultValue":0},
            {"name":"g","code":"G","function":"green","channel":3,"width":1,"bigEndian":true,"defaultValue":0},
            {"name":"b","code":"B","function":"blue","channel":4,"width":1,"bigEndian":true,"defaultValue":0},
            {"name":"w","code":"W","function":"white","channel":5,"width":1,"bigEndian":true,"defaultValue":0},
            {"name":"p","code":"P","function":"pan","channel":6,"width":2,"bigEndian":true,"defaultValue":32768},
            {"name":"t","code":"T","function":"tilt","channel":8,"width":1,"bigEndian":true,"defaultValue":0,"invert":true}]}"#;
        let fixtures: Vec<String> = (0..5)
            .map(|i| format!(r#"{{"id":"{}","modelId":"m","universe":0,"address":{}}}"#, if i == 0 { "f0".into() } else { format!("g{i}") }, 1 + i * 10))
            .collect();
        let json = format!(
            r#"{{"durationMs":10000,"fixtureModels":[{model}],"fixtures":[{}],
                "groups":[{{"id":"g","fixtureIds":["g1","g2","g3","g4"]}}],
                "tracks":[{tracks}],"cues":[{cues}],"output":{{"gamma":1}}{extra}}}"#,
            fixtures.join(",")
        );
        serde_json::from_str(&json).unwrap_or_else(|e| panic!("工程 JSON 应合法：{e}\n{json}"))
    }

    fn base_json(id: &str, track: &str, start: i64, end: i64, fade_in: i64) -> String {
        format!(r#""id":"{id}","trackId":"{track}","startMs":{start},"endMs":{end},"brightness":100,"fadeInMs":{fade_in},"fadeOutMs":0,"easing":"linear""#)
    }

    const T_F0: &str = r#"{"id":"t0","target":{"kind":"fixture","id":"f0"}}"#;
    const T_G: &str = r#"{"id":"tg","target":{"kind":"group","id":"g"}}"#;

    fn eval_at(p: &ShowProject, t: i64) -> DmxData {
        let c = compile(p);
        assert!(c.warnings().is_empty(), "{:?}", c.warnings());
        let mut set = c.new_frames();
        c.evaluate_into(t, &mut set);
        *frame_at(&set, 0)
    }

    #[test]
    fn 外观片段_强度颜色与属性分层输出() {
        let cue = format!(
            r#"{{"kind":"look",{},"look":{{"intensity":{{"kind":"value","value":50}},
                "color":{{"kind":"value","value":{{"kind":"rgb","rgb":[255,153,51]}}}},
                "attrs":{{"pan":{{"kind":"value","value":0.25}},"tilt":{{"kind":"value","value":0.2}}}}}}}}"#,
            base_json("c", "t0", 0, 1000, 0)
        );
        let d = eval_at(&v2_project(T_F0, &cue, ""), 500);
        // 调光 50%，颜色满值（RGBW 保色提取白光），Pan 0.25 → 16384，Tilt 反向 0.2 → 0.8
        assert_eq!(&d[0..5], &[128, 204, 102, 0, 51]);
        assert_eq!(&d[5..7], &[0x40, 0x00]);
        assert_eq!(d[7], 204);
        // 片段之外：调光 0，Pan 回到默认居中，Tilt 默认 0
        let d = eval_at(&v2_project(T_F0, &cue, ""), 1500);
        assert_eq!(&d[0..8], &[0, 0, 0, 0, 0, 0x80, 0x00, 0]);
    }

    #[test]
    fn 只有颜色没有强度的外观不发光_属性照样生效() {
        let cue = format!(
            r#"{{"kind":"look",{},"look":{{"color":{{"kind":"value","value":{{"kind":"rgb","rgb":[255,0,0]}}}},
                "attrs":{{"pan":{{"kind":"value","value":1}}}}}}}}"#,
            base_json("c", "t0", 0, 1000, 0)
        );
        let d = eval_at(&v2_project(T_F0, &cue, ""), 100);
        assert_eq!(d[0], 0);
        assert_eq!(&d[5..7], &[0xFF, 0xFF]);
    }

    #[test]
    fn 颜色后来者优先并交叉淡化_强度取最大() {
        let tracks = format!(r#"{T_F0},{{"id":"t1","target":{{"kind":"fixture","id":"f0"}}}}"#);
        let red = format!(
            r#"{{"kind":"look",{},"look":{{"intensity":{{"kind":"value","value":100}},"color":{{"kind":"value","value":{{"kind":"rgb","rgb":[255,0,0]}}}}}}}}"#,
            base_json("a", "t0", 0, 4000, 0)
        );
        // 第二个片段从 1000 起，淡入 1000 ms，只给 40% 强度
        let blue = format!(
            r#"{{"kind":"look",{},"look":{{"intensity":{{"kind":"value","value":40}},"color":{{"kind":"value","value":{{"kind":"rgb","rgb":[0,0,255]}}}}}}}}"#,
            base_json("b", "t1", 1000, 4000, 1000)
        );
        let p = v2_project(&tracks, &format!("{red},{blue}"), "");
        assert_eq!(&eval_at(&p, 500)[0..4], &[255, 255, 0, 0]);
        // 淡入一半：颜色在红蓝之间各半，强度取最大仍为 100%
        assert_eq!(&eval_at(&p, 1500)[0..4], &[255, 128, 0, 128]);
        assert_eq!(&eval_at(&p, 2500)[0..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn 属性关键帧与数值曲线() {
        let cue = format!(
            r#"{{"kind":"look",{},"look":{{"attrs":{{
                "pan":{{"kind":"keys","keys":[{{"tMs":0,"value":0,"curve":"linear"}},{{"tMs":1000,"value":1,"curve":"linear"}}]}},
                "tilt":{{"kind":"curve","curve":{{"shape":"square","from":0,"to":1,"cycles":2,"phase":0}}}}}}}}}}"#,
            base_json("c", "t0", 0, 2000, 0)
        );
        let p = v2_project(T_F0, &cue, "");
        let d = eval_at(&p, 500);
        assert_eq!(&d[5..7], &[0x80, 0x00]);
        // 方波两个周期（每周期 1000 ms）：前半周期为 1（反向后 DMX 0），后半周期为 0（反向后 255）
        assert_eq!(eval_at(&p, 250)[7], 0);
        assert_eq!(eval_at(&p, 750)[7], 255);
        assert_eq!(&eval_at(&p, 1500)[5..7], &[0xFF, 0xFF]);
    }

    #[test]
    fn 分组分布_扇形展开与时间级联() {
        let cue = format!(
            r#"{{"kind":"look",{},"look":{{"intensity":{{"kind":"value","value":100}}}},
                "spread":{{"values":{{"pan":{{"from":0,"to":1}}}},"delay":{{"fromMs":0,"toMs":300}}}}}}"#,
            base_json("c", "tg", 0, 2000, 0)
        );
        let p = v2_project(T_G, &cue, "");
        let d = eval_at(&p, 400);
        // 成员 g1..g4 在地址 11/21/31/41：全部进入后 Pan 依次 0、1/3、2/3、1
        let pan = |d: &DmxData, addr: usize| u16::from_be_bytes([d[addr + 5], d[addr + 6]]);
        assert_eq!([pan(&d, 10), pan(&d, 20), pan(&d, 30), pan(&d, 40)], [0, 21845, 43690, 65535]);
        // 时间级联：t=50 时只有第一台已进入（亮），其余仍是默认值
        let d = eval_at(&p, 50);
        assert_eq!([d[10], d[20], d[30], d[40]], [255, 0, 0, 0]);
        assert_eq!(pan(&d, 20), 32768);
        let d = eval_at(&p, 250);
        assert_eq!([d[10], d[20], d[30], d[40]], [255, 255, 255, 0]);
    }

    #[test]
    fn 分布_反向与分翼_色相偏移() {
        let cue = format!(
            r#"{{"kind":"look",{},"look":{{"intensity":{{"kind":"value","value":100}},
                "color":{{"kind":"value","value":{{"kind":"rgb","rgb":[255,0,0]}}}}}},
                "spread":{{"order":"reverse","wings":2,"values":{{"hue":{{"from":0,"to":120}}}}}}}}"#,
            base_json("c", "tg", 0, 2000, 0)
        );
        let d = eval_at(&v2_project(T_G, &cue, ""), 10);
        // 反向后顺序为 g4 g3 g2 g1，两翼对称：两端 0°（红），中间两台 120°（绿）
        let rgb = |addr: usize| [d[addr + 1], d[addr + 2], d[addr + 3]];
        assert_eq!(rgb(40), [255, 0, 0]);
        assert_eq!(rgb(10), [255, 0, 0]);
        assert_eq!(rgb(20), [0, 255, 0]);
        assert_eq!(rgb(30), [0, 255, 0]);
    }

    #[test]
    fn 场景片段_一次给多台灯分别设值_只写参与的属性() {
        let tracks = r#"{"id":"ts","target":{"kind":"scene"}}"#;
        let cue = format!(
            r#"{{"kind":"scene",{},"entries":[
                {{"fixtureId":"g1","look":{{"intensity":{{"kind":"value","value":100}},"color":{{"kind":"value","value":{{"kind":"kelvin","kelvin":6500}}}}}}}},
                {{"fixtureId":"g3","look":{{"attrs":{{"pan":{{"kind":"value","value":0}}}}}}}},
                {{"fixtureId":"ghost","look":{{}}}}]}}"#,
            base_json("s", "ts", 0, 1000, 0)
        );
        let d = eval_at(&v2_project(tracks, &cue, ""), 10);
        assert_eq!(d[10], 255);
        assert!(d[14] > 240, "6500K 主要由白光给出：{:?}", &d[10..15]);
        // g3 只动了 Pan，调光不变（0）
        assert_eq!(d[30], 0);
        assert_eq!(&d[35..37], &[0, 0]);
        // 未参与的 g2：Pan 保持默认居中
        assert_eq!(&d[25..27], &[0x80, 0x00]);
    }

    #[test]
    fn 外观引用预设_显式层覆盖预设() {
        let extra = r#","presets":[{"id":"p","name":"红","look":{
            "intensity":{"kind":"value","value":100},
            "color":{"kind":"value","value":{"kind":"rgb","rgb":[255,0,0]}}}}]"#;
        let cue = format!(
            r#"{{"kind":"look",{},"look":{{"presetId":"p","intensity":{{"kind":"value","value":50}}}}}}"#,
            base_json("c", "t0", 0, 1000, 0)
        );
        let d = eval_at(&v2_project(T_F0, &cue, extra), 10);
        assert_eq!(&d[0..4], &[128, 255, 0, 0]);
    }

    #[test]
    fn 通道锁定最后写入_多重配接复制整段() {
        let extra = r#","output":{"gamma":1,"park":[{"universe":0,"channel":2,"value":7},{"universe":9,"channel":1,"value":200}]}"#;
        let cue = format!(
            r#"{{"kind":"look",{},"look":{{"intensity":{{"kind":"value","value":100}}}}}}"#,
            base_json("c", "t0", 0, 1000, 0)
        );
        let mut p = v2_project(T_F0, &cue, "");
        let with_park: ShowProject = serde_json::from_str(&format!(
            r#"{{"durationMs":1000{extra}}}"#
        ))
        .expect("park JSON");
        p.output.park = with_park.output.park;
        p.fixtures[0].mirrors.push(crate::project::PatchAddress { universe: 2, address: 100 });
        p.fixtures[0].mirrors.push(crate::project::PatchAddress { universe: 2, address: 510 }); // 越界，被忽略
        let c = compile(&p);
        assert_eq!(c.universes(), &[0, 2, 9]);
        let mut set = c.new_frames();
        c.evaluate_into(10, &mut set);
        let u0 = frame_at(&set, 0);
        assert_eq!(u0[0], 255);
        assert_eq!(u0[1], 7, "Park 覆盖红光通道");
        let u2 = frame_at(&set, 2);
        assert_eq!(u2[99], 255, "副本的调光");
        assert_eq!(&u2[104..106], &[0x80, 0x00], "副本的 Pan 默认值");
        assert_eq!(frame_at(&set, 9)[0], 200);
    }

    #[test]
    fn 相位分布_追逐_每台灯错开相位且周期一致() {
        // 4 台灯、方波占空比 1/4、每秒一个周期；相位从 0 到 -0.75：每 250 ms 亮下一台
        let tracks = r#"{"id":"tg","target":{"kind":"group","id":"g"}}"#;
        let cue = format!(
            r#"{{"kind":"look",{},"look":{{"intensity":{{"kind":"curve","curve":{{"shape":"square","from":0,"to":100,"cycles":4,"phase":0,"duty":0.25}}}},
                "color":{{"kind":"value","value":{{"kind":"rgb","rgb":[255,255,255]}}}}}},
                "spread":{{"values":{{"phase":{{"from":0,"to":-0.75}}}}}}}}"#,
            base_json("c", "tg", 0, 4000, 0)
        );
        let p = v2_project(tracks, &cue, "");
        let lit = |t: i64| -> Vec<usize> {
            let d = eval_at(&p, t);
            (1..=4).filter(|i| d[i * 10] > 0).collect()
        };
        assert_eq!(lit(100), vec![1]);
        assert_eq!(lit(350), vec![2]);
        assert_eq!(lit(600), vec![3]);
        assert_eq!(lit(850), vec![4]);
        // 第二个周期回到第一台：周期没有因为相位而漂移
        assert_eq!(lit(3100), vec![1]);
    }

    #[test]
    fn 置顶层轨道的颜色永远胜出_强度仍取最大() {
        // 普通轨道上 1000 ms 起的蓝色比置顶场景轨道（0 ms 起的红色）“新”，但置顶层排在最后
        let blue = format!(
            r#"{{"kind":"look",{},"look":{{"intensity":{{"kind":"value","value":100}},"color":{{"kind":"value","value":{{"kind":"rgb","rgb":[0,0,255]}}}}}}}}"#,
            base_json("b", "t0", 1000, 4000, 0)
        );
        let red = format!(
            r#"{{"kind":"scene",{},"entries":[{{"fixtureId":"f0","look":{{"intensity":{{"kind":"value","value":40}},"color":{{"kind":"value","value":{{"kind":"rgb","rgb":[255,0,0]}}}}}}}}]}}"#,
            base_json("s", "top", 0, 4000, 0)
        );
        let tracks = |on_top: bool| format!(r#"{T_F0},{{"id":"top","target":{{"kind":"scene"}},"onTop":{on_top}}}"#);
        let normal = eval_at(&v2_project(&tracks(false), &format!("{blue},{red}"), ""), 2000);
        assert_eq!(&normal[0..4], &[255, 0, 0, 255], "普通情况下后开始的蓝色胜出");
        let top = eval_at(&v2_project(&tracks(true), &format!("{blue},{red}"), ""), 2000);
        assert_eq!(&top[0..4], &[255, 255, 0, 0], "置顶层的红色胜出，强度取最大 100%");
    }

    #[test]
    fn 场景片段放在普通轨道上被忽略() {
        let cue = format!(r#"{{"kind":"scene",{},"entries":[{{"fixtureId":"f0","look":{{"intensity":{{"kind":"value","value":100}}}}}}]}}"#, base_json("s", "t0", 0, 1000, 0));
        assert_eq!(eval_at(&v2_project(T_F0, &cue, ""), 10)[0], 0);
    }
}
