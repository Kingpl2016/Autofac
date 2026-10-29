//! 灯具物模型：通道对象、能力区间、模式、多头矩阵、发光体与校验。
//!
//! 一个 [`FixtureModel`] 描述一类灯具（模板）。它的通道布局由若干 [`FixtureProperty`]
//! （通道对象）组成，每个通道对象占用 1 或 2 个连续 DMX 通道（16 位属性如摇头灯的 Pan / Tilt），
//! 并可以带若干 [`Capability`]（DMX 取值区间的语义，例如 `0~20 关闭`、`21~255 打开`）。
//!
//! - `properties` 是**默认模式**的通道布局；同一灯具的其它通道模式（例如 6ch / 9ch）放在
//!   `modes` 里，各自有完整的通道布局。灯具实例经 `modeId` 选用其中之一。
//! - 多头 / 像素灯在 `matrix` 里声明像素排布，通道对象经 `head` 指明属于哪个像素（`0` 为整灯）。
//! - `emitters` 描述各色 LED 的实际颜色（色温），供混色引擎校准；`physical` 记录光束角、
//!   Pan / Tilt 行程等物理参数，供舞台预览计算光束。
//!
//! 新字段全部带默认值，旧版（只有 `properties`）的模型 JSON 不经迁移即可读取。
//!
//! 模型编号 `id` 的格式为 `[表号].[序号].[系统].[类型]`，例如 `1.5.1.4` 是 RGBW 全彩灯，
//! 表号 1 为标准物模型、2 为自定义物模型（见 `DMX物模型表.xlsx` 的“概念说明”）。

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 一个 Universe 的 DMX 通道数。
pub const DMX_CHANNELS: u16 = 512;

/// 单个模式最多的通道对象数。
pub const MAX_PROPERTIES: usize = 256;

/// 模型编号的最大长度（字符数）。
pub const MAX_ID_LEN: usize = 64;

/// 单个模型最多的附加模式数（OFL 里像素灯常有二三十个模式）。
pub const MAX_MODES: usize = 32;

/// 多头矩阵最多的像素数。
pub const MAX_HEADS: u16 = 512;

/// 单个通道对象最多的能力区间数。
pub const MAX_CAPABILITIES: usize = 64;

/// 属性功能组：检查器按组分区显示控件，合成与预设也按组进行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum AttributeGroup {
    /// 强度：开关、调光、频闪。
    Intensity,
    /// 颜色：各色光、色温、CMY、颜色轮。
    Color,
    /// 位置：Pan / Tilt 与云台速度。
    Position,
    /// 光束：图案、棱镜、雾化、光圈。
    Beam,
    /// 调焦：调焦与变焦。
    Focus,
    /// 控制：宏、复位与未识别功能。
    Control,
}

/// 多个片段写同一通道时的合成规则。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum Precedence {
    /// 取最大值（Highest Takes Precedence），用于亮度类通道。
    Htp,
    /// 后来者优先（Latest Takes Precedence），用于位置、图案等通道。
    Ltp,
}

/// 通道属性的功能。
///
/// 求值器按功能驱动通道：强度与颜色类由混色引擎驱动，其余功能由属性层与特效驱动；
/// 片段不涉及的通道输出默认值（见 [`ChannelFunction::default_value`]）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum ChannelFunction {
    /// 开关（0 关，1~255 开）。
    Switch,
    /// 调光 / 亮度。
    Dimmer,
    /// 红光。
    Red,
    /// 绿光。
    Green,
    /// 蓝光。
    Blue,
    /// 白光。
    White,
    /// 冷白。
    CoolWhite,
    /// 暖白。
    WarmWhite,
    /// 琥珀光。
    Amber,
    /// 紫外光。
    Uv,
    /// 青柠光。
    Lime,
    /// 靛蓝光（加色发光体）。
    Indigo,
    /// 青（CMY 减色混合）。
    Cyan,
    /// 品红（CMY 减色混合）。
    Magenta,
    /// 黄（CMY 减色混合）。
    Yellow,
    /// 色温通道（CTC，数值对应色温）。
    ColorTemp,
    /// 水平旋转。
    Pan,
    /// 垂直俯仰。
    Tilt,
    /// 云台速度。
    Speed,
    /// 频闪 / 切光。
    Shutter,
    /// 颜色轮。
    ColorWheel,
    /// 颜色轮整轮旋转（彩虹效果）。
    ColorWheelRotate,
    /// 图案盘。
    Gobo,
    /// 图案旋转。
    GoboRotate,
    /// 棱镜。
    Prism,
    /// 棱镜旋转。
    PrismRotate,
    /// 雾化。
    Frost,
    /// 调焦。
    Focus,
    /// 变焦。
    Zoom,
    /// 光圈。
    Iris,
    /// 图案抖动。
    GoboShake,
    /// 切光刀片插入。
    Blade,
    /// 切光刀片或刀片系统旋转。
    BladeRotate,
    /// 光束旋转（未指明对象的旋转，例如整个光束组件）。
    Rotation,
    /// 烟雾 / 雾机输出。
    Fog,
    /// 内置程序 / 特效的速度或参数。
    EffectSpeed,
    /// 维护功能（灯泡开关、风扇、显示屏等，不含复位）。
    Maintenance,
    /// 宏功能。
    Macro,
    /// 灯具复位。
    Reset,
    /// 其他（未识别的功能，按默认值输出）。
    #[default]
    Other,
}

