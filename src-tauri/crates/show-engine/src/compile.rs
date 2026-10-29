//! 工程编译：把 [`ShowProject`] 预处理成可高效求值的 [`CompiledShow`]。
//!
//! 编译阶段完成所有与时间无关的工作：
//!
//! - 解析灯具模型与所选模式，算出每台灯具被混色驱动的通道（发光体 / 调光 / 开关）与
//!   属性通道（Pan / Tilt / 图案…）的位置，选定混色策略；
//! - 把不受驱动的通道的默认值预先写进“底图”，并记录多重配接与通道锁定（Park）；
//! - 展开轨道绑定（灯具 / 分组按成员顺序，场景片段解析成灯具下标），应用静音 / 独奏；
//! - 解析外观引用的预设、按分布顺序排好成员，过滤非法片段并按起点排序。

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use crate::envelope::sanitize_gamma;
use crate::fixture::{footprint, ChannelFunction, FixtureModel, FixtureProperty, DMX_CHANNELS};
use crate::look::{Look, Spread, SpreadOrder, SpreadRange};
use crate::mix::{
    ColorMixer, Emitters, AMBER, B, COMPONENTS, CW, DIM, G, INDIGO, LIME, R, SW, UV, W, WW,
};
use crate::project::{Cue, CueBase, ShowProject, Tempo, TrackTarget, MAX_UNIVERSE};

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
        let frac = if frac.is_nan() { 0.0 } else { frac.clamp(0.0, 1.0) };
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

/// 灯具被混色器驱动的通道。
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
    /// 琥珀。
    pub amber: Option<Slot>,
    /// 紫外。
    pub uv: Option<Slot>,
    /// 青柠。
    pub lime: Option<Slot>,
    /// 靛蓝。
    pub indigo: Option<Slot>,
    /// 调光。
    pub dimmer: Option<Slot>,
    /// 开关。
    pub switch: Option<Slot>,
}

impl Driven {
    /// 按混色分量下标（见 [`crate::mix`]）排列的通道位置。
    ///
    /// # Returns
    ///
    /// 长度为 [`COMPONENTS`] 的数组，第 `k` 项是分量 `k` 的通道（没有时为 `None`）。
    #[must_use]
    pub fn slots(&self) -> [Option<Slot>; COMPONENTS] {
        let mut s = [None; COMPONENTS];
        s[R] = self.red;
        s[G] = self.green;
        s[B] = self.blue;
        s[W] = self.white;
        s[CW] = self.cool;
        s[WW] = self.warm;
        s[AMBER] = self.amber;
        s[UV] = self.uv;
        s[LIME] = self.lime;
        s[INDIGO] = self.indigo;
        s[DIM] = self.dimmer;
        s[SW] = self.switch;
        s
    }

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

/// 一个属性通道（Pan / Tilt / 图案…）：由外观的 `attrs` 层驱动，取值为 0~1 DMX 分数。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AttrSlot {
    /// 通道功能。
    pub function: ChannelFunction,
    /// 通道位置。
    pub slot: Slot,
    /// 反向输出。
    pub invert: bool,
    /// 默认值的分数（LTP 从默认值开始淡入）。
    pub default: f64,
}

/// 一台已编译的灯具。
#[derive(Debug, Clone)]
pub struct CompiledFixture {
    /// 灯具实例编号。
    pub id: String,
    /// 在 [`CompiledShow::universes`] 里的下标。
    pub universe_index: usize,
    /// 被驱动的通道（多头灯取每种功能第一次出现的通道，混色按它判断灯具能力）。
    pub driven: Driven,
    /// 与 `driven` 同一分量输出相同值的其它通道（多头灯的其余像素）：`(分量下标, 通道)`。
    pub mirrors: Vec<(usize, Slot)>,
    /// 混色器（按通道组成与发光体校准选定的策略）。
    pub mixer: ColorMixer,
    /// 属性通道。
    pub attrs: Vec<AttrSlot>,
    /// 灯具占用的通道区间：`(起始偏移, 通道数)`，多重配接时整段复制。
    pub span: (u16, u16),
    /// 多重配接的目标：`(Universe 下标, 起始偏移)`。
    pub copies: Vec<(usize, u16)>,
    /// 舞台位置（按位置排序的分布用）。
    pub stage: Option<(f64, f64)>,
}

