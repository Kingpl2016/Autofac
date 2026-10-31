//! OFL 灯具 JSON 的摘要：给 AI 助手看的精简版原文（名称、分类、物理参数、轮子槽位、通道能力、模式、链接）。
//!
//! 原文可能有几百 KB（像素灯的模板通道展开很长），摘要按优先级逐步裁剪到上限以内：
//! 先保留完整的通道能力，超限时每个通道只留能力类型，再超限时去掉通道，最后截短轮子。

use serde_json::{json, Map, Value};

use super::import::ImportError;

/// 每个通道最多列出的能力数。
const MAX_CAPS_PER_CHANNEL: usize = 16;
/// 每个轮子最多列出的槽位数。
const MAX_SLOTS: usize = 32;

type Obj = Map<String, Value>;

/// 一个能力的简短描述：类型、颜色、槽位号、注释、物理量范围。
fn cap_summary(cap: &Obj) -> Value {
    let mut out = Obj::new();
    for key in [
        "type", "color", "colors", "slotNumber", "wheel", "comment", "shutterEffect", "colorTemperature", "colorTemperatureStart",
        "colorTemperatureEnd", "angleStart", "angleEnd", "angle",
    ] {
        if let Some(v) = cap.get(key) {
            out.insert(key.to_owned(), v.clone());
        }
    }
    if let Some(r) = cap.get("dmxRange") {
        out.insert("dmxRange".into(), r.clone());
    }
    Value::Object(out)
}

/// 通道定义的能力列表（单个 `capability` 或 `capabilities` 数组）。
fn caps_of(def: &Obj) -> Vec<&Obj> {
    match (def.get("capability"), def.get("capabilities")) {
        (Some(Value::Object(c)), _) => vec![c],
        (_, Some(Value::Array(a))) => a.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    }
}

/// 全部通道（可用通道与模板通道）的摘要。
fn channels(root: &Obj, detailed: bool) -> Value {
    let mut out = Obj::new();
    for section in ["availableChannels", "templateChannels"] {
        let Some(map) = root.get(section).and_then(Value::as_object) else { continue };
        for (name, def) in map {
            let Some(def) = def.as_object() else { continue };
            let caps = caps_of(def);
            let list: Vec<Value> = if detailed {
                caps.iter().take(MAX_CAPS_PER_CHANNEL).map(|c| cap_summary(c)).collect()
            } else {
                let mut types: Vec<String> = caps.iter().filter_map(|c| c.get("type").and_then(Value::as_str).map(str::to_owned)).collect();
                types.dedup();
                types.into_iter().map(Value::String).collect()
            };
            let mut entry = json!({ "capabilities": list });
            if caps.len() > MAX_CAPS_PER_CHANNEL && detailed {
                entry["more"] = json!(caps.len() - MAX_CAPS_PER_CHANNEL);
            }
            if let Some(f) = def.get("fineChannelAliases") {
                entry["fine"] = f.clone();
            }
            out.insert(name.clone(), entry);
        }
    }
    Value::Object(out)
}