impl ChannelFunction {
    /// 由属性名里的英文代码识别功能。
    ///
    /// 比较时忽略大小写、空白、`/`、`_` 与 `-`，因此 `Color Wheel`、`ColorWheel`、
    /// `Shutter/Strobe` 都能识别；表格里的拼写错误 `Swtch` 也按开关处理。
    ///
    /// # Arguments
    ///
    /// * `code` - 属性名中下划线之后的英文代码，例如 `Red`、`Shutter/Strobe`。
    ///
    /// # Returns
    ///
    /// 识别出的功能；无法识别时为 [`ChannelFunction::Other`]。
    #[must_use]
    pub fn from_code(code: &str) -> Self {
        let key: String = code
            .chars()
            .filter(|c| !c.is_whitespace() && !matches!(c, '/' | '_' | '-'))
            .collect::<String>()
            .to_ascii_lowercase();
        match key.as_str() {
            "swtch" | "switch" | "onoff" => Self::Switch,
            "bright" | "brightness" | "dimmer" | "intensity" => Self::Dimmer,
            "red" => Self::Red,
            "green" => Self::Green,
            "blue" => Self::Blue,
            "white" => Self::White,
            "coolwhite" | "coldwhite" => Self::CoolWhite,
            "warmwhite" => Self::WarmWhite,
            "amber" => Self::Amber,
            "uv" | "ultraviolet" => Self::Uv,
            "lime" => Self::Lime,
            "indigo" => Self::Indigo,
            "cyan" => Self::Cyan,
            "magenta" => Self::Magenta,
            "yellow" => Self::Yellow,
            "cct" | "ctc" | "colortemp" | "colortemperature" => Self::ColorTemp,
            "pan" => Self::Pan,
            "tilt" => Self::Tilt,
            "speed" | "pantiltspeed" => Self::Speed,
            "shutter" | "strobe" | "shutterstrobe" => Self::Shutter,
            "colorwheel" | "color" => Self::ColorWheel,
            "colorwheelrotate" | "colorwheelrotation" => Self::ColorWheelRotate,
            "gobo" | "gobowheel" => Self::Gobo,
            "goborotate" | "goborotation" => Self::GoboRotate,
            "prism" => Self::Prism,
            "prismrotate" | "prismrotation" => Self::PrismRotate,
            "frost" => Self::Frost,
            "focus" => Self::Focus,
            "zoom" => Self::Zoom,
            "iris" => Self::Iris,
            "goboshake" => Self::GoboShake,
            "blade" | "blades" | "bladeinsertion" | "shaper" => Self::Blade,
            "bladerotate" | "bladerotation" | "bladesystemrotation" => Self::BladeRotate,
            "rotation" | "beamrotation" => Self::Rotation,
            "fog" | "haze" | "fogoutput" | "smoke" => Self::Fog,
            "effectspeed" | "programspeed" | "showspeed" => Self::EffectSpeed,
            "maintenance" | "lamp" | "lampcontrol" => Self::Maintenance,
            "macro" => Self::Macro,
            "reset" => Self::Reset,
            _ => Self::Other,
        }
    }

    /// 功能所属的属性组。
    ///
    /// # Returns
    ///
    /// 检查器分区、预设分类所用的 [`AttributeGroup`]。
    #[must_use]
    pub fn group(self) -> AttributeGroup {
        match self {
            Self::Switch | Self::Dimmer | Self::Shutter => AttributeGroup::Intensity,
            Self::Red
            | Self::Green
            | Self::Blue
            | Self::White
            | Self::CoolWhite
            | Self::WarmWhite
            | Self::Amber
            | Self::Uv
            | Self::Lime
            | Self::Indigo
            | Self::Cyan
            | Self::Magenta
            | Self::Yellow
            | Self::ColorTemp
            | Self::ColorWheel
            | Self::ColorWheelRotate => AttributeGroup::Color,
            Self::Pan | Self::Tilt | Self::Speed => AttributeGroup::Position,
            Self::Gobo
            | Self::GoboRotate
            | Self::GoboShake
            | Self::Prism
            | Self::PrismRotate
            | Self::Frost
            | Self::Iris
            | Self::Blade
            | Self::BladeRotate
            | Self::Rotation => AttributeGroup::Beam,
            Self::Focus | Self::Zoom => AttributeGroup::Focus,
            Self::Macro
            | Self::Reset
            | Self::Fog
            | Self::EffectSpeed
            | Self::Maintenance
            | Self::Other => AttributeGroup::Control,
        }
    }

    /// 是否是一路加色发光体（混色引擎按“发光体”分配颜色的通道）。
    ///
    /// # Returns
    ///
    /// 红、绿、蓝、白、冷白、暖白、琥珀、紫外、青柠、靛蓝返回 `true`。
    #[must_use]
    pub fn is_emitter(self) -> bool {
        matches!(
            self,
            Self::Red
                | Self::Green
                | Self::Blue
                | Self::White
                | Self::CoolWhite
                | Self::WarmWhite
                | Self::Amber
                | Self::Uv
                | Self::Lime
                | Self::Indigo
        )
    }

    /// 该功能默认的合成规则。
    ///
    /// # Returns
    ///
    /// 调光与加色发光体为 [`Precedence::Htp`]，其余为 [`Precedence::Ltp`]。
    #[must_use]
    pub fn default_precedence(self) -> Precedence {
        if self == Self::Dimmer || self.is_emitter() {
            Precedence::Htp
        } else {
            Precedence::Ltp
        }
    }

    /// 该功能在同一个头里至多出现一次（出现多次没有意义）。
    ///
    /// # Returns
    ///
    /// 开关、调光、各色光、CMY 与色温功能返回 `true`，其余返回 `false`。
    #[must_use]
    pub fn is_unique(self) -> bool {
        matches!(
            self,
            Self::Switch | Self::Dimmer | Self::Cyan | Self::Magenta | Self::Yellow | Self::ColorTemp
        ) || self.is_emitter()
    }

