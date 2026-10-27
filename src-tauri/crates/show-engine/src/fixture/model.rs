//! 灯具物模型：通道属性、功能枚举与校验。
//!
//! 一个 [`FixtureModel`] 描述一类灯具（模板），由若干 [`FixtureProperty`] 组成，
//! 每个属性占用 1 或 2 个连续 DMX 通道（16 位属性如摇头灯的 Pan / Tilt）。
//! 模型编号 `id` 的格式为 `[表号].[序号].[系统].[类型]`，例如 `1.5.1.4` 是 RGBW 全彩灯，
//! 表号 1 为标准物模型、2 为自定义物模型（见 `DMX物模型表.xlsx` 的“概念说明”）。

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 一个 Universe 的 DMX 通道数。
pub const DMX_CHANNELS: u16 = 512;

/// 单个模型最多的属性数。
pub const MAX_PROPERTIES: usize = 64;

/// 模型编号的最大长度（字符数）。
pub const MAX_ID_LEN: usize = 64;

/// 通道属性的功能。
///
/// 编辑器按功能把“颜色 + 亮度”映射到通道：`Red` / `Green` / `Blue` / `White` /
/// `CoolWhite` / `WarmWhite` / `Dimmer` / `Switch` 会被灯光求值器驱动，
/// 其余功能（云台、图案等）一期输出固定的默认值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// 图案盘。
    Gobo,
    /// 棱镜。
    Prism,
    /// 棱镜旋转。
    PrismRotate,
    /// 雾化。
    Frost,
    /// 调焦。
    Focus,
    /// 图案抖动。
    GoboShake,
    /// 宏功能。
    Macro,
    /// 灯具复位。
    Reset,
    /// 其他（未识别的功能，按默认值输出）。
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
            "coolwhite" => Self::CoolWhite,
            "warmwhite" => Self::WarmWhite,
            "pan" => Self::Pan,
            "tilt" => Self::Tilt,
            "speed" => Self::Speed,
            "shutter" | "strobe" | "shutterstrobe" => Self::Shutter,
            "colorwheel" => Self::ColorWheel,
            "gobo" => Self::Gobo,
            "prism" => Self::Prism,
            "prismrotate" => Self::PrismRotate,
            "frost" => Self::Frost,
            "focus" => Self::Focus,
            "goboshake" => Self::GoboShake,
            "macro" => Self::Macro,
            "reset" => Self::Reset,
            _ => Self::Other,
        }
    }

    /// 该功能在属性里至多出现一次（出现多次没有意义）。
    ///
    /// # Returns
    ///
    /// 开关、调光和各色光功能返回 `true`，其余返回 `false`。
    #[must_use]
    pub fn is_unique(self) -> bool {
        matches!(
            self,
            Self::Switch
                | Self::Dimmer
                | Self::Red
                | Self::Green
                | Self::Blue
                | Self::White
                | Self::CoolWhite
                | Self::WarmWhite
        )
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
            Self::Pan | Self::Tilt => {
                if width >= 2 {
                    32768
                } else {
                    128
                }
            }
            Self::Focus => 128,
            // 通用摇头灯频闪通道的 104~107 为“常亮开光”。
            Self::Shutter => 105,
            _ => 0,
        }
    }
}

/// 灯具的一个通道属性。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

/// 灯具物模型（一类灯具的模板）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// 通道属性列表。
    pub properties: Vec<FixtureProperty>,
}

impl FixtureModel {
    /// 灯具占用的 DMX 通道数（从通道 1 到最后一个被占用通道，中间的空洞也计入）。
    ///
    /// # Returns
    ///
    /// 最大的 [`FixtureProperty::end_channel`]；没有属性时为 0。
    #[must_use]
    pub fn channel_count(&self) -> u16 {
        self.properties
            .iter()
            .map(FixtureProperty::end_channel)
            .max()
            .unwrap_or(0)
    }

    /// 校验模型是否合法。
    ///
    /// # Errors
    ///
    /// - 编号或名称为空、编号过长时返回 [`FixtureError::EmptyId`] / [`FixtureError::IdTooLong`] /
    ///   [`FixtureError::EmptyName`]。
    /// - 没有属性或属性过多时返回 [`FixtureError::NoProperties`] / [`FixtureError::TooManyProperties`]。
    /// - 属性宽度不是 1 或 2、通道越界、默认值超出范围时返回对应变体。
    /// - 属性占用的通道重叠时返回 [`FixtureError::Overlap`]。
    /// - 开关、调光、各色光等功能重复出现时返回 [`FixtureError::DuplicateFunction`]。
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
        if self.properties.is_empty() {
            return Err(FixtureError::NoProperties);
        }
        if self.properties.len() > MAX_PROPERTIES {
            return Err(FixtureError::TooManyProperties);
        }
        for p in &self.properties {
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
            if p.default_value > p.max_value() {
                return Err(FixtureError::DefaultOutOfRange {
                    code: p.code.clone(),
                });
            }
        }
        if let Some((a, b)) = find_overlap(&self.properties) {
            return Err(FixtureError::Overlap { a, b });
        }
        for (i, p) in self.properties.iter().enumerate() {
            if p.function.is_unique()
                && self.properties[..i].iter().any(|q| q.function == p.function)
            {
                return Err(FixtureError::DuplicateFunction(p.function));
            }
        }
        Ok(())
    }
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
    /// 属性默认值超出其位宽的取值范围。
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
    /// 开关、调光、各色光等功能出现了多次。
    #[error("功能 {0:?} 在同一模型里只能出现一次")]
    DuplicateFunction(ChannelFunction),
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
            default_value: 0,
            value_desc: String::new(),
            description: String::new(),
        }
    }

    fn model(props: Vec<FixtureProperty>) -> FixtureModel {
        FixtureModel {
            id: "9.9.9.9".into(),
            name: "测试灯".into(),
            system: String::new(),
            product_type: String::new(),
            builtin: false,
            properties: props,
        }
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
    fn 默认值不能超出位宽() {
        let mut p = prop("R", ChannelFunction::Red, 1, 1);
        p.default_value = 256;
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
    }
}
