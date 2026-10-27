//! 工程编译：把 [`ShowProject`] 预处理成可高效求值的 [`CompiledShow`]。
//!
//! 编译阶段完成所有与时间无关的工作：
//!
//! - 解析灯具模型，算出每台灯具被驱动的通道（红 / 绿 / 蓝 / 白 / 冷白 / 暖白 / 调光 / 开关）的位置；
//! - 把不受驱动的通道（云台、图案等）的默认值预先写进“底图”；
//! - 展开轨道绑定（灯具或分组，分组保持成员顺序），应用静音 / 独奏；
//! - 过滤非法 Cue，并按起点排序。

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use crate::envelope::sanitize_gamma;
use crate::fixture::{ChannelFunction, FixtureModel, DMX_CHANNELS};
use crate::project::{Cue, ShowProject, Tempo, TrackTarget, MAX_UNIVERSE};

/// 一个 Universe 的 DMX 数据。
pub type DmxData = [u8; DMX_CHANNELS as usize];

/// 灯具上的一个被驱动的通道位置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    /// 在 Universe 内的 0 起偏移。
    pub offset: u16,
    /// 占用通道数（1 或 2）。
    pub width: u8,
    /// 双通道属性是否大端（低通道放高字节）。
    pub big_endian: bool,
}

impl Slot {
    /// 把 `0..=1` 的分数写入 DMX 数据。
    ///
    /// # Arguments
    ///
    /// * `data` - 目标 Universe 的数据。
    /// * `frac` - 亮度分数，超出范围时被夹取。
    pub fn write(&self, data: &mut DmxData, frac: f64) {
        let frac = frac.clamp(0.0, 1.0);
        let at = usize::from(self.offset);
        if self.width >= 2 {
            let v = (frac * f64::from(u16::MAX)).round() as u16;
            let [hi, lo] = v.to_be_bytes();
            let (first, second) = if self.big_endian { (hi, lo) } else { (lo, hi) };
            data[at] = first;
            if at + 1 < data.len() {
                data[at + 1] = second;
            }
        } else {
            data[at] = (frac * 255.0).round() as u8;
        }
    }
}

/// 灯具被求值器驱动的通道。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Driven {
    /// 红光。
    pub red: Option<Slot>,
    /// 绿光。
    pub green: Option<Slot>,
    /// 蓝光。
    pub blue: Option<Slot>,
    /// 白光。
    pub white: Option<Slot>,
    /// 冷白。
    pub cool: Option<Slot>,
    /// 暖白。
    pub warm: Option<Slot>,
    /// 调光。
    pub dimmer: Option<Slot>,
    /// 开关。
    pub switch: Option<Slot>,
}

impl Driven {
    /// 是否有任何一路 RGB 通道。
    ///
    /// # Returns
    ///
    /// 红、绿、蓝任一存在即为 `true`。
    #[must_use]
    pub fn has_rgb(&self) -> bool {
        self.red.is_some() || self.green.is_some() || self.blue.is_some()
    }

    /// 是否有色温（冷白 / 暖白）通道。
    ///
    /// # Returns
    ///
    /// 冷白或暖白任一存在即为 `true`。
    #[must_use]
    pub fn has_cct(&self) -> bool {
        self.cool.is_some() || self.warm.is_some()
    }
}

/// 一台已编译的灯具。
#[derive(Debug, Clone)]
pub struct CompiledFixture {
    /// 灯具实例编号。
    pub id: String,
    /// 在 [`CompiledShow::universes`] 里的下标。
    pub universe_index: usize,
    /// 被驱动的通道。
    pub driven: Driven,
}

/// 一条已编译的轨道。
#[derive(Debug, Clone)]
pub struct CompiledTrack {
    /// 轨道编号。
    pub id: String,
    /// 轨道驱动的灯具（下标指向已编译灯具列表，分组保持成员顺序）。
    pub fixtures: Vec<usize>,
    /// 按起点排序的 Cue。
    pub cues: Vec<Cue>,
}

/// 编译警告：对应的灯具被跳过，不会输出。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CompileWarning {
    /// 灯具引用的模型不存在。
    UnknownModel {
        /// 灯具实例编号。
        fixture_id: String,
    },
    /// 灯具的模型未通过校验。
    InvalidModel {
        /// 灯具实例编号。
        fixture_id: String,
    },
    /// 灯具的地址或 Universe 超出范围。
    OutOfRange {
        /// 灯具实例编号。
        fixture_id: String,
    },
}