    /// 该功能在“灯具不受控”时应输出的默认值，保证灯具处于可用状态。
    ///
    /// 例如频闪通道默认输出“常亮开光”，否则摇头灯即使亮度拉满也不出光；
    /// 云台居中；其余功能为 0。
    ///
    /// # Arguments
    ///
    /// * `width` - 属性占用的通道数（1 或 2）；16 位的 Pan / Tilt 居中值为 `32768`。
    ///
    /// # Returns
    ///
    /// 默认值，范围 `0..=255`（单通道）或 `0..=65535`（双通道）。
    #[must_use]
    pub fn default_value(self, width: u8) -> u16 {
        match self {
            // 云台与调焦居中。
            Self::Pan | Self::Tilt | Self::Focus => {
                if width >= 2 {
                    32768
                } else {
                    128
                }
            }
            // 通用摇头灯频闪通道的 104~107 为“常亮开光”。
            Self::Shutter => 105,
            _ => 0,
        }
    }
}

/// 一个能力区间：通道取值落在 `range` 内时灯具的行为。
///
/// 区间分两类：*阶梯*（整个区间效果相同，例如“图案 3”）与*比例*（效果随取值线性变化，
/// 例如“Pan 0°~540°”）。比例区间用 `physical` 记录起止物理量，单位见 `unit`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Capability {
    /// DMX 起止值（均含），按所属通道对象的位宽（8 位 0~255，16 位 0~65535）。
    pub range: [u16; 2],
    /// 显示名，例如 `开光`、`图案 3`。
    #[serde(default)]
    pub label: String,
    /// 是否为比例区间。
    #[serde(default, skip_serializing_if = "is_false")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub proportional: bool,
    /// 比例区间的起止物理量（例如 `[0.0, 540.0]`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub physical: Option<[f64; 2]>,
    /// 物理量单位，例如 `deg`、`Hz`、`%`、`K`；没有单位为空串。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub unit: String,
    /// 颜色轮槽位等的代表色（sRGB）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub color: Option<[u8; 3]>,
    /// 区间的语义（开光、关光、频闪、槽位…），供引擎与特效生成器按语义选值；未知时为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub tag: Option<CapabilityTag>,
}

/// 能力区间的语义标签（来自 OFL 能力类型，自定义模型可手动设置）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum CapabilityTag {
    /// 快门全开（常亮出光）。
    ShutterOpen,
    /// 快门关闭（不出光）。
    ShutterClosed,
    /// 频闪 / 脉冲 / 渐变等快门效果；`physical` 为频率时单位是 `Hz`。
    Strobe,
    /// 无功能（空档）。
    NoFunction,
    /// 选择色轮 / 图案轮等的槽位。
    Slot,
    /// 连续旋转（色轮、图案、棱镜等），`physical` 为转速。
    Rotation,
    /// 内置程序 / 特效。
    Effect,
    /// 维护功能（复位、灯泡、风扇等）。
    Maintenance,
}

impl FixtureProperty {
    /// 找到第一个带指定语义标签的能力区间。
    ///
    /// # Arguments
    ///
    /// * `tag` - 语义标签。
    ///
    /// # Returns
    ///
    /// 第一个匹配的区间；没有时为 `None`。
    #[must_use]
    pub fn capability_tagged(&self, tag: CapabilityTag) -> Option<&Capability> {
        self.capabilities.iter().find(|c| c.tag == Some(tag))
    }
}

/// 灯具的一个通道对象。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct FixtureProperty {
    /// 属性的中文显示名，例如 `红光`。
    pub name: String,
    /// 属性的英文代码，例如 `Red`、`Shutter/Strobe`。
    pub code: String,
    /// 属性功能，决定求值器如何驱动该通道。
    pub function: ChannelFunction,
    /// 起始通道，取值 1~512（相对灯具起始地址，从 1 开始）。
    pub channel: u16,
    /// 占用的连续通道数：1 为 8 位，2 为 16 位。
    #[cfg_attr(feature = "ts", ts(type = "1 | 2"))]
    pub width: u8,
    /// 多通道属性的字节序：`true` 为大端（低通道放高字节）。单通道属性忽略。
    pub big_endian: bool,
    /// 默认值（范围随 `width`：8 位 0~255，16 位 0~65535）。
    pub default_value: u16,
    /// DMX 数值说明，例如 `0~255:红光值`。
    #[serde(default)]
    pub value_desc: String,
    /// 字段描述，例如 `0为关，255为最亮`。
    #[serde(default)]
    pub description: String,
    /// 高亮值：编程器“高亮”所选灯具时输出的值；`None` 为最大值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub highlight_value: Option<u16>,
    /// 合成规则；`None` 时取 [`ChannelFunction::default_precedence`]。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub precedence: Option<Precedence>,
    /// 是否反向（输出 `max - 值`），用于倒装的摇头灯等。
    #[serde(default, skip_serializing_if = "is_false")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub invert: bool,
    /// 所属像素头：`0` 为整灯（主控），`1..=n` 为 `matrix` 里按行优先编号的像素。
    #[serde(default, skip_serializing_if = "is_zero")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub head: u16,
    /// 能力区间，按 DMX 值升序且互不重叠；为空表示整段线性。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub capabilities: Vec<Capability>,
}

impl FixtureProperty {
    /// 属性占用的最后一个通道。
    ///
    /// # Returns
    ///
    /// `channel + width - 1`。
    #[must_use]
    pub fn end_channel(&self) -> u16 {
        self.channel + u16::from(self.width) - 1
    }

    /// 属性值的上限。
    ///
    /// # Returns
    ///
    /// 8 位属性为 `255`，16 位属性为 `65535`。
    #[must_use]
    pub fn max_value(&self) -> u16 {
        if self.width >= 2 {
            u16::MAX
        } else {
            255
        }
    }