/// 一个已编译的片段。
#[derive(Debug, Clone)]
pub enum CompiledCue {
    /// 静态 / 特效 Cue（v1）：按片段混色后与其它片段逐分量取最大（HTP）。
    Legacy(Cue),
    /// 属性分层片段：外观已合并预设，`members` 是按分布顺序排好的轨道成员下标（指向灯具列表）。
    Look {
        /// 公共字段。
        base: CueBase,
        /// 外观。
        look: Look,
        /// 分布（已解析键名）。
        spread: Option<CompiledSpread>,
        /// 按分布顺序的成员（灯具下标）。
        members: Vec<usize>,
    },
    /// 场景片段：`(灯具下标, 外观)`。
    Scene {
        /// 公共字段。
        base: CueBase,
        /// 各灯具的外观（已合并预设）。
        entries: Vec<(usize, Look)>,
    },
}

impl CompiledCue {
    /// 片段的公共字段。
    ///
    /// # Returns
    ///
    /// [`CueBase`] 引用。
    #[must_use]
    pub fn base(&self) -> &CueBase {
        match self {
            Self::Legacy(c) => c.base(),
            Self::Look { base, .. } | Self::Scene { base, .. } => base,
        }
    }
}

/// 已解析键名的分布：位置分数与延迟沿用 [`Spread`]，各量的起止值按类别拆开。
#[derive(Debug, Clone)]
pub struct CompiledSpread {
    /// 原始分布（位置分数、分翼、延迟）。
    pub spread: Spread,
    /// 强度（%）的起止值。
    pub intensity: Option<SpreadRange>,
    /// 色相偏移（度）的起止值。
    pub hue: Option<SpreadRange>,
    /// 属性（DMX 分数）的起止值。
    pub attrs: Vec<(ChannelFunction, SpreadRange)>,
    /// 数值曲线的相位偏移（周期的分数）的起止值：追逐 / 波浪特效让每台灯错开相位，周期保持一致。
    pub phase: Option<SpreadRange>,
}

impl CompiledSpread {
    fn new(spread: &Spread) -> Self {
        let mut attrs = Vec::new();
        for (key, range) in &spread.values {
            if key == "intensity" || key == "hue" || key == "phase" {
                continue;
            }
            if let Ok(f) = serde_json::from_value::<ChannelFunction>(serde_json::Value::String(key.clone())) {
                attrs.push((f, *range));
            }
        }
        Self {
            intensity: spread.values.get("intensity").copied(),
            hue: spread.values.get("hue").copied(),
            phase: spread.values.get("phase").copied(),
            attrs,
            spread: spread.clone(),
        }
    }
}