/// 已编译的节目。
#[derive(Debug, Clone)]
pub struct CompiledShow {
    pub(crate) duration_ms: i64,
    pub(crate) gamma: f64,
    pub(crate) tempo: Option<Tempo>,
    pub(crate) universes: Vec<u16>,
    pub(crate) base: Vec<DmxData>,
    pub(crate) fixtures: Vec<CompiledFixture>,
    pub(crate) tracks: Vec<CompiledTrack>,
    pub(crate) warnings: Vec<CompileWarning>,
}

impl CompiledShow {
    /// 节目总时长。
    ///
    /// # Returns
    ///
    /// 时长（毫秒）。
    #[must_use]
    pub fn duration_ms(&self) -> i64 {
        self.duration_ms
    }

    /// 参与输出的 Universe。
    ///
    /// # Returns
    ///
    /// 升序且不重复的 Universe 编号。
    #[must_use]
    pub fn universes(&self) -> &[u16] {
        &self.universes
    }

    /// 编译警告。
    ///
    /// # Returns
    ///
    /// 被跳过的灯具及原因。
    #[must_use]
    pub fn warnings(&self) -> &[CompileWarning] {
        &self.warnings
    }

    /// 节拍设置（按拍数定义的特效周期依赖它）。
    ///
    /// # Returns
    ///
    /// 工程里的节拍；未设置时为 `None`。
    #[must_use]
    pub fn tempo(&self) -> Option<Tempo> {
        self.tempo
    }

    /// 已规整的 Gamma。
    ///
    /// # Returns
    ///
    /// 可安全用于 `powf` 的 Gamma。
    #[must_use]
    pub fn gamma(&self) -> f64 {
        self.gamma
    }
}

/// 编译工程。
///
/// 非法的灯具（模型缺失 / 未通过校验 / 地址越界）被跳过并记入警告，不会让编译失败；
/// 空工程也能编译，输出为空。
///
/// # Arguments
///
/// * `project` - 要编译的工程。
///
/// # Returns
///
/// 可反复求值的 [`CompiledShow`]。
#[must_use]
pub fn compile(project: &ShowProject) -> CompiledShow {
    let mut warnings = Vec::new();
    let accepted = accept_fixtures(project, &mut warnings);

    let universes: Vec<u16> = accepted
        .iter()
        .map(|a| a.universe)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut base: Vec<DmxData> = vec![[0u8; DMX_CHANNELS as usize]; universes.len()];

    // 底图只含不受驱动通道的默认值；被驱动的通道在求值时才写入。
    let fixtures: Vec<CompiledFixture> = accepted
        .iter()
        .map(|a| {
            let universe_index = universes.binary_search(&a.universe).unwrap_or(0);
            let driven = layout_fixture(a, &mut base[universe_index]);
            CompiledFixture {
                id: a.id.to_owned(),
                universe_index,
                driven,
            }
        })
        .collect();

    CompiledShow {
        duration_ms: project.duration_ms.max(0),
        gamma: sanitize_gamma(project.output.gamma),
        tempo: project.tempo,
        universes,
        base,
        tracks: build_tracks(project, &fixtures),
        fixtures,
        warnings,
    }
}

/// 通过校验的灯具实例及其模型。
struct Accepted<'a> {
    id: &'a str,
    universe: u16,
    address: u16,
    model: &'a FixtureModel,
}

/// 挑出模型存在、合法且地址在范围内的灯具；其余记入 `warnings`。
fn accept_fixtures<'a>(
    project: &'a ShowProject,
    warnings: &mut Vec<CompileWarning>,
) -> Vec<Accepted<'a>> {
    let models: HashMap<&str, &FixtureModel> = project
        .fixture_models
        .iter()
        .map(|m| (m.id.as_str(), m))
        .collect();
    let mut accepted = Vec::new();
    for f in &project.fixtures {
        let Some(model) = models.get(f.model_id.as_str()).copied() else {
            warnings.push(CompileWarning::UnknownModel { fixture_id: f.id.clone() });
            continue;
        };
        if model.validate().is_err() {
            warnings.push(CompileWarning::InvalidModel { fixture_id: f.id.clone() });
            continue;
        }
        let end = u32::from(f.address.saturating_sub(1)) + u32::from(model.channel_count());
        if f.address == 0 || end > u32::from(DMX_CHANNELS) || f.universe > MAX_UNIVERSE {
            warnings.push(CompileWarning::OutOfRange { fixture_id: f.id.clone() });
            continue;
        }
        accepted.push(Accepted {
            id: &f.id,
            universe: f.universe,
            address: f.address,
            model,
        });
    }
    accepted
}