    /// 实际生效的合成规则。
    ///
    /// # Returns
    ///
    /// 显式设置的 `precedence`，否则为功能的默认规则。
    #[must_use]
    pub fn effective_precedence(&self) -> Precedence {
        self.precedence
            .unwrap_or_else(|| self.function.default_precedence())
    }

    /// 查找某个 DMX 值所在的能力区间。
    ///
    /// # Arguments
    ///
    /// * `value` - DMX 值（按本属性位宽）。
    ///
    /// # Returns
    ///
    /// 包含 `value` 的能力区间；没有定义区间或不在任何区间内时为 `None`。
    #[must_use]
    pub fn capability_at(&self, value: u16) -> Option<&Capability> {
        self.capabilities
            .iter()
            .find(|c| c.range[0] <= value && value <= c.range[1])
    }
}

/// 灯具的一个附加通道模式（例如 6ch、9ch），带完整的通道布局。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct FixtureMode {
    /// 模式编号，在模型内唯一，不能是空串（空串保留给默认模式）。
    pub id: String,
    /// 显示名，例如 `9 通道`。
    pub name: String,
    /// 该模式的通道布局。
    pub properties: Vec<FixtureProperty>,
}

/// 多头 / 像素灯的像素排布（行优先编号，从 1 开始）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct MatrixLayout {
    /// 列数（横向像素数），至少 1。
    pub cols: u16,
    /// 行数（纵向像素数），至少 1。
    pub rows: u16,
}

impl MatrixLayout {
    /// 像素总数。
    ///
    /// # Returns
    ///
    /// `cols × rows`（饱和乘法）。
    #[must_use]
    pub fn heads(&self) -> u16 {
        self.cols.saturating_mul(self.rows)
    }
}

/// 一路发光体的实际颜色，供混色引擎校准（未声明的发光体按理想颜色计算）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Emitter {
    /// 对应的功能（必须是加色发光体，见 [`ChannelFunction::is_emitter`]）。
    pub function: ChannelFunction,
    /// 满亮时的显示颜色（sRGB）；`None` 时按功能的理想颜色或 `kelvin` 推算。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub rgb: Option<[u8; 3]>,
    /// 白光类发光体的色温（K）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub kelvin: Option<u16>,
    /// 相对亮度权重（1.0 为与红绿蓝同等亮度）。
    #[serde(default = "one", skip_serializing_if = "is_one")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub intensity: f64,
}

/// 灯具的物理参数（舞台预览据此计算光束）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Physical {
    /// Pan 总行程（度），例如 540。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub pan_range_deg: Option<f64>,
    /// Tilt 总行程（度），例如 270。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub tilt_range_deg: Option<f64>,
    /// 最小光束角（度）；没有变焦时即光束角。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub beam_min_deg: Option<f64>,
    /// 最大光束角（度）；没有变焦时与最小值相同或省略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub beam_max_deg: Option<f64>,
}

/// 灯具物模型（一类灯具的模板）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct FixtureModel {
    /// 模型编号，格式 `[表号].[序号].[系统].[类型]`，全库唯一。
    pub id: String,
    /// 模型名称，例如 `RGBW全彩灯`。
    pub name: String,
    /// 系统，例如 `照明`、`电动照明`。
    #[serde(default)]
    pub system: String,
    /// 产品类型，例如 `全彩`、`摇头灯`。
    #[serde(default)]
    pub product_type: String,
    /// 是否为内置模型（内置模型只读）。
    #[serde(default)]
    pub builtin: bool,
    /// 默认模式的通道布局。
    pub properties: Vec<FixtureProperty>,
    /// 制造商。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub manufacturer: String,
    /// 默认模式的显示名；空串时界面显示“默认”。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub default_mode_name: String,
    /// 附加通道模式。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub modes: Vec<FixtureMode>,
    /// 多头 / 像素排布；单头灯为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub matrix: Option<MatrixLayout>,
    /// 发光体校准。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "ts", ts(as = "Option<_>", optional))]
    pub emitters: Vec<Emitter>,
    /// 物理参数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub physical: Option<Physical>,
    /// 模型来源（OFL 导入时记录灯具标识与识别规则版本，用于判断是否需要重新导入）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub source: Option<ModelSource>,
}

/// 模型来源。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ModelSource {
    /// 来源库：目前只有 `ofl`。
    pub kind: String,
    /// 来源里的标识，例如 OFL 的 `制造商/灯具`。
    pub key: String,
    /// 导入时的识别规则版本（见 `OFL_RECOGNIZER_VERSION`）；比当前版本旧时可重新导入。
    pub recognizer: u32,
}

impl FixtureModel {
    /// 灯具在默认模式下占用的 DMX 通道数（从通道 1 到最后一个被占用通道，中间的空洞也计入）。
    ///
    /// # Returns
    ///
    /// 最大的 [`FixtureProperty::end_channel`]；没有属性时为 0。
    #[must_use]
    pub fn channel_count(&self) -> u16 {
        footprint(&self.properties)
    }

    /// 取某个模式的通道布局。
    ///
    /// # Arguments
    ///
    /// * `mode_id` - 模式编号；`None` 或空串表示默认模式。
    ///
    /// # Returns
    ///
    /// 该模式的通道对象；模式不存在时为 `None`。
    #[must_use]
    pub fn layout(&self, mode_id: Option<&str>) -> Option<&[FixtureProperty]> {
        match mode_id {
            None | Some("") => Some(&self.properties),
            Some(id) => self
                .modes
                .iter()
                .find(|m| m.id == id)
                .map(|m| m.properties.as_slice()),
        }
    }

    /// 像素头数量。
    ///
    /// # Returns
    ///
    /// 有 `matrix` 时为像素总数，否则为 0（单头灯）。
    #[must_use]
    pub fn head_count(&self) -> u16 {
        self.matrix.map_or(0, |m| m.heads())
    }