/// 一条已编译的轨道。
#[derive(Debug, Clone)]
pub struct CompiledTrack {
    /// 轨道编号。
    pub id: String,
    /// 轨道驱动的灯具（下标指向已编译灯具列表，分组保持成员顺序；场景轨道为空）。
    pub fixtures: Vec<usize>,
    /// 按起点排序的片段。
    pub cues: Vec<CompiledCue>,
    /// 置顶层（见 [`crate::project::Track::on_top`]）。
    pub on_top: bool,
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
    /// 灯具选用的通道模式在模型里不存在。
    UnknownMode {
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
    /// 通道锁定：`(Universe 下标, 偏移, 值)`，最后写入。
    pub(crate) park: Vec<(usize, u16, u8)>,
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

    /// 参与输出的灯具实例编号（编译顺序，与 [`CompiledShow::preview_colors`] 一致）。
    ///
    /// # Returns
    ///
    /// 灯具实例编号的迭代器。
    pub fn fixture_ids(&self) -> impl Iterator<Item = &str> {
        self.fixtures.iter().map(|f| f.id.as_str())
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
/// 非法的灯具（模型缺失 / 未通过校验 / 模式不存在 / 地址越界）被跳过并记入警告，不会让编译失败；
/// 空工程也能编译，输出为空。越界的多重配接地址与 Park 条目被忽略。
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
    // 显示色 ↔ 线性输出的换算（界面颜色、色温、发光体校准与预览都用它）
    let gamma = sanitize_gamma(project.output.gamma);
    let mut warnings = Vec::new();
    let accepted = accept_fixtures(project, &mut warnings);

    let park_entries: Vec<_> = project
        .output
        .park
        .iter()
        .filter(|p| (1..=DMX_CHANNELS).contains(&p.channel) && p.universe <= MAX_UNIVERSE)
        .collect();
    let universes: Vec<u16> = accepted
        .iter()
        .flat_map(|a| std::iter::once(a.universe).chain(a.copies.iter().map(|c| c.0)))
        .chain(park_entries.iter().map(|p| p.universe))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let index_of = |u: u16| universes.binary_search(&u).unwrap_or(0);
    let mut base: Vec<DmxData> = vec![[0u8; DMX_CHANNELS as usize]; universes.len()];

    // 底图只含不受驱动通道的默认值；被驱动的通道在求值时才写入。
    let fixtures: Vec<CompiledFixture> = accepted
        .iter()
        .map(|a| {
            let universe_index = index_of(a.universe);
            let (driven, mirrors, attrs) = layout_fixture(a, &mut base[universe_index]);
            let origin = a.address - 1;
            let span = (origin, footprint(a.layout));
            let copies: Vec<(usize, u16)> = a.copies.iter().map(|&(u, addr)| (index_of(u), addr - 1)).collect();
            // 多重配接的副本也带上默认值
            for &(ui, dest) in &copies {
                let (src, dst) = split_pair(&mut base, universe_index, ui);
                let (s, n) = (usize::from(span.0), usize::from(span.1));
                let d = usize::from(dest);
                match dst {
                    Some(dst) => dst[d..d + n].copy_from_slice(&src[s..s + n]),
                    None => src.copy_within(s..s + n, d),
                }
            }
            CompiledFixture {
                id: a.id.to_owned(),
                universe_index,
                mixer: ColorMixer::for_fixture(&driven, Emitters::from_model(a.model, gamma)),
                driven,
                mirrors,
                attrs,
                span,
                copies,
                stage: a.stage,
            }
        })
        .collect();

    let park: Vec<(usize, u16, u8)> =
        park_entries.iter().map(|p| (index_of(p.universe), p.channel - 1, p.value)).collect();
    for &(ui, offset, value) in &park {
        base[ui][usize::from(offset)] = value;
    }

    CompiledShow {
        duration_ms: project.duration_ms.max(0),
        gamma,
        tempo: project.tempo,
        universes,
        base,
        tracks: build_tracks(project, &fixtures),
        fixtures,
        warnings,
        park,
    }
}

/// 同时借出两个 Universe 的数据（相同下标时只借一个）。
pub(crate) fn split_pair(base: &mut [DmxData], a: usize, b: usize) -> (&mut DmxData, Option<&mut DmxData>) {
    if a == b {
        return (&mut base[a], None);
    }
    if a < b {
        let (lo, hi) = base.split_at_mut(b);
        (&mut lo[a], Some(&mut hi[0]))
    } else {
        let (lo, hi) = base.split_at_mut(a);
        (&mut hi[0], Some(&mut lo[b]))
    }
}

/// 通过校验的灯具实例及其模型。
struct Accepted<'a> {
    id: &'a str,
    universe: u16,
    address: u16,
    /// 所选模式的通道布局。
    layout: &'a [FixtureProperty],
    /// 模型（发光体校准等）。
    model: &'a FixtureModel,
    /// 合法的多重配接目标 `(Universe, 地址)`。
    copies: Vec<(u16, u16)>,
    stage: Option<(f64, f64)>,
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
    let fits = |universe: u16, address: u16, count: u16| {
        let end = u32::from(address.saturating_sub(1)) + u32::from(count);
        address != 0 && end <= u32::from(DMX_CHANNELS) && universe <= MAX_UNIVERSE
    };
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
        let Some(layout) = model.layout(f.mode_id.as_deref()) else {
            warnings.push(CompileWarning::UnknownMode { fixture_id: f.id.clone() });
            continue;
        };
        let count = footprint(layout);
        if !fits(f.universe, f.address, count) {
            warnings.push(CompileWarning::OutOfRange { fixture_id: f.id.clone() });
            continue;
        }
        let copies = f
            .mirrors
            .iter()
            .filter(|m| fits(m.universe, m.address, count))
            .map(|m| (m.universe, m.address))
            .collect();
        accepted.push(Accepted {
            id: &f.id,
            universe: f.universe,
            address: f.address,
            layout,
            model,
            copies,
            stage: f.stage.map(|s| (s.x, s.y)),
        });
    }
    accepted
}

