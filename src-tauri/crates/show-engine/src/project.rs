//! 节目工程的后端镜像。
//!
//! 与前端 `src/features/show-editor/lib/project.ts` 的 `ShowProject` 逐字段对应（JSON 采用
//! camelCase）。后端只关心“输出灯光”所需的部分：灯具、Patch、分组、轨道、Cue、节拍与输出设置；
//! 音视频引用、标记点、备注等仅服务于编辑界面的字段在反序列化时被忽略。
//!
//! 时间一律为整数毫秒。

use serde::{Deserialize, Serialize};

use crate::fixture::FixtureModel;
pub use crate::look::{ColorParam, ColorValue, Look, NumParam, Spread};

/// 输出帧率（固定 30 FPS）。
pub const OUTPUT_FPS: u32 = 30;

/// 一帧的时长（毫秒，取整）。
pub const FRAME_MS: i64 = 1000 / OUTPUT_FPS as i64;

/// Universe 编号上限（`.artrec` 规范：net 0~127 × subuni 0~15）。
pub const MAX_UNIVERSE: u16 = 2047;

/// 灯具实例：模型在节目里的一次实例化，同时记录 DMX 地址。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureInstance {
    /// 实例编号。
    pub id: String,
    /// 显示名。
    #[serde(default)]
    pub name: String,
    /// 所用模型编号，对应 [`ShowProject::fixture_models`]。
    pub model_id: String,
    /// Universe 编号，0 起。
    pub universe: u16,
    /// 起始地址，1~512。
    pub address: u16,
    /// 所用通道模式编号（对应 [`FixtureModel::modes`]）；`None` 为默认模式。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    /// 舞台位置（按位置展开的分布用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<StagePlacement>,
    /// 多重配接：同样的输出再写到这些地址。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mirrors: Vec<PatchAddress>,
}

/// 一个 DMX 地址。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchAddress {
    /// Universe，0 起。
    pub universe: u16,
    /// 起始地址，1~512。
    pub address: u16,
}

/// 灯具在舞台上的位置（米）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagePlacement {
    /// 横向，向右为正。
    pub x: f64,
    /// 纵深，向后为正。
    pub y: f64,
}

/// 灯具分组：成员顺序决定特效沿灯具推进时的先后。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureGroup {
    /// 分组编号。
    pub id: String,
    /// 分组名。
    #[serde(default)]
    pub name: String,
    /// 成员灯具实例编号（有序）。
    pub fixture_ids: Vec<String>,
}

/// 轨道绑定的对象。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TrackTarget {
    /// 单个灯具。
    Fixture {
        /// 灯具实例编号。
        id: String,
    },
    /// 一个分组。
    Group {
        /// 分组编号。
        id: String,
    },
    /// 场景轨道：片段自带灯具列表（见 [`SceneClip`]）。
    Scene,
}

/// 时间线轨道。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// 轨道编号。
    pub id: String,
    /// 绑定的灯具或分组。
    pub target: TrackTarget,
    /// 静音：不输出。
    #[serde(default)]
    pub mute: bool,
    /// 独奏：存在任何独奏轨道时只输出独奏轨道。
    #[serde(default)]
    pub solo: bool,
    /// 置顶层：本轨道的颜色 / 属性在所有其它轨道之后应用（LTP 永远胜出），编辑器的编程器预览用。
    #[serde(default)]
    pub on_top: bool,
}

/// 淡入淡出的缓动曲线。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Easing {
    /// 线性。
    Linear,
    /// 三次缓入缓出。
    EaseInOut,
    /// S 曲线（smoothstep）。
    SCurve,
}

/// 内置特效类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectId {
    /// 呼吸。
    Breathe,
    /// 彩虹。
    Rainbow,
    /// 追逐。
    Chase,
    /// 擦除。
    Wipe,
    /// 渐变。
    Gradient,
    /// 脉冲。
    Pulse,
    /// 闪烁。
    Sparkle,
    /// 频闪。
    Strobe,
}

/// 特效周期。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EffectPeriod {
    /// 固定毫秒数。
    Ms {
        /// 周期（毫秒）。
        ms: f64,
    },
    /// 按 BPM 的拍数。
    Beats {
        /// 拍数。
        beats: f64,
    },
}

/// Cue 的公共字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueBase {
    /// Cue 编号。
    pub id: String,
    /// 所在轨道编号。
    pub track_id: String,
    /// 起点（毫秒，含）。
    pub start_ms: i64,
    /// 终点（毫秒，不含）。
    pub end_ms: i64,
    /// 亮度，0~100。
    pub brightness: f64,
    /// 淡入时长（毫秒）。
    pub fade_in_ms: i64,
    /// 淡出时长（毫秒）。
    pub fade_out_ms: i64,
    /// 缓动曲线。
    pub easing: Easing,
}