    /// 查找某个发光体的校准数据。
    ///
    /// # Arguments
    ///
    /// * `function` - 发光体功能。
    ///
    /// # Returns
    ///
    /// 声明过时返回校准数据，否则为 `None`。
    #[must_use]
    pub fn emitter(&self, function: ChannelFunction) -> Option<&Emitter> {
        self.emitters.iter().find(|e| e.function == function)
    }

    /// 校验模型是否合法。
    ///
    /// # Errors
    ///
    /// - 编号或名称为空、编号过长时返回 [`FixtureError::EmptyId`] / [`FixtureError::IdTooLong`] /
    ///   [`FixtureError::EmptyName`]。
    /// - 像素排布为 0 或过大时返回 [`FixtureError::BadMatrix`]。
    /// - 模式编号为空、重复或模式过多时返回 [`FixtureError::BadMode`]。
    /// - 任一模式的通道布局不合法时返回对应变体（见 [`validate_layout`]）。
    pub fn validate(&self) -> Result<(), FixtureError> {
        let id = self.id.trim();
        if id.is_empty() {
            return Err(FixtureError::EmptyId);
        }
        if id.chars().count() > MAX_ID_LEN {
            return Err(FixtureError::IdTooLong);
        }
        if self.name.trim().is_empty() {
            return Err(FixtureError::EmptyName);
        }
        if let Some(m) = self.matrix
            && (m.cols == 0 || m.rows == 0 || m.heads() > MAX_HEADS) {
                return Err(FixtureError::BadMatrix);
            }
        if self.modes.len() > MAX_MODES {
            return Err(FixtureError::BadMode { id: String::new() });
        }
        for (i, mode) in self.modes.iter().enumerate() {
            let mid = mode.id.trim();
            if mid.is_empty() || self.modes[..i].iter().any(|m| m.id == mode.id) {
                return Err(FixtureError::BadMode { id: mode.id.clone() });
            }
        }
        let heads = self.head_count();
        validate_layout(&self.properties, heads)?;
        for mode in &self.modes {
            validate_layout(&mode.properties, heads)?;
        }
        Ok(())
    }
}

/// 一个通道布局占用的通道数。
///
/// # Arguments
///
/// * `props` - 通道布局。
///
/// # Returns
///
/// 最大的结束通道；为空时为 0。
#[must_use]
pub fn footprint(props: &[FixtureProperty]) -> u16 {
    props.iter().map(FixtureProperty::end_channel).max().unwrap_or(0)
}

/// 校验一个通道布局。
///
/// # Arguments
///
/// * `props` - 通道布局。
/// * `heads` - 模型的像素头数量（单头灯为 0）。
///
/// # Errors
///
/// - 没有属性或属性过多时返回 [`FixtureError::NoProperties`] / [`FixtureError::TooManyProperties`]。
/// - 属性宽度不是 1 或 2、通道越界、默认值或高亮值超出范围时返回对应变体。
/// - 属性所属像素头超出排布时返回 [`FixtureError::HeadOutOfRange`]。
/// - 能力区间越界、起止颠倒、未升序或互相重叠时返回 [`FixtureError::BadCapability`]。
/// - 属性占用的通道重叠时返回 [`FixtureError::Overlap`]。
/// - 开关、调光、各色光等功能在同一像素头里重复出现时返回 [`FixtureError::DuplicateFunction`]。
pub fn validate_layout(props: &[FixtureProperty], heads: u16) -> Result<(), FixtureError> {
    if props.is_empty() {
        return Err(FixtureError::NoProperties);
    }
    if props.len() > MAX_PROPERTIES {
        return Err(FixtureError::TooManyProperties);
    }
    for p in props {
        if !(1..=2).contains(&p.width) {
            return Err(FixtureError::BadWidth {
                code: p.code.clone(),
                width: p.width,
            });
        }
        if p.channel == 0 || p.end_channel() > DMX_CHANNELS {
            return Err(FixtureError::ChannelOutOfRange {
                code: p.code.clone(),
                channel: p.channel,
            });
        }
        let max = p.max_value();
        if p.default_value > max || p.highlight_value.is_some_and(|v| v > max) {
            return Err(FixtureError::DefaultOutOfRange {
                code: p.code.clone(),
            });
        }
        if p.head > heads {
            return Err(FixtureError::HeadOutOfRange {
                code: p.code.clone(),
            });
        }
        validate_capabilities(p)?;
    }
    if let Some((a, b)) = find_overlap(props) {
        return Err(FixtureError::Overlap { a, b });
    }
    for (i, p) in props.iter().enumerate() {
        if p.function.is_unique()
            && props[..i]
                .iter()
                .any(|q| q.function == p.function && q.head == p.head)
        {
            return Err(FixtureError::DuplicateFunction(p.function));
        }
    }
    Ok(())
}

/// 校验通道对象的能力区间：在位宽范围内、起止不颠倒、升序且互不重叠。
fn validate_capabilities(p: &FixtureProperty) -> Result<(), FixtureError> {
    let bad = || FixtureError::BadCapability {
        code: p.code.clone(),
    };
    if p.capabilities.len() > MAX_CAPABILITIES {
        return Err(bad());
    }
    let max = p.max_value();
    let mut prev_end: Option<u16> = None;
    for c in &p.capabilities {
        let [lo, hi] = c.range;
        if lo > hi || hi > max {
            return Err(bad());
        }
        if prev_end.is_some_and(|e| lo <= e) {
            return Err(bad());
        }
        if let Some([a, b]) = c.physical
            && (!a.is_finite() || !b.is_finite()) {
                return Err(bad());
            }
        prev_end = Some(hi);
    }
    Ok(())
}