/// 确定灯具被驱动的通道位置，并把其余通道的默认值写进 `base`。
///
/// 同一发光体 / 调光功能出现多次（多头灯的各像素）时，第一次出现的进入 [`Driven`]，其余作为镜像通道，
/// 输出与第一次相同的值。其余功能（`Other` 除外）成为属性通道。
fn layout_fixture(a: &Accepted<'_>, base: &mut DmxData) -> (Driven, Vec<(usize, Slot)>, Vec<AttrSlot>) {
    let origin = a.address - 1;
    let mut driven = Driven::default();
    let mut mirrors = Vec::new();
    let mut attrs = Vec::new();
    for p in a.layout {
        let slot = Slot {
            offset: origin + p.channel - 1,
            width: p.width,
            big_endian: p.big_endian,
        };
        let target = match p.function {
            ChannelFunction::Red => Some((&mut driven.red, R)),
            ChannelFunction::Green => Some((&mut driven.green, G)),
            ChannelFunction::Blue => Some((&mut driven.blue, B)),
            ChannelFunction::White => Some((&mut driven.white, W)),
            ChannelFunction::CoolWhite => Some((&mut driven.cool, CW)),
            ChannelFunction::WarmWhite => Some((&mut driven.warm, WW)),
            ChannelFunction::Amber => Some((&mut driven.amber, AMBER)),
            ChannelFunction::Uv => Some((&mut driven.uv, UV)),
            ChannelFunction::Lime => Some((&mut driven.lime, LIME)),
            ChannelFunction::Indigo => Some((&mut driven.indigo, INDIGO)),
            ChannelFunction::Dimmer => Some((&mut driven.dimmer, DIM)),
            ChannelFunction::Switch => Some((&mut driven.switch, SW)),
            _ => None,
        };
        match target {
            Some((t, _)) if t.is_none() => *t = Some(slot),
            Some((_, component)) => mirrors.push((component, slot)),
            None => {
                write_default(base, slot, p.default_value);
                if p.function != ChannelFunction::Other {
                    let raw = f64::from(p.default_value) / f64::from(p.max_value());
                    attrs.push(AttrSlot {
                        function: p.function,
                        slot,
                        invert: p.invert,
                        // 默认值换算到“用户空间”（反向通道的用户值 = 1 - DMX 分数）
                        default: if p.invert { 1.0 - raw } else { raw },
                    });
                }
            }
        }
    }
    (driven, mirrors, attrs)
}

/// 展开轨道绑定（灯具、分组或场景），应用静音 / 独奏，并为每条轨道编译排好序的片段。
fn build_tracks(project: &ShowProject, fixtures: &[CompiledFixture]) -> Vec<CompiledTrack> {
    let index_of: HashMap<&str, usize> = fixtures
        .iter()
        .enumerate()
        .map(|(i, f)| (f.id.as_str(), i))
        .collect();
    let presets: HashMap<&str, &Look> = project.presets.iter().map(|p| (p.id.as_str(), &p.look)).collect();
    let resolve = |look: &Look| -> Look {
        match look.preset_id.as_deref().and_then(|id| presets.get(id)) {
            Some(preset) => look.over(preset),
            None => Look { preset_id: None, ..look.clone() },
        }
    };
    let any_solo = project.tracks.iter().any(|t| t.solo);

    let mut tracks = Vec::new();
    for t in &project.tracks {
        let audible = if any_solo { t.solo } else { !t.mute };
        if !audible {
            continue;
        }
        let scene = matches!(t.target, TrackTarget::Scene);
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
            TrackTarget::Scene => Vec::new(),
        };
        let mut cues: Vec<CompiledCue> = project
            .cues
            .iter()
            // 禁用的片段不输出
            .filter(|c| c.base().track_id == t.id && c.base().end_ms > c.base().start_ms && !c.base().disabled)
            .filter_map(|c| match c {
                // 场景片段只在场景轨道上有效，其它片段只在灯具 / 分组轨道上有效
                Cue::Scene(s) if scene => Some(CompiledCue::Scene {
                    base: s.base.clone(),
                    entries: s
                        .entries
                        .iter()
                        .filter_map(|e| index_of.get(e.fixture_id.as_str()).map(|&i| (i, resolve(&e.look))))
                        .collect(),
                }),
                Cue::Look(l) if !scene => Some(CompiledCue::Look {
                    base: l.base.clone(),
                    look: resolve(&l.look),
                    members: ordered(&members, l.spread.as_ref(), fixtures),
                    spread: l.spread.as_ref().map(CompiledSpread::new),
                }),
                Cue::Static(_) | Cue::Effect(_) if !scene => Some(CompiledCue::Legacy(c.clone())),
                _ => None,
            })
            .collect();
        cues.sort_by_key(|c| c.base().start_ms);
        tracks.push(CompiledTrack {
            id: t.id.clone(),
            fixtures: members,
            cues,
            on_top: t.on_top,
        });
    }
    tracks
}