/// 确定灯具被驱动的通道位置，并把其余通道的默认值写进 `base`。
fn layout_fixture(a: &Accepted<'_>, base: &mut DmxData) -> Driven {
    let origin = a.address - 1;
    let mut driven = Driven::default();
    for p in &a.model.properties {
        let slot = Slot {
            offset: origin + p.channel - 1,
            width: p.width,
            big_endian: p.big_endian,
        };
        let target = match p.function {
            ChannelFunction::Red => Some(&mut driven.red),
            ChannelFunction::Green => Some(&mut driven.green),
            ChannelFunction::Blue => Some(&mut driven.blue),
            ChannelFunction::White => Some(&mut driven.white),
            ChannelFunction::CoolWhite => Some(&mut driven.cool),
            ChannelFunction::WarmWhite => Some(&mut driven.warm),
            ChannelFunction::Dimmer => Some(&mut driven.dimmer),
            ChannelFunction::Switch => Some(&mut driven.switch),
            _ => None,
        };
        match target {
            Some(t) => *t = Some(slot),
            None => write_default(base, slot, p.default_value),
        }
    }
    driven
}

/// 展开轨道绑定（灯具或分组），应用静音 / 独奏，并为每条轨道收集排好序的 Cue。
fn build_tracks(project: &ShowProject, fixtures: &[CompiledFixture]) -> Vec<CompiledTrack> {
    let index_of: HashMap<&str, usize> = fixtures
        .iter()
        .enumerate()
        .map(|(i, f)| (f.id.as_str(), i))
        .collect();
    let any_solo = project.tracks.iter().any(|t| t.solo);

    let mut tracks = Vec::new();
    for t in &project.tracks {
        let audible = if any_solo { t.solo } else { !t.mute };
        if !audible {
            continue;
        }
        let members: Vec<usize> = match &t.target {
            TrackTarget::Fixture { id } => index_of.get(id.as_str()).copied().into_iter().collect(),
            TrackTarget::Group { id } => project
                .groups
                .iter()
                .find(|g| &g.id == id)
                .map(|g| {
                    g.fixture_ids
                        .iter()
                        .filter_map(|fid| index_of.get(fid.as_str()).copied())
                        .collect()
                })
                .unwrap_or_default(),
        };
        let mut cues: Vec<Cue> = project
            .cues
            .iter()
            .filter(|c| c.base().track_id == t.id && c.base().end_ms > c.base().start_ms)
            .cloned()
            .collect();
        cues.sort_by_key(|c| c.base().start_ms);
        tracks.push(CompiledTrack {
            id: t.id.clone(),
            fixtures: members,
            cues,
        });
    }
    tracks
}