/// 物模型校验错误。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FixtureError {
    /// 模型编号为空。
    #[error("模型编号不能为空")]
    EmptyId,
    /// 模型编号超过 [`MAX_ID_LEN`] 个字符。
    #[error("模型编号过长")]
    IdTooLong,
    /// 模型名称为空。
    #[error("模型名称不能为空")]
    EmptyName,
    /// 模型没有任何属性。
    #[error("模型至少需要一个通道属性")]
    NoProperties,
    /// 属性数超过 [`MAX_PROPERTIES`]。
    #[error("模型的属性数量过多")]
    TooManyProperties,
    /// 属性宽度不是 1 或 2。
    #[error("属性 {code} 的占通道数 {width} 无效，只能是 1 或 2")]
    BadWidth {
        /// 属性英文代码。
        code: String,
        /// 非法的宽度。
        width: u8,
    },
    /// 属性的通道范围超出 1~512。
    #[error("属性 {code} 的通道 {channel} 超出 1~512 范围")]
    ChannelOutOfRange {
        /// 属性英文代码。
        code: String,
        /// 起始通道。
        channel: u16,
    },
    /// 属性默认值或高亮值超出其位宽的取值范围。
    #[error("属性 {code} 的默认值超出范围")]
    DefaultOutOfRange {
        /// 属性英文代码。
        code: String,
    },
    /// 两个属性占用了相同的通道。
    #[error("属性 {a} 与 {b} 占用的通道重叠")]
    Overlap {
        /// 重叠的第一个属性的英文代码。
        a: String,
        /// 重叠的第二个属性的英文代码。
        b: String,
    },
    /// 开关、调光、各色光等功能在同一像素头里出现了多次。
    #[error("功能 {0:?} 在同一模型里只能出现一次")]
    DuplicateFunction(ChannelFunction),
    /// 能力区间越界、颠倒、未升序或重叠。
    #[error("属性 {code} 的能力区间无效")]
    BadCapability {
        /// 属性英文代码。
        code: String,
    },
    /// 模式编号为空、重复，或模式过多。
    #[error("通道模式 {id} 无效")]
    BadMode {
        /// 出问题的模式编号（模式过多时为空串）。
        id: String,
    },
    /// 像素排布的行列为 0 或像素过多。
    #[error("像素排布无效")]
    BadMatrix,
    /// 属性所属像素头超出排布。
    #[error("属性 {code} 所属的像素头不存在")]
    HeadOutOfRange {
        /// 属性英文代码。
        code: String,
    },
}

impl FixtureError {
    /// 机器可读的错误码，前端据此选择本地化文案。
    ///
    /// # Returns
    ///
    /// 形如 `empty_id`、`overlap` 的蛇形命名错误码。
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptyId => "empty_id",
            Self::IdTooLong => "id_too_long",
            Self::EmptyName => "empty_name",
            Self::NoProperties => "no_properties",
            Self::TooManyProperties => "too_many_properties",
            Self::BadWidth { .. } => "bad_width",
            Self::ChannelOutOfRange { .. } => "channel_out_of_range",
            Self::DefaultOutOfRange { .. } => "default_out_of_range",
            Self::Overlap { .. } => "overlap",
            Self::DuplicateFunction(_) => "duplicate_function",
            Self::BadCapability { .. } => "bad_capability",
            Self::BadMode { .. } => "bad_mode",
            Self::BadMatrix => "bad_matrix",
            Self::HeadOutOfRange { .. } => "head_out_of_range",
        }
    }
}

/// 找出第一对占用通道重叠的属性。
///
/// # Arguments
///
/// * `props` - 待检查的属性列表。
///
/// # Returns
///
/// 重叠的两个属性的英文代码；没有重叠时为 `None`。
#[must_use]
pub fn find_overlap(props: &[FixtureProperty]) -> Option<(String, String)> {
    for (i, a) in props.iter().enumerate() {
        for b in &props[i + 1..] {
            if a.channel <= b.end_channel() && b.channel <= a.end_channel() {
                return Some((a.code.clone(), b.code.clone()));
            }
        }
    }
    None
}

/// 按属性的书写顺序从通道 1 开始连续重新分配起始通道。
///
/// 标准物模型表里同一模型的各属性起始通道都写成 1，实际含义是“按行顺序依次排布”。
///
/// # Arguments
///
/// * `props` - 要重新分配通道的属性列表，原地修改。
pub fn reassign_sequential(props: &mut [FixtureProperty]) {
    let mut next = 1u16;
    for p in props {
        p.channel = next;
        next = next.saturating_add(u16::from(p.width));
    }
}

#[expect(clippy::trivially_copy_pass_by_ref, reason = "serde skip_serializing_if 要求 fn(&T) -> bool 签名")]
fn is_false(v: &bool) -> bool {
    !*v
}

#[expect(clippy::trivially_copy_pass_by_ref, reason = "serde skip_serializing_if 要求 fn(&T) -> bool 签名")]
fn is_zero(v: &u16) -> bool {
    *v == 0
}

#[expect(clippy::trivially_copy_pass_by_ref, reason = "serde skip_serializing_if 要求 fn(&T) -> bool 签名")]
fn is_one(v: &f64) -> bool {
    (*v - 1.0).abs() < f64::EPSILON
}