/// 静态 Cue：固定颜色。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticCue {
    /// 公共字段。
    #[serde(flatten)]
    pub base: CueBase,
    /// 颜色，每个分量 0~255。
    pub rgb: [u8; 3],
}

/// 特效 Cue：在块的时间范围内持续运行的程序化效果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectCue {
    /// 公共字段。
    #[serde(flatten)]
    pub base: CueBase,
    /// 特效类型。
    pub effect: EffectId,
    /// 1~4 个颜色。
    pub colors: Vec<[u8; 3]>,
    /// 周期。
    pub period: EffectPeriod,
    /// 沿灯具的相位扩散，0~1。
    pub phase_spread: f64,
    /// 方向：`1` 正向，`-1` 反向。
    pub direction: i8,
    /// 亮度范围，0~100。
    pub range: [f64; 2],
    /// 随机种子。
    pub seed: u32,
}

/// 属性分层片段：在轨道（灯具 / 分组）上显示一个外观，可带多灯分布。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookClip {
    /// 公共字段。
    #[serde(flatten)]
    pub base: CueBase,
    /// 外观。
    pub look: Look,
    /// 多灯分布。
    #[serde(default)]
    pub spread: Option<Spread>,
}

/// 场景片段里一台灯具的外观。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEntry {
    /// 灯具实例编号。
    pub fixture_id: String,
    /// 外观（只写参与的层）。
    pub look: Look,
}

/// 场景片段：同一时刻给多台灯具分别设定外观，放在场景轨道上。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneClip {
    /// 公共字段。
    #[serde(flatten)]
    pub base: CueBase,
    /// 各灯具的外观。
    pub entries: Vec<SceneEntry>,
}

/// 时间线上的片段（Cue）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Cue {
    /// 静态颜色。
    Static(StaticCue),
    /// 程序化特效。
    Effect(EffectCue),
    /// 属性分层片段。
    Look(LookClip),
    /// 场景片段。
    Scene(SceneClip),
}

impl Cue {
    /// Cue 的公共字段。
    ///
    /// # Returns
    ///
    /// 不论 Cue 种类，返回其 [`CueBase`] 引用。
    #[must_use]
    pub fn base(&self) -> &CueBase {
        match self {
            Self::Static(c) => &c.base,
            Self::Effect(c) => &c.base,
            Self::Look(c) => &c.base,
            Self::Scene(c) => &c.base,
        }
    }
}

/// 预设：可被片段引用的外观。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    /// 预设编号。
    pub id: String,
    /// 显示名。
    #[serde(default)]
    pub name: String,
    /// 外观。
    pub look: Look,
}

/// 通道锁定（Park）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkEntry {
    /// Universe。
    pub universe: u16,
    /// 通道 1~512。
    pub channel: u16,
    /// 输出值 0~255。
    pub value: u8,
}

/// 节拍设置。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tempo {
    /// 每分钟拍数。
    pub bpm: f64,
    /// 第一拍相对 0 点的偏移（毫秒）。
    #[serde(default)]
    pub offset_ms: f64,
    /// 每小节拍数。
    #[serde(default = "default_beats_per_bar")]
    pub beats_per_bar: u32,
}

fn default_beats_per_bar() -> u32 {
    4
}

/// 输出设置。
///
/// 输出目标保持为 `serde_json::Value`：`show-engine` 不依赖 `host-core`，
/// 由 Tauri 外壳把它解析成 `DispatchTarget`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    /// 输出目标（`{"kind":"forwarding"}` 或 `{"kind":"direct",...}`）。
    #[serde(default)]
    pub target: serde_json::Value,
    /// 播放到结尾后是否循环。
    #[serde(default, rename = "loop")]
    pub looping: bool,
    /// 输出延迟补偿（毫秒）。
    #[serde(default)]
    pub latency_comp_ms: i64,
    /// Gamma，1.0 为线性。
    #[serde(default = "default_gamma")]
    pub gamma: f64,
    /// Universe 路由表（原样转交 Tauri 外壳解析）。
    #[serde(default)]
    pub universes: serde_json::Value,
    /// 多 Universe 帧同步设置（原样转交 Tauri 外壳解析）。
    #[serde(default)]
    pub sync: serde_json::Value,
    /// 通道锁定。
    #[serde(default)]
    pub park: Vec<ParkEntry>,
}

fn default_gamma() -> f64 {
    2.2
}