/// 按分布顺序排列成员。
fn ordered(members: &[usize], spread: Option<&Spread>, fixtures: &[CompiledFixture]) -> Vec<usize> {
    let mut out = members.to_vec();
    let key = |i: usize, axis: usize| {
        fixtures[i].stage.map_or(f64::INFINITY, |(x, y)| if axis == 0 { x } else { y })
    };
    match spread.and_then(|s| s.order).unwrap_or_default() {
        SpreadOrder::Members => {}
        SpreadOrder::Reverse => out.reverse(),
        SpreadOrder::StageX => out.sort_by(|a, b| key(*a, 0).total_cmp(&key(*b, 0))),
        SpreadOrder::StageY => out.sort_by(|a, b| key(*a, 1).total_cmp(&key(*b, 1))),
    }
    out
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
                mode_id: None,
                stage: None,
                mirrors: Vec::new(),
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
            mode_id: None,
            stage: None,
            mirrors: Vec::new(),
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
            ..FixtureProperty::default()
        };
        let head = FixtureModel {
            id: "9.1.1.1".into(),
            name: "头灯".into(),
            properties: vec![
                prop(ChannelFunction::Pan, 1, 2, true, 32768),
                prop(ChannelFunction::Tilt, 3, 2, false, 0x1234),
                prop(ChannelFunction::Shutter, 5, 1, true, 105),
                prop(ChannelFunction::Dimmer, 6, 1, true, 0),
            ],
            ..FixtureModel::default()
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
                on_top: false,
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
            on_top: false,
        });
        let c = compile(&p);
        assert_eq!(c.tracks[0].fixtures, vec![2, 0]);
    }

    #[test]
    fn 按所选模式布局通道_未知模式告警() {
        use crate::fixture::{FixtureMode, FixtureProperty};
        let p = |function, channel: u16| FixtureProperty {
            code: format!("P{channel}"),
            function,
            channel,
            width: 1,
            ..FixtureProperty::default()
        };
        let m = FixtureModel {
            id: "9.2.1.1".into(),
            name: "双模式".into(),
            properties: vec![p(ChannelFunction::Dimmer, 1)],
            modes: vec![FixtureMode {
                id: "5ch".into(),
                name: "5ch".into(),
                properties: vec![
                    p(ChannelFunction::Dimmer, 1),
                    p(ChannelFunction::Red, 2),
                    p(ChannelFunction::Green, 3),
                    p(ChannelFunction::Blue, 4),
                    p(ChannelFunction::Shutter, 5),
                ],
            }],
            ..FixtureModel::default()
        };
        let mut proj = project_with(&[("9.2.1.1", 0, 1), ("9.2.1.1", 0, 10), ("9.2.1.1", 0, 20)]);
        proj.fixture_models.push(m);
        proj.fixtures[1].mode_id = Some("5ch".into());
        proj.fixtures[2].mode_id = Some("ghost".into());
        let c = compile(&proj);
        assert_eq!(c.fixtures.len(), 2);
        assert!(!c.fixtures[0].driven.has_rgb());
        assert_eq!(c.fixtures[1].driven.blue.map(|s| s.offset), Some(12));
        assert_eq!(c.base[0][14], 0, "Shutter 默认值 0（属性里写的默认值）");
        assert_eq!(c.warnings(), &[CompileWarning::UnknownMode { fixture_id: "f2".into() }]);
    }

    #[test]
    fn 多头灯的其余像素成为镜像通道() {
        use crate::fixture::{FixtureProperty, MatrixLayout};
        let p = |function, channel: u16, head| FixtureProperty {
            code: format!("P{channel}"),
            function,
            channel,
            width: 1,
            head,
            ..FixtureProperty::default()
        };
        let bar = FixtureModel {
            id: "9.3.1.1".into(),
            name: "灯条".into(),
            properties: vec![
                p(ChannelFunction::Dimmer, 1, 0),
                p(ChannelFunction::Red, 2, 1),
                p(ChannelFunction::Red, 3, 2),
                p(ChannelFunction::Red, 4, 3),
            ],
            matrix: Some(MatrixLayout { cols: 3, rows: 1 }),
            ..FixtureModel::default()
        };
        let mut proj = project_with(&[("9.3.1.1", 0, 1)]);
        proj.fixture_models.push(bar);
        let c = compile(&proj);
        let f = &c.fixtures[0];
        assert_eq!(f.driven.red.map(|s| s.offset), Some(1));
        let offsets: Vec<(usize, u16)> = f.mirrors.iter().map(|(k, s)| (*k, s.offset)).collect();
        assert_eq!(offsets, vec![(R, 2), (R, 3)]);
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