fn one() -> f64 {
    1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prop(code: &str, function: ChannelFunction, channel: u16, width: u8) -> FixtureProperty {
        FixtureProperty {
            name: code.to_owned(),
            code: code.to_owned(),
            function,
            channel,
            width,
            big_endian: true,
            ..FixtureProperty::default()
        }
    }

    fn model(props: Vec<FixtureProperty>) -> FixtureModel {
        FixtureModel {
            id: "9.9.9.9".into(),
            name: "测试灯".into(),
            properties: props,
            ..FixtureModel::default()
        }
    }

    fn cap(lo: u16, hi: u16) -> Capability {
        Capability { range: [lo, hi], label: format!("{lo}-{hi}"), ..Capability::default() }
    }

    #[test]
    fn 功能代码忽略大小写空白与分隔符() {
        assert_eq!(ChannelFunction::from_code("Red"), ChannelFunction::Red);
        assert_eq!(ChannelFunction::from_code("Color Wheel"), ChannelFunction::ColorWheel);
        assert_eq!(ChannelFunction::from_code("Shutter/Strobe"), ChannelFunction::Shutter);
        assert_eq!(ChannelFunction::from_code("Swtch"), ChannelFunction::Switch);
        assert_eq!(ChannelFunction::from_code("Bright"), ChannelFunction::Dimmer);
        assert_eq!(ChannelFunction::from_code(" PrismRotate "), ChannelFunction::PrismRotate);
        assert_eq!(ChannelFunction::from_code("Mystery"), ChannelFunction::Other);
    }

    #[test]
    fn 新增功能可识别并归入正确的组() {
        assert_eq!(ChannelFunction::from_code("Amber"), ChannelFunction::Amber);
        assert_eq!(ChannelFunction::from_code("UV"), ChannelFunction::Uv);
        assert_eq!(ChannelFunction::from_code("Color Temperature"), ChannelFunction::ColorTemp);
        assert_eq!(ChannelFunction::from_code("Gobo Rotation"), ChannelFunction::GoboRotate);
        assert_eq!(ChannelFunction::Amber.group(), AttributeGroup::Color);
        assert_eq!(ChannelFunction::Zoom.group(), AttributeGroup::Focus);
        assert_eq!(ChannelFunction::Iris.group(), AttributeGroup::Beam);
        assert_eq!(ChannelFunction::Shutter.group(), AttributeGroup::Intensity);
        assert_eq!(ChannelFunction::Tilt.group(), AttributeGroup::Position);
        // OFL 适配新增的功能
        assert_eq!(ChannelFunction::from_code("Indigo"), ChannelFunction::Indigo);
        assert!(ChannelFunction::Indigo.is_emitter() && ChannelFunction::Indigo.is_unique());
        assert_eq!(ChannelFunction::Indigo.default_precedence(), Precedence::Htp);
        assert_eq!(ChannelFunction::from_code("Color Wheel Rotation"), ChannelFunction::ColorWheelRotate);
        assert_eq!(ChannelFunction::ColorWheelRotate.group(), AttributeGroup::Color);
        assert_eq!(ChannelFunction::from_code("Blade Insertion"), ChannelFunction::Blade);
        assert_eq!(ChannelFunction::BladeRotate.group(), AttributeGroup::Beam);
        assert_eq!(ChannelFunction::Rotation.group(), AttributeGroup::Beam);
        assert_eq!(ChannelFunction::from_code("Haze"), ChannelFunction::Fog);
        for f in [ChannelFunction::Fog, ChannelFunction::EffectSpeed, ChannelFunction::Maintenance] {
            assert_eq!(f.group(), AttributeGroup::Control);
            assert!(!f.is_unique() && !f.is_emitter());
        }
    }

    #[test]
    fn 合成规则默认值与显式覆盖() {
        assert_eq!(ChannelFunction::Dimmer.default_precedence(), Precedence::Htp);
        assert_eq!(ChannelFunction::Lime.default_precedence(), Precedence::Htp);
        assert_eq!(ChannelFunction::Pan.default_precedence(), Precedence::Ltp);
        assert_eq!(ChannelFunction::Cyan.default_precedence(), Precedence::Ltp);
        let mut p = prop("D", ChannelFunction::Dimmer, 1, 1);
        assert_eq!(p.effective_precedence(), Precedence::Htp);
        p.precedence = Some(Precedence::Ltp);
        assert_eq!(p.effective_precedence(), Precedence::Ltp);
    }

    #[test]
    fn 默认值让灯具处于可用状态() {
        assert_eq!(ChannelFunction::Shutter.default_value(1), 105);
        assert_eq!(ChannelFunction::Pan.default_value(2), 32768);
        assert_eq!(ChannelFunction::Pan.default_value(1), 128);
        assert_eq!(ChannelFunction::Red.default_value(1), 0);
    }

    #[test]
    fn 合法模型通过校验且通道数取最大结束通道() {
        let m = model(vec![
            prop("Pan", ChannelFunction::Pan, 1, 2),
            prop("Dimmer", ChannelFunction::Dimmer, 6, 1),
        ]);
        assert_eq!(m.validate(), Ok(()));
        assert_eq!(m.channel_count(), 6);
    }

    #[test]
    fn 通道重叠被拒绝() {
        let m = model(vec![
            prop("Pan", ChannelFunction::Pan, 1, 2),
            prop("Tilt", ChannelFunction::Tilt, 2, 2),
        ]);
        assert_eq!(
            m.validate(),
            Err(FixtureError::Overlap { a: "Pan".into(), b: "Tilt".into() })
        );
    }

    #[test]
    fn 越界与非法宽度被拒绝() {
        assert!(matches!(
            model(vec![prop("R", ChannelFunction::Red, 512, 2)]).validate(),
            Err(FixtureError::ChannelOutOfRange { .. })
        ));
        assert!(matches!(
            model(vec![prop("R", ChannelFunction::Red, 0, 1)]).validate(),
            Err(FixtureError::ChannelOutOfRange { .. })
        ));
        assert!(matches!(
            model(vec![prop("R", ChannelFunction::Red, 1, 3)]).validate(),
            Err(FixtureError::BadWidth { width: 3, .. })
        ));
    }

    #[test]
    fn 默认值与高亮值不能超出位宽() {
        let mut p = prop("R", ChannelFunction::Red, 1, 1);
        p.default_value = 256;
        assert!(matches!(
            model(vec![p]).validate(),
            Err(FixtureError::DefaultOutOfRange { .. })
        ));
        let mut p = prop("R", ChannelFunction::Red, 1, 1);
        p.highlight_value = Some(300);
        assert!(matches!(
            model(vec![p]).validate(),
            Err(FixtureError::DefaultOutOfRange { .. })
        ));
    }

    #[test]
    fn 颜色功能不能重复_其他功能可以() {
        let dup = model(vec![
            prop("R1", ChannelFunction::Red, 1, 1),
            prop("R2", ChannelFunction::Red, 2, 1),
        ]);
        assert_eq!(dup.validate(), Err(FixtureError::DuplicateFunction(ChannelFunction::Red)));
        let ok = model(vec![
            prop("M1", ChannelFunction::Macro, 1, 1),
            prop("M2", ChannelFunction::Macro, 2, 1),
        ]);
        assert_eq!(ok.validate(), Ok(()));
    }

    #[test]
    fn 不同像素头可以有相同颜色功能() {
        let mut m = model(vec![
            prop("Dim", ChannelFunction::Dimmer, 1, 1),
            FixtureProperty { head: 1, ..prop("R1", ChannelFunction::Red, 2, 1) },
            FixtureProperty { head: 2, ..prop("R2", ChannelFunction::Red, 3, 1) },
        ]);
        // 没有声明像素排布时，像素头越界。
        assert!(matches!(m.validate(), Err(FixtureError::HeadOutOfRange { .. })));
        m.matrix = Some(MatrixLayout { cols: 2, rows: 1 });
        assert_eq!(m.validate(), Ok(()));
        assert_eq!(m.head_count(), 2);
        m.matrix = Some(MatrixLayout { cols: 0, rows: 1 });
        assert_eq!(m.validate(), Err(FixtureError::BadMatrix));
    }

    #[test]
    fn 能力区间必须升序且不重叠() {
        let mut p = prop("Sh", ChannelFunction::Shutter, 1, 1);
        p.capabilities = vec![cap(0, 20), cap(21, 255)];
        assert_eq!(model(vec![p.clone()]).validate(), Ok(()));
        assert_eq!(p.capability_at(30).map(|c| c.range), Some([21, 255]));
        p.capabilities = vec![cap(0, 20), cap(20, 255)];
        assert!(matches!(model(vec![p.clone()]).validate(), Err(FixtureError::BadCapability { .. })));
        p.capabilities = vec![cap(30, 10)];
        assert!(matches!(model(vec![p.clone()]).validate(), Err(FixtureError::BadCapability { .. })));
        p.capabilities = vec![cap(0, 256)];
        assert!(matches!(model(vec![p]).validate(), Err(FixtureError::BadCapability { .. })));
    }

    #[test]
    fn 附加模式各自校验并可按编号取布局() {
        let mut m = model(vec![prop("D", ChannelFunction::Dimmer, 1, 1)]);
        m.modes.push(FixtureMode {
            id: "9ch".into(),
            name: "9 通道".into(),
            properties: vec![
                prop("D", ChannelFunction::Dimmer, 1, 1),
                prop("R", ChannelFunction::Red, 2, 1),
            ],
        });
        assert_eq!(m.validate(), Ok(()));
        assert_eq!(m.layout(None).map(<[_]>::len), Some(1));
        assert_eq!(m.layout(Some("")).map(<[_]>::len), Some(1));
        assert_eq!(m.layout(Some("9ch")).map(footprint), Some(2));
        assert!(m.layout(Some("nope")).is_none());

        m.modes.push(m.modes[0].clone());
        assert!(matches!(m.validate(), Err(FixtureError::BadMode { .. })));
        m.modes.pop();
        m.modes[0].properties.clear();
        assert_eq!(m.validate(), Err(FixtureError::NoProperties));
    }

    #[test]
    fn 旧版模型_json_不经迁移即可读取且序列化不带新字段() {
        let json = r#"{"id":"1","name":"灯","properties":[
            {"name":"红","code":"Red","function":"red","channel":1,"width":1,"bigEndian":false,"defaultValue":0}
        ]}"#;
        let m: FixtureModel = serde_json::from_str(json).expect("应能解析");
        assert_eq!(m.validate(), Ok(()));
        assert!(m.modes.is_empty() && m.matrix.is_none());
        let out = serde_json::to_value(&m).expect("应能序列化");
        assert!(out.get("modes").is_none());
        assert!(out["properties"][0].get("head").is_none());
        assert!(out["properties"][0].get("capabilities").is_none());
    }

    #[test]
    fn 空编号_空名称_无属性被拒绝() {
        let mut m = model(vec![prop("R", ChannelFunction::Red, 1, 1)]);
        m.id = "  ".into();
        assert_eq!(m.validate(), Err(FixtureError::EmptyId));
        m.id = "1".into();
        m.name = String::new();
        assert_eq!(m.validate(), Err(FixtureError::EmptyName));
        m.name = "n".into();
        m.properties.clear();
        assert_eq!(m.validate(), Err(FixtureError::NoProperties));
    }

    #[test]
    fn 顺序重排按宽度累加() {
        let mut props = vec![
            prop("A", ChannelFunction::Pan, 1, 2),
            prop("B", ChannelFunction::Dimmer, 1, 1),
            prop("C", ChannelFunction::Red, 1, 1),
        ];
        reassign_sequential(&mut props);
        let channels: Vec<u16> = props.iter().map(|p| p.channel).collect();
        assert_eq!(channels, vec![1, 3, 4]);
    }

    #[test]
    fn 错误码稳定() {
        assert_eq!(FixtureError::EmptyId.code(), "empty_id");
        assert_eq!(
            FixtureError::Overlap { a: String::new(), b: String::new() }.code(),
            "overlap"
        );
        assert_eq!(FixtureError::BadMatrix.code(), "bad_matrix");
    }
}