/// 把属性默认值写入底图。
fn write_default(data: &mut DmxData, slot: Slot, value: u16) {
    let at = usize::from(slot.offset);
    if slot.width >= 2 {
        let [hi, lo] = value.to_be_bytes();
        let (first, second) = if slot.big_endian { (hi, lo) } else { (lo, hi) };
        data[at] = first;
        if at + 1 < data.len() {
            data[at + 1] = second;
        }
    } else {
        data[at] = value.min(255) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::builtin_models;
    use crate::project::{FixtureGroup, FixtureInstance, Track};

    fn project_with(model_ids: &[(&str, u16, u16)]) -> ShowProject {
        let models = builtin_models();
        let mut p: ShowProject = serde_json::from_str(r#"{"durationMs":1000}"#).unwrap();
        p.fixture_models = models;
        for (i, (model, universe, address)) in model_ids.iter().enumerate() {
            p.fixtures.push(FixtureInstance {
                id: format!("f{i}"),
                name: format!("F{i}"),
                model_id: (*model).to_owned(),
                universe: *universe,
                address: *address,
            });
        }
        p
    }

    fn rgbw_id() -> String {
        builtin_models()
            .into_iter()
            .find(|m| {
                m.properties.iter().any(|p| p.function == ChannelFunction::White)
                    && m.properties.iter().any(|p| p.function == ChannelFunction::Red)
            })
            .expect("应有 RGBW 内置模型")
            .id
    }

    #[test]
    fn 编译定位被驱动通道并收集_universe() {
        let id = rgbw_id();
        let p = project_with(&[(&id, 3, 1), (&id, 1, 10)]);
        let c = compile(&p);
        assert!(c.warnings().is_empty());
        assert_eq!(c.universes(), &[1, 3]);
        let f0 = &c.fixtures[0];
        assert_eq!(c.universes[f0.universe_index], 3);
        assert!(f0.driven.has_rgb());
        assert!(f0.driven.white.is_some());
        // 第二台灯起始地址 10，通道偏移 = 9 + 属性通道 - 1。
        let r1 = c.fixtures[1].driven.red.expect("红光");
        assert!(r1.offset >= 9);
    }

    #[test]
    fn 未知模型_越界地址被跳过并告警() {
        let id = rgbw_id();
        let mut p = project_with(&[("nope", 0, 1), (&id, 0, 512), (&id, 5000, 1)]);
        p.fixtures.push(FixtureInstance {
            id: "fz".into(),
            name: String::new(),
            model_id: id.clone(),
            universe: 0,
            address: 0,
        });
        let c = compile(&p);
        assert!(c.fixtures.is_empty());
        assert_eq!(c.warnings().len(), 4);
        assert!(matches!(c.warnings()[0], CompileWarning::UnknownModel { .. }));
        assert!(matches!(c.warnings()[1], CompileWarning::OutOfRange { .. }));
    }

    #[test]
    fn 摇头灯的非驱动通道写入默认值() {
        use crate::fixture::FixtureProperty;
        let prop = |function, channel: u16, width: u8, big_endian, default_value| FixtureProperty {
            name: String::new(),
            code: format!("P{channel}"),
            function,
            channel,
            width,
            big_endian,
            default_value,
            value_desc: String::new(),
            description: String::new(),
        };
        let head = FixtureModel {
            id: "9.1.1.1".into(),
            name: "头灯".into(),
            system: String::new(),
            product_type: String::new(),
            builtin: false,
            properties: vec![
                prop(ChannelFunction::Pan, 1, 2, true, 32768),
                prop(ChannelFunction::Tilt, 3, 2, false, 0x1234),
                prop(ChannelFunction::Shutter, 5, 1, true, 105),
                prop(ChannelFunction::Dimmer, 6, 1, true, 0),
            ],
        };
        let mut p = project_with(&[("9.1.1.1", 0, 11)]);
        p.fixture_models.push(head);
        let c = compile(&p);
        assert!(c.warnings().is_empty());
        // 起始地址 11 → 偏移 10。
        assert_eq!(&c.base[0][10..12], &[0x80, 0x00]);
        assert_eq!(&c.base[0][12..14], &[0x34, 0x12]);
        assert_eq!(c.base[0][14], 105);
        // 调光是被驱动通道，底图保持 0。
        assert_eq!(c.base[0][15], 0);
        assert_eq!(c.fixtures[0].driven.dimmer.map(|s| s.offset), Some(15));
    }

    #[test]
    fn 静音与独奏过滤轨道() {
        let id = rgbw_id();
        let mut p = project_with(&[(&id, 0, 1), (&id, 0, 20)]);
        for i in 0..2 {
            p.tracks.push(Track {
                id: format!("t{i}"),
                target: TrackTarget::Fixture { id: format!("f{i}") },
                mute: false,
                solo: false,
            });
        }
        p.tracks[0].mute = true;
        assert_eq!(compile(&p).tracks.len(), 1);
        p.tracks[0].mute = false;
        p.tracks[1].solo = true;
        let c = compile(&p);
        assert_eq!(c.tracks.len(), 1);
        assert_eq!(c.tracks[0].id, "t1");
    }

    #[test]
    fn 分组轨道保持成员顺序并忽略失效成员() {
        let id = rgbw_id();
        let mut p = project_with(&[(&id, 0, 1), (&id, 0, 20), (&id, 0, 40)]);
        p.groups.push(FixtureGroup {
            id: "g".into(),
            name: String::new(),
            fixture_ids: vec!["f2".into(), "ghost".into(), "f0".into()],
        });
        p.tracks.push(Track {
            id: "t".into(),
            target: TrackTarget::Group { id: "g".into() },
            mute: false,
            solo: false,
        });
        let c = compile(&p);
        assert_eq!(c.tracks[0].fixtures, vec![2, 0]);
    }

    #[test]
    fn 编译警告按驼峰序列化() {
        let w = CompileWarning::OutOfRange { fixture_id: "f1".into() };
        assert_eq!(
            serde_json::to_value(&w).unwrap(),
            serde_json::json!({ "kind": "outOfRange", "fixtureId": "f1" })
        );
    }

    #[test]
    fn 槽位写入_8位与16位字节序() {
        let mut d: DmxData = [0; 512];
        Slot { offset: 0, width: 1, big_endian: true }.write(&mut d, 0.5);
        assert_eq!(d[0], 128);
        Slot { offset: 1, width: 2, big_endian: true }.write(&mut d, 1.0);
        assert_eq!(&d[1..3], &[255, 255]);
        Slot { offset: 3, width: 2, big_endian: true }.write(&mut d, 0.5);
        assert_eq!(&d[3..5], &[128, 0]);
        Slot { offset: 5, width: 2, big_endian: false }.write(&mut d, 0.5);
        assert_eq!(&d[5..7], &[0, 128]);
        Slot { offset: 7, width: 1, big_endian: true }.write(&mut d, 9.0);
        assert_eq!(d[7], 255);
    }
}