/// 轮子与槽位。
fn wheels(root: &Obj, max_slots: usize) -> Value {
    let Some(map) = root.get("wheels").and_then(Value::as_object) else { return Value::Null };
    let mut out = Obj::new();
    for (name, w) in map {
        let slots: Vec<Value> = w
            .get("slots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(max_slots)
            .filter_map(Value::as_object)
            .map(|s| {
                let mut o = Obj::new();
                for key in ["type", "name", "colors", "colorTemperature"] {
                    if let Some(v) = s.get(key) {
                        o.insert(key.to_owned(), v.clone());
                    }
                }
                Value::Object(o)
            })
            .collect();
        out.insert(name.clone(), Value::Array(slots));
    }
    Value::Object(out)
}

/// 模式名与通道数。
fn modes(root: &Obj) -> Value {
    let list: Vec<Value> = root
        .get("modes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|m| json!({ "name": m.get("name"), "channels": m.get("channels").and_then(Value::as_array).map_or(0, Vec::len) }))
        .collect();
    Value::Array(list)
}

/// 生成 OFL 灯具的摘要（JSON 文本），不超过 `max_bytes`。
///
/// # Arguments
///
/// * `text` - 灯具 JSON 原文。
/// * `max_bytes` - 摘要的大小上限（字节）。
///
/// # Returns
///
/// 摘要 JSON 文本。
///
/// # Errors
///
/// 原文不是 JSON 对象时返回 [`ImportError::Open`]。
pub fn ofl_digest(text: &str, max_bytes: usize) -> Result<String, ImportError> {
    let root: Value = serde_json::from_str(text).map_err(|e| ImportError::Open(e.to_string()))?;
    let Some(root) = root.as_object() else {
        return Err(ImportError::Open("not an object".into()));
    };
    let links = root.get("links").and_then(Value::as_object).map(|l| {
        let mut o = Obj::new();
        for key in ["manual", "productPage"] {
            if let Some(v) = l.get(key) {
                o.insert(key.to_owned(), v.clone());
            }
        }
        Value::Object(o)
    });
    let base = |channels_v: Value, wheels_v: Value| {
        let mut d = json!({
            "name": root.get("name"),
            "categories": root.get("categories"),
            "physical": root.get("physical"),
            "matrix": root.get("matrix").and_then(|m| m.get("pixelCount")),
            "modes": modes(root),
        });
        if let Some(l) = &links {
            d["links"] = l.clone();
        }
        if !wheels_v.is_null() {
            d["wheels"] = wheels_v;
        }
        if !channels_v.is_null() {
            d["channels"] = channels_v;
        }
        d
    };
    let attempts = [
        base(channels(root, true), wheels(root, MAX_SLOTS)),
        base(channels(root, false), wheels(root, MAX_SLOTS)),
        base(Value::Null, wheels(root, MAX_SLOTS)),
        base(Value::Null, wheels(root, 8)),
        base(Value::Null, Value::Null),
    ];
    let mut last = String::new();
    for d in attempts {
        last = serde_json::to_string(&d).unwrap_or_default();
        if last.len() <= max_bytes {
            return Ok(last);
        }
    }
    // 连最小的摘要都超限（极少见）：截断，保证不超过上限
    let mut cut = max_bytes.min(last.len());
    while cut > 0 && !last.is_char_boundary(cut) {
        cut -= 1;
    }
    last.truncate(cut);
    Ok(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPOT: &str = r##"{"name":"Spot","categories":["Moving Head"],"links":{"manual":["https://x/m.pdf"],"video":["https://x/v"]},
      "physical":{"dimensions":[300,450,250],"lens":{"degreesMinMax":[12,30]}},
      "wheels":{"Color Wheel":{"slots":[{"type":"Open"},{"type":"Color","name":"Congo Blue"},{"type":"Color","colors":["#ff0000"]}]}},
      "availableChannels":{"Color":{"capabilities":[{"dmxRange":[0,127],"type":"WheelSlot","slotNumber":1},{"dmxRange":[128,255],"type":"WheelSlot","slotNumber":2}]},
        "Red":{"capability":{"type":"ColorIntensity","color":"Red"}}},
      "modes":[{"name":"Basic","channels":["Color","Red"]}]}"##;

    #[test]
    fn 摘要保留物理参数_轮子与通道能力() {
        let d: Value = serde_json::from_str(&ofl_digest(SPOT, 16 * 1024).expect("应能生成")).expect("是 JSON");
        assert_eq!(d["name"], "Spot");
        assert_eq!(d["physical"]["dimensions"][1], 450);
        assert_eq!(d["wheels"]["Color Wheel"][1]["name"], "Congo Blue");
        assert_eq!(d["channels"]["Red"]["capabilities"][0]["color"], "Red");
        assert_eq!(d["modes"][0]["channels"], 2);
        assert!(d["links"].get("video").is_none(), "只保留说明书与产品页");
    }

    #[test]
    fn 超限时逐步裁剪() {
        let small = ofl_digest(SPOT, 400).expect("应能生成");
        assert!(small.len() <= 400);
        let d: Value = serde_json::from_str(&small).expect("仍是合法 JSON");
        assert_eq!(d["name"], "Spot");
        assert!(d.get("channels").is_none() || d["channels"]["Red"]["capabilities"][0] == "ColorIntensity");
        assert!(ofl_digest("[1]", 100).is_err());
        assert!(ofl_digest(SPOT, 10).expect("截断").len() <= 10);
    }
}