impl Default for OutputSettings {
    fn default() -> Self {
        Self {
            target: serde_json::Value::Null,
            looping: false,
            latency_comp_ms: 0,
            gamma: default_gamma(),
            universes: serde_json::Value::Null,
            sync: serde_json::Value::Null,
            park: Vec::new(),
        }
    }
}

/// 节目工程（后端视角）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowProject {
    /// 工程名称。
    #[serde(default)]
    pub name: String,
    /// 节目总时长（毫秒）。
    pub duration_ms: i64,
    /// 所用灯具模型的快照。
    #[serde(default)]
    pub fixture_models: Vec<FixtureModel>,
    /// 灯具实例。
    #[serde(default)]
    pub fixtures: Vec<FixtureInstance>,
    /// 灯具分组。
    #[serde(default)]
    pub groups: Vec<FixtureGroup>,
    /// 轨道。
    #[serde(default)]
    pub tracks: Vec<Track>,
    /// Cue。
    #[serde(default)]
    pub cues: Vec<Cue>,
    /// 节拍设置。
    #[serde(default)]
    pub tempo: Option<Tempo>,
    /// 输出设置。
    #[serde(default)]
    pub output: OutputSettings,
    /// 预设库。
    #[serde(default)]
    pub presets: Vec<Preset>,
    /// A-B 循环区间。
    #[serde(default)]
    pub loop_range: Option<LoopRange>,
}

/// A-B 循环区间（毫秒）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopRange {
    /// 起点。
    pub start_ms: i64,
    /// 终点。
    pub end_ms: i64,
}

impl ShowProject {
    /// 合法的 A-B 循环区间：终点大于起点，并夹在节目时长内。
    ///
    /// # Returns
    ///
    /// `(起点, 终点)`；没有设置或不合法时为 `None`。
    #[must_use]
    pub fn valid_loop_range(&self) -> Option<(i64, i64)> {
        let r = self.loop_range?;
        let start = r.start_ms.clamp(0, self.duration_ms.max(0));
        let end = r.end_ms.clamp(0, self.duration_ms.max(0));
        (end > start).then_some((start, end))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 前端形态的工程能反序列化() {
        let json = r#"{
            "version": 1, "name": "demo", "notes": "忽略", "durationMs": 5000,
            "fixtureModels": [], "media": [], "markers": [],
            "fixtures": [{"id":"f1","name":"灯","modelId":"1.5.1.4","universe":0,"address":1}],
            "groups": [{"id":"g1","name":"组","fixtureIds":["f1"]}],
            "tracks": [{"id":"t1","target":{"kind":"fixture","id":"f1"},"mute":false,"solo":true,"lock":false}],
            "cues": [
              {"kind":"static","id":"c1","trackId":"t1","startMs":0,"endMs":1000,"brightness":100,
               "fadeInMs":0,"fadeOutMs":0,"easing":"sCurve","rgb":[255,0,0]},
              {"kind":"effect","id":"c2","trackId":"t1","startMs":1000,"endMs":2000,"brightness":80,
               "fadeInMs":0,"fadeOutMs":0,"easing":"linear","effect":"breathe","colors":[[1,2,3]],
               "period":{"kind":"beats","beats":2},"phaseSpread":0.5,"direction":-1,"range":[0,100],"seed":7}
            ],
            "tempo": {"bpm": 120, "offsetMs": 0, "beatsPerBar": 4},
            "output": {"target":{"kind":"forwarding"},"loop":true,"latencyCompMs":-20,"gamma":2.2}
        }"#;
        let p: ShowProject = serde_json::from_str(json).expect("应能解析");
        assert_eq!(p.duration_ms, 5000);
        assert_eq!(p.cues.len(), 2);
        assert!(matches!(p.cues[0], Cue::Static(_)));
        let Cue::Effect(e) = &p.cues[1] else { panic!("应为特效") };
        assert_eq!(e.effect, EffectId::Breathe);
        assert_eq!(e.direction, -1);
        assert!(matches!(e.period, EffectPeriod::Beats { beats } if (beats - 2.0).abs() < 1e-9));
        assert!(p.output.looping);
        assert_eq!(p.output.latency_comp_ms, -20);
        assert_eq!(p.cues[0].base().easing, Easing::SCurve);
        assert!(p.tracks[0].solo);
    }

    #[test]
    fn 缺省字段使用默认值() {
        let p: ShowProject = serde_json::from_str(r#"{"durationMs": 1000}"#).expect("应能解析");
        assert!(p.fixtures.is_empty());
        assert!((p.output.gamma - 2.2).abs() < 1e-9);
        assert!(!p.output.looping);
    }
}
