//! 内置的 6 类标准照明物模型（表号 1）。
//!
//! 与 `DMX物模型表.xlsx` 的“1-标准物模型”工作表一致；各属性的起始通道按书写顺序依次排布。
//! 模型编号取自表格（核心板文档 §2.2 中的 `1.4.14` 是 `1.4.1.4` 的笔误）。

use super::model::{ChannelFunction, FixtureModel, FixtureProperty};

/// 内置模型的 `(中文名, 英文代码, 数值说明, 字段描述)`。
///
/// # Arguments
///
/// * `function` - 要查询的功能，仅支持开关、调光和各色光功能。
///
/// # Returns
///
/// 四元组；对不支持的功能返回空串，调用方只会传入上述功能。
fn function_text(function: ChannelFunction) -> (&'static str, &'static str, &'static str, &'static str) {
    match function {
        ChannelFunction::Switch => ("开关", "Switch", "0:关,1~255:开", "开关"),
        ChannelFunction::Dimmer => ("亮度", "Bright", "0~255:亮度", "0为关，255为最亮"),
        ChannelFunction::Red => ("红光", "Red", "0~255:红光值", "0为关，255为最亮"),
        ChannelFunction::Green => ("绿光", "Green", "0~255:绿光值", "0为关，255为最亮"),
        ChannelFunction::Blue => ("蓝光", "Blue", "0~255:蓝光值", "0为关，255为最亮"),
        ChannelFunction::White => ("白光", "White", "0~255:白光值", "0为关，255为最亮"),
        ChannelFunction::CoolWhite => ("冷白", "CoolWhite", "0~255:冷光亮度", "0为关，255为最亮"),
        ChannelFunction::WarmWhite => ("暖白", "WarmWhite", "0~255:暖光亮度", "0为关，255为最亮"),
        _ => ("", "", "", ""),
    }
}

/// 构造一个 8 位的内置属性。
///
/// # Arguments
///
/// * `function` - 属性功能。
/// * `channel` - 起始通道（从 1 开始）。
fn property(function: ChannelFunction, channel: u16) -> FixtureProperty {
    let (name, code, value_desc, description) = function_text(function);
    FixtureProperty {
        name: name.to_owned(),
        code: code.to_owned(),
        function,
        channel,
        width: 1,
        big_endian: false,
        default_value: 0,
        value_desc: value_desc.to_owned(),
        description: description.to_owned(),
    }
}

/// 构造一个内置模型，属性从通道 1 起依次排布。
///
/// # Arguments
///
/// * `id` - 模型编号。
/// * `name` - 模型名称。
/// * `product_type` - 产品类型。
/// * `functions` - 属性功能，按通道顺序。
fn model(id: &str, name: &str, product_type: &str, functions: &[ChannelFunction]) -> FixtureModel {
    FixtureModel {
        id: id.to_owned(),
        name: name.to_owned(),
        system: "照明".to_owned(),
        product_type: product_type.to_owned(),
        builtin: true,
        properties: functions
            .iter()
            .zip(1u16..)
            .map(|(f, ch)| property(*f, ch))
            .collect(),
    }
}

/// 返回全部内置标准模型，顺序与表格序号一致。
///
/// # Returns
///
/// 开关灯、可调白光灯、冷暖白光灯、RGB 全彩灯、RGBW 全彩灯、RGBCW 全彩灯 6 个模型。
#[must_use]
pub fn builtin_models() -> Vec<FixtureModel> {
    use ChannelFunction::{Blue, CoolWhite, Dimmer, Green, Red, Switch, WarmWhite, White};
    vec![
        model("1.1.1.1", "开关灯", "开关", &[Switch]),
        model("1.2.1.2", "可调白光灯", "调光", &[Dimmer]),
        model("1.3.1.3", "冷暖白光灯", "冷暖白光", &[CoolWhite, WarmWhite]),
        model("1.4.1.4", "RGB全彩灯", "全彩", &[Red, Green, Blue]),
        model("1.5.1.4", "RGBW全彩灯", "全彩", &[Red, Green, Blue, White]),
        model("1.6.1.5", "RGBCW全彩灯", "全彩+冷暖", &[Red, Green, Blue, CoolWhite, WarmWhite]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 六类模型的通道数与需求文档一致() {
        let counts: Vec<(String, u16)> = builtin_models()
            .iter()
            .map(|m| (m.id.clone(), m.channel_count()))
            .collect();
        assert_eq!(
            counts,
            vec![
                ("1.1.1.1".to_owned(), 1),
                ("1.2.1.2".to_owned(), 1),
                ("1.3.1.3".to_owned(), 2),
                ("1.4.1.4".to_owned(), 3),
                ("1.5.1.4".to_owned(), 4),
                ("1.6.1.5".to_owned(), 5),
            ]
        );
    }

    #[test]
    fn 内置模型全部合法且标记为只读() {
        for m in builtin_models() {
            assert_eq!(m.validate(), Ok(()), "{}", m.id);
            assert!(m.builtin);
        }
    }

    #[test]
    fn 通道顺序按书写顺序() {
        let rgbcw = builtin_models().pop().expect("至少有一个内置模型");
        let order: Vec<(&str, u16)> = rgbcw
            .properties
            .iter()
            .map(|p| (p.code.as_str(), p.channel))
            .collect();
        assert_eq!(
            order,
            vec![("Red", 1), ("Green", 2), ("Blue", 3), ("CoolWhite", 4), ("WarmWhite", 5)]
        );
    }
}
