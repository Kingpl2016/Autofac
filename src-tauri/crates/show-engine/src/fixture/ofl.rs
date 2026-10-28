//! Open Fixture Library（OFL）灯具 JSON 导入（适配器）。
//!
//! 把 OFL 的 `availableChannels` + `modes` 转成本工程的 [`FixtureModel`]：
//!
//! - 第一个 OFL 模式成为默认模式，其余模式进入 `modes`；
//! - 粗调通道后紧跟它的第一条精细通道（`fineChannelAliases`）时合并为一个 16 位通道对象，
//!   否则精细通道作为独立通道导入并给出警告；
//! - 通道功能由第一个有效能力（`capability` / `capabilities`）的类型推断，能力区间按
//!   `dmxValueResolution` 换算到通道的实际位宽；
//! - 像素矩阵（`matrix` + `templateChannels`）按像素展开，通道对象的 `head` 记录所属像素；
//! - `physical.lens.degreesMinMax`、`physical.focus.panMax / tiltMax` 映射到 [`Physical`]。
//!
//! 参考：<https://github.com/OpenLightingProject/open-fixture-library/blob/master/docs/fixture-format.md>。

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::model::{
    Capability, ChannelFunction, FixtureMode, FixtureModel, FixtureProperty, MatrixLayout, Physical,
    Precedence, MAX_ID_LEN,
};
use super::import::{ImportError, ImportReport, ImportWarning, ImportWarningKind};

/// OFL 导入时的工作表名占位（警告里的 `sheet` 字段）。
const SHEET: &str = "OFL";

/// 解析一个 OFL 灯具 JSON。
///
/// # Arguments
///
/// * `text` - 灯具 JSON 文本。
/// * `fallback_key` - 当 JSON 里没有制造商与灯具标识时用来生成模型编号的名字
///   （通常为 `制造商目录/文件名`，例如 `cameo/auro-spot-200`）。
///
/// # Returns
///
/// 只含一个模型的导入结果，以及过程中的警告。
///
/// # Errors
///
/// - 文本不是 JSON 对象时返回 [`ImportError::Open`]。
/// - 没有任何可用模式、或得到的模型未通过校验时返回 [`ImportError::NoModels`]
///   （校验失败的原因写入警告）。
pub fn import_ofl(text: &str, fallback_key: &str) -> Result<ImportReport, ImportError> {
    let root: Value =
        serde_json::from_str(text).map_err(|e| ImportError::Open(e.to_string()))?;
    let Some(root) = root.as_object() else {
        return Err(ImportError::Open("not an object".into()));
    };
    let mut report = ImportReport::default();
    let name = str_of(root, "name").unwrap_or(fallback_key).trim().to_owned();
    let manufacturer = root
        .get("manufacturer")
        .and_then(|m| m.as_object().and_then(|o| str_of(o, "name")).or_else(|| m.as_str()))
        .map_or_else(
            || fallback_key.split('/').next().unwrap_or_default().to_owned(),
            str::to_owned,
        );
    let id = model_id(fallback_key, &name);

    let ctx = Context::new(root);
    let mut layouts: Vec<(String, String, Vec<FixtureProperty>)> = Vec::new();
    for mode in root.get("modes").and_then(Value::as_array).into_iter().flatten() {
        let Some(mode) = mode.as_object() else { continue };
        let mode_name = str_of(mode, "name").unwrap_or_default().to_owned();
        let short = str_of(mode, "shortName").unwrap_or(&mode_name).to_owned();
        let props = ctx.mode_layout(mode, &id, &mode_name, &mut report.warnings);
        if !props.is_empty() {
            layouts.push((short, mode_name, props));
        }
    }
    if layouts.is_empty() {
        return Err(ImportError::NoModels);
    }

    let (_, default_name, properties) = layouts.remove(0);
    let mut used_ids: Vec<String> = Vec::new();
    let extra_modes = layouts
        .into_iter()
        .map(|(short, mode_name, properties)| {
            let mut mid = slug(&short);
            if mid.is_empty() {
                mid = "mode".into();
            }
            let base = mid.clone();
            let mut n = 2;
            while used_ids.contains(&mid) {
                mid = format!("{base}-{n}");
                n += 1;
            }
            used_ids.push(mid.clone());
            FixtureMode { id: mid, name: mode_name, properties }
        })
        .collect();

    let categories: Vec<&str> = root
        .get("categories")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let model = FixtureModel {
        id: id.clone(),
        name: if name.is_empty() { id.clone() } else { name },
        system: "OFL".into(),
        product_type: categories.join(" / "),
        builtin: false,
        properties,
        manufacturer,
        default_mode_name: default_name,
        modes: extra_modes,
        matrix: ctx.matrix,
        emitters: Vec::new(),
        physical: physical_of(root),
    };
    match model.validate() {
        Ok(()) => {
            report.models.push(model);
            Ok(report)
        }
        Err(e) => {
            report.warnings.push(ImportWarning {
                kind: ImportWarningKind::InvalidModel,
                sheet: SHEET.into(),
                row: None,
                model_id: Some(id),
                detail: Some(e.code().to_owned()),
            });
            Err(ImportError::NoModels)
        }
    }
}

/// 解析上下文：通道定义、矩阵像素与色轮。
struct Context<'a> {
    channels: &'a Map<String, Value>,
    templates: Option<&'a Map<String, Value>>,
    wheels: Option<&'a Map<String, Value>>,
    /// 像素键（行优先）。
    pixels: Vec<String>,
    matrix: Option<MatrixLayout>,
    /// 精细通道别名 → (粗调通道键, 精细级别 1 起)。
    fine: HashMap<String, (String, usize)>,
}

impl<'a> Context<'a> {
    fn new(root: &'a Map<String, Value>) -> Self {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        let channels = root
            .get("availableChannels")
            .and_then(Value::as_object)
            .unwrap_or_else(|| EMPTY.get_or_init(Map::new));
        let templates = root.get("templateChannels").and_then(Value::as_object);
        let (pixels, matrix) = matrix_pixels(root.get("matrix"));
        let mut fine = HashMap::new();
        for source in [Some(channels), templates].into_iter().flatten() {
            for (key, def) in source {
                for (i, alias) in def
                    .get("fineChannelAliases")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .enumerate()
                {
                    fine.insert(alias.to_owned(), (key.clone(), i + 1));
                }
            }
        }
        Self {
            channels,
            templates,
            wheels: root.get("wheels").and_then(Value::as_object),
            pixels,
            matrix,
            fine,
        }
    }

    /// 展开一个模式的通道列表（矩阵插入展开为逐像素通道），并转成通道对象。
    fn mode_layout(
        &self,
        mode: &Map<String, Value>,
        model_id: &str,
        mode_name: &str,
        warnings: &mut Vec<ImportWarning>,
    ) -> Vec<FixtureProperty> {
        // 先展开成 (通道键, 所属像素) 列表；`None` 表示该 DMX 通道未使用。
        let mut slots: Vec<Option<(String, u16)>> = Vec::new();
        for entry in mode.get("channels").and_then(Value::as_array).into_iter().flatten() {
            match entry {
                Value::String(key) => slots.push(Some((key.clone(), 0))),
                Value::Object(ins) => self.expand_matrix(ins, &mut slots, model_id, mode_name, warnings),
                // `null` 表示未使用的通道；其它非法值同样按空通道处理
                _ => slots.push(None),
            }
        }

        let mut props = Vec::new();
        let mut i = 0usize;
        while i < slots.len() {
            let channel = (i + 1) as u16;
            let Some((key, head)) = &slots[i] else {
                i += 1;
                continue;
            };
            // 精细通道：前面已合并的跳过；没有被合并的（不紧跟粗调）独立导入
            if let Some((coarse, _)) = self.fine.get(key) {
                warnings.push(warn(ImportWarningKind::FineChannelSeparate, model_id, mode_name, key));
                props.push(FixtureProperty {
                    name: key.clone(),
                    code: key.clone(),
                    function: ChannelFunction::Other,
                    channel,
                    width: 1,
                    big_endian: true,
                    description: format!("fine of {coarse}"),
                    head: *head,
                    ..FixtureProperty::default()
                });
                i += 1;
                continue;
            }
            let Some(def) = self.definition(key) else {
                warnings.push(warn(ImportWarningKind::UnknownFunction, model_id, mode_name, key));
                i += 1;
                continue;
            };
            // 下一条通道正好是本通道的第一级精细通道 → 合并为 16 位
            let first_fine = def
                .get("fineChannelAliases")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_str)
                .map(|alias| self.resolve_template_key(alias, key));
            let merged = matches!(
                (first_fine.as_deref(), slots.get(i + 1)),
                (Some(f), Some(Some((next, _)))) if f == next
            );
            let width: u8 = if merged { 2 } else { 1 };
            let mut prop = self.property(key, def, channel, width, warnings, model_id, mode_name);
            prop.head = *head;
            props.push(prop);
            i += usize::from(width);
        }
        props
    }

    /// 把矩阵插入块展开为逐像素通道。
    fn expand_matrix(
        &self,
        ins: &Map<String, Value>,
        slots: &mut Vec<Option<(String, u16)>>,
        model_id: &str,
        mode_name: &str,
        warnings: &mut Vec<ImportWarning>,
    ) {
        if str_of(ins, "insert") != Some("matrixChannels") {
            warnings.push(warn(ImportWarningKind::UnsupportedFeature, model_id, mode_name, "insert"));
            return;
        }
        let templates: Vec<&str> = ins
            .get("templateChannels")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let pixels: Vec<String> = match ins.get("repeatFor") {
            Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
            Some(Value::String(s)) if s.starts_with("eachPixel") && s != "eachPixelGroup" => {
                let mut p = self.pixels.clone();
                if s == "eachPixelABC" {
                    p.sort();
                }
                p
            }
            _ => {
                warnings.push(warn(ImportWarningKind::UnsupportedFeature, model_id, mode_name, "repeatFor"));
                return;
            }
        };
        let head_of = |pixel: &str| -> u16 {
            self.pixels
                .iter()
                .position(|p| p == pixel)
                .map_or(0, |i| (i + 1) as u16)
        };
        let per_pixel = str_of(ins, "channelOrder") != Some("perChannel");
        let mut push = |pixel: &str, template: &str| {
            slots.push(Some((template.replace("$pixelKey", pixel), head_of(pixel))));
        };
        if per_pixel {
            for pixel in &pixels {
                for tpl in &templates {
                    push(pixel, tpl);
                }
            }
        } else {
            for tpl in &templates {
                for pixel in &pixels {
                    push(pixel, tpl);
                }
            }
        }
    }

    /// 取通道定义：先查 `availableChannels`，再按模板（`$pixelKey`）匹配 `templateChannels`。
    fn definition(&self, key: &str) -> Option<&'a Map<String, Value>> {
        if let Some(def) = self.channels.get(key).and_then(Value::as_object) {
            return Some(def);
        }
        let templates = self.templates?;
        for pixel in &self.pixels {
            for (tpl, def) in templates {
                if tpl.replace("$pixelKey", pixel) == key {
                    return def.as_object();
                }
            }
        }
        None
    }

    /// 模板通道的精细别名里也带 `$pixelKey`，按当前通道键所属像素替换。
    fn resolve_template_key(&self, alias: &str, key: &str) -> String {
        if !alias.contains("$pixelKey") {
            return alias.to_owned();
        }
        for pixel in &self.pixels {
            let Some(templates) = self.templates else { break };
            for tpl in templates.keys() {
                if tpl.replace("$pixelKey", pixel) == key {
                    return alias.replace("$pixelKey", pixel);
                }
            }
        }
        alias.to_owned()
    }

    #[expect(clippy::too_many_arguments, reason = "OFL 属性解析需透传多个解析上下文")]
    fn property(
        &self,
        key: &str,
        def: &Map<String, Value>,
        channel: u16,
        width: u8,
        warnings: &mut Vec<ImportWarning>,
        model_id: &str,
        mode_name: &str,
    ) -> FixtureProperty {
        let caps_raw: Vec<&Map<String, Value>> = match (def.get("capability"), def.get("capabilities")) {
            (Some(Value::Object(c)), _) => vec![c],
            (_, Some(Value::Array(list))) => list.iter().filter_map(Value::as_object).collect(),
            _ => Vec::new(),
        };
        let function = caps_raw
            .iter()
            .map(|c| Self::function_of(c))
            .find(|f| *f != ChannelFunction::Other)
            .unwrap_or_else(|| ChannelFunction::from_code(key));
        if function == ChannelFunction::Other {
            warnings.push(warn(ImportWarningKind::UnknownFunction, model_id, mode_name, key));
        }

        // 能力区间写在“定义分辨率”下：默认等于通道键 + 精细别名数，`dmxValueResolution` 可覆盖。
        let fine_count = def
            .get("fineChannelAliases")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let source_bits: u32 = match str_of(def, "dmxValueResolution") {
            Some("8bit") => 8,
            Some("16bit") => 16,
            Some("24bit") => 24,
            _ => 8 * (1 + fine_count as u32),
        };
        let target_bits = 8 * u32::from(width);
        let convert = |v: u64, high: bool| -> u16 {
            let v = if source_bits >= target_bits {
                v >> (source_bits - target_bits)
            } else {
                let shift = target_bits - source_bits;
                let scaled = v << shift;
                if high {
                    scaled | ((1u64 << shift) - 1)
                } else {
                    scaled
                }
            };
            u16::try_from(v).unwrap_or(u16::MAX)
        };
        let max = if width >= 2 { u16::MAX } else { 255 };

        let mut capabilities = Vec::new();
        if caps_raw.len() > 1 || caps_raw.first().is_some_and(|c| c.contains_key("dmxRange")) {
            for c in &caps_raw {
                let Some([lo, hi]) = range_of(c) else { continue };
                let lo = convert(lo, false).min(max);
                let hi = convert(hi, true).min(max);
                if capabilities.last().is_some_and(|p: &Capability| lo <= p.range[1]) || lo > hi {
                    continue;
                }
                capabilities.push(self.capability(c, [lo, hi]));
            }
        }

        let default_value = def
            .get("defaultValue")
            .and_then(|v| dmx_value(v, source_bits))
            .map_or_else(|| function.default_value(width), |v| convert(v, false).min(max));
        let highlight_value = def
            .get("highlightValue")
            .and_then(|v| dmx_value(v, source_bits))
            .map(|v| convert(v, true).min(max));
        let precedence = match str_of(def, "precedence") {
            Some("HTP") => Some(Precedence::Htp),
            Some("LTP") => Some(Precedence::Ltp),
            _ => None,
        };
        FixtureProperty {
            name: str_of(def, "name").unwrap_or(key).to_owned(),
            code: key.to_owned(),
            function,
            channel,
            width,
            big_endian: true,
            default_value,
            highlight_value,
            precedence,
            capabilities,
            ..FixtureProperty::default()
        }
    }

    /// 能力类型 → 通道功能。
    fn function_of(cap: &Map<String, Value>) -> ChannelFunction {
        use ChannelFunction as F;
        match str_of(cap, "type").unwrap_or_default() {
            "Intensity" => F::Dimmer,
            "ColorIntensity" => match str_of(cap, "color").unwrap_or_default() {
                "Red" => F::Red,
                "Green" => F::Green,
                "Blue" => F::Blue,
                "White" => F::White,
                "Warm White" => F::WarmWhite,
                "Cold White" => F::CoolWhite,
                "Amber" => F::Amber,
                "UV" => F::Uv,
                "Lime" => F::Lime,
                "Cyan" => F::Cyan,
                "Magenta" => F::Magenta,
                "Yellow" => F::Yellow,
                _ => F::Other,
            },
            "ColorPreset" => F::ColorWheel,
            "ColorTemperature" => F::ColorTemp,
            "Pan" | "PanContinuous" => F::Pan,
            "Tilt" | "TiltContinuous" => F::Tilt,
            "PanTiltSpeed" => F::Speed,
            "ShutterStrobe" | "StrobeSpeed" | "StrobeDuration" => F::Shutter,
            "WheelSlot" | "WheelRotation" | "WheelSlotRotation" | "WheelShake" => {
                Self::wheel_function(cap)
            }
            "Prism" => F::Prism,
            "PrismRotation" => F::PrismRotate,
            "Frost" | "FrostEffect" => F::Frost,
            "Focus" => F::Focus,
            "Zoom" | "BeamAngle" => F::Zoom,
            "Iris" | "IrisEffect" => F::Iris,
            "Maintenance" => F::Reset,
            "Effect" | "EffectSpeed" | "EffectDuration" | "EffectParameter" | "SoundSensitivity" => {
                F::Macro
            }
            _ => F::Other,
        }
    }

    /// 色轮 / 图案轮能力：按轮子名称（或槽位类型）判断是颜色轮还是图案盘。
    fn wheel_function(cap: &Map<String, Value>) -> ChannelFunction {
        let kind = str_of(cap, "type").unwrap_or_default();
        let wheel = str_of(cap, "wheel").unwrap_or_default().to_ascii_lowercase();
        let is_color = wheel.contains("color") || wheel.contains("colour");
        match kind {
            "WheelShake" => ChannelFunction::GoboShake,
            "WheelRotation" | "WheelSlotRotation" if !is_color => ChannelFunction::GoboRotate,
            _ if is_color => ChannelFunction::ColorWheel,
            _ => ChannelFunction::Gobo,
        }
    }

    /// 构造能力区间：名称取 `comment`，否则按类型与参数拼出；比例区间解析起止物理量。
    fn capability(&self, cap: &Map<String, Value>, range: [u16; 2]) -> Capability {
        let kind = str_of(cap, "type").unwrap_or_default();
        let detail = str_of(cap, "shutterEffect")
            .or_else(|| str_of(cap, "effectName"))
            .or_else(|| str_of(cap, "color"))
            .map(str::to_owned)
            .or_else(|| cap.get("slotNumber").map(|v| format!("{kind} {v}")));
        let label = str_of(cap, "comment")
            .map(str::to_owned)
            .or(detail)
            .unwrap_or_else(|| kind.to_owned());

        let mut physical = None;
        let mut unit = String::new();
        for (start_key, value) in cap {
            let Some(prefix) = start_key.strip_suffix("Start") else { continue };
            let end = cap.get(&format!("{prefix}End"));
            if let (Some((a, ua)), Some((b, ub))) = (entity(value), end.and_then(entity))
                && ua == ub {
                    physical = Some([a, b]);
                    unit = ua;
                    break;
                }
        }
        let color = cap
            .get("colors")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .and_then(hex_color)
            .or_else(|| self.wheel_slot_color(cap));
        Capability {
            range,
            label,
            proportional: physical.is_some(),
            physical,
            unit,
            color,
        }
    }

    /// 色轮槽位的代表色：`wheels[wheel].slots[slotNumber - 1].colors[0]`。
    fn wheel_slot_color(&self, cap: &Map<String, Value>) -> Option<[u8; 3]> {
        let wheel = str_of(cap, "wheel")?;
        let slot = cap.get("slotNumber")?.as_f64()?;
        let index = (slot.floor() as usize).checked_sub(1)?;
        self.wheels?
            .get(wheel)?
            .get("slots")?
            .as_array()?
            .get(index)?
            .get("colors")?
            .as_array()?
            .first()?
            .as_str()
            .and_then(hex_color)
    }
}

/// 由矩阵定义得到像素键（行优先）与排布。
fn matrix_pixels(matrix: Option<&Value>) -> (Vec<String>, Option<MatrixLayout>) {
    let Some(m) = matrix.and_then(Value::as_object) else {
        return (Vec::new(), None);
    };
    if let Some(count) = m.get("pixelCount").and_then(Value::as_array) {
        let dim = |i: usize| count.get(i).and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
        let (x, y, z) = (dim(0), dim(1), dim(2));
        let mut keys = Vec::new();
        for zi in 1..=z {
            for yi in 1..=y {
                for xi in 1..=x {
                    keys.push(match (y > 1, z > 1) {
                        (false, false) => format!("{xi}"),
                        (true, false) => format!("({xi}, {yi})"),
                        _ => format!("({xi}, {yi}, {zi})"),
                    });
                }
            }
        }
        let layout = MatrixLayout {
            cols: u16::try_from(x).unwrap_or(u16::MAX),
            rows: u16::try_from(y * z).unwrap_or(u16::MAX),
        };
        return (keys, Some(layout));
    }
    if let Some(grid) = m.get("pixelKeys").and_then(Value::as_array) {
        // pixelKeys[z][y][x]
        let mut keys = Vec::new();
        let (mut cols, mut rows) = (0usize, 0usize);
        for layer in grid.iter().filter_map(Value::as_array) {
            for row in layer.iter().filter_map(Value::as_array) {
                rows += 1;
                cols = cols.max(row.len());
                keys.extend(row.iter().filter_map(Value::as_str).map(str::to_owned));
            }
        }
        // 有空洞时像素数小于格子数：按实际像素数排成一行，保证编号连续
        let layout = if keys.len() == cols * rows {
            MatrixLayout { cols: cols as u16, rows: rows as u16 }
        } else {
            MatrixLayout { cols: keys.len() as u16, rows: 1 }
        };
        return (keys, Some(layout));
    }
    (Vec::new(), None)
}

fn physical_of(root: &Map<String, Value>) -> Option<Physical> {
    let p = root.get("physical")?.as_object()?;
    let lens = p
        .get("lens")
        .and_then(|l| l.get("degreesMinMax"))
        .and_then(Value::as_array);
    let focus = p.get("focus").and_then(Value::as_object);
    let num = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|x| *x > 0.0);
    let physical = Physical {
        pan_range_deg: num(focus.and_then(|f| f.get("panMax"))),
        tilt_range_deg: num(focus.and_then(|f| f.get("tiltMax"))),
        beam_min_deg: num(lens.and_then(|l| l.first())),
        beam_max_deg: num(lens.and_then(|l| l.get(1))),
    };
    (physical != Physical::default()).then_some(physical)
}

fn str_of<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

fn range_of(cap: &Map<String, Value>) -> Option<[u64; 2]> {
    let r = cap.get("dmxRange")?.as_array()?;
    Some([r.first()?.as_u64()?, r.get(1)?.as_u64()?])
}

/// DMX 值：整数，或百分比字符串（按定义分辨率换算）。
fn dmx_value(v: &Value, bits: u32) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    let s = v.as_str()?.trim();
    let pct: f64 = s.strip_suffix('%')?.trim().parse().ok()?;
    let max = (1u64 << bits) - 1;
    Some(((pct.clamp(0.0, 100.0) / 100.0) * max as f64).round() as u64)
}

/// 解析带单位的物理量，例如 `530deg`、`10Hz`、`100%`、`-50%`；关键字（`fast` 等）不解析。
fn entity(v: &Value) -> Option<(f64, String)> {
    let s = v.as_str()?.trim();
    let split = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))
        .unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: f64 = num.parse().ok()?;
    n.is_finite().then(|| (n, unit.trim().to_owned()))
}

fn hex_color(s: &str) -> Option<[u8; 3]> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let p = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([p(0)?, p(2)?, p(4)?])
}

/// 生成模型编号：`ofl:` + 规整后的标识，截断到 [`MAX_ID_LEN`]。
fn model_id(fallback_key: &str, name: &str) -> String {
    let key = if fallback_key.trim().is_empty() { slug(name) } else { slug(fallback_key) };
    let id: String = format!("ofl:{key}").chars().take(MAX_ID_LEN).collect();
    id
}

/// 小写、空白转 `-`，只保留字母数字与 `-_/.`。
fn slug(s: &str) -> String {
    s.trim()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c.to_ascii_lowercase() })
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'))
        .collect()
}

fn warn(kind: ImportWarningKind, model_id: &str, mode: &str, detail: &str) -> ImportWarning {
    ImportWarning {
        kind,
        sheet: if mode.is_empty() { SHEET.into() } else { format!("{SHEET} · {mode}") },
        row: None,
        model_id: Some(model_id.to_owned()),
        detail: Some(detail.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一台典型摇头灯（结构取自 OFL 文档示例，数值为测试用）。
    const SPOT: &str = r##"{
      "name": "Test Spot 200",
      "categories": ["Moving Head", "Color Changer"],
      "physical": {"lens": {"degreesMinMax": [12, 30]}, "focus": {"type": "Head", "panMax": 540, "tiltMax": 270}},
      "wheels": {"Color Wheel": {"slots": [{"type": "Open"}, {"type": "Color", "colors": ["#ff0000"]}]}},
      "availableChannels": {
        "Pan": {"fineChannelAliases": ["Pan fine"], "capability": {"type": "Pan", "angleStart": "0deg", "angleEnd": "540deg"}},
        "Tilt": {"fineChannelAliases": ["Tilt fine"], "defaultValue": "50%", "capability": {"type": "Tilt", "angleStart": "0deg", "angleEnd": "270deg"}},
        "Dimmer": {"capability": {"type": "Intensity"}},
        "Shutter": {"defaultValue": 30, "capabilities": [
          {"dmxRange": [0, 20], "type": "ShutterStrobe", "shutterEffect": "Closed"},
          {"dmxRange": [21, 255], "type": "ShutterStrobe", "shutterEffect": "Open", "comment": "开光"}
        ]},
        "Color": {"capabilities": [
          {"dmxRange": [0, 127], "type": "WheelSlot", "wheel": "Color Wheel", "slotNumber": 1},
          {"dmxRange": [128, 255], "type": "WheelSlot", "wheel": "Color Wheel", "slotNumber": 2}
        ]},
        "Mystery": {"capability": {"type": "Generic"}}
      },
      "modes": [
        {"name": "Extended", "shortName": "14ch", "channels": ["Pan", "Pan fine", "Tilt", "Tilt fine", "Dimmer", "Shutter", "Color", null, "Mystery"]},
        {"name": "Basic", "shortName": "6ch", "channels": ["Pan", "Tilt", "Dimmer", "Shutter", "Color", "Tilt fine"]}
      ]
    }"##;

    #[test]
    fn 摇头灯_精细通道合并_能力区间与物理参数() {
        let report = import_ofl(SPOT, "test/spot-200").expect("应能导入");
        let m = &report.models[0];
        assert_eq!(m.id, "ofl:test/spot-200");
        assert_eq!(m.name, "Test Spot 200");
        assert_eq!(m.manufacturer, "test");
        assert_eq!(m.default_mode_name, "Extended");
        assert_eq!(m.product_type, "Moving Head / Color Changer");

        let pan = &m.properties[0];
        assert_eq!((pan.function, pan.channel, pan.width), (ChannelFunction::Pan, 1, 2));
        let tilt = &m.properties[1];
        assert_eq!((tilt.channel, tilt.width, tilt.default_value), (3, 2, 32768));
        let shutter = m.properties.iter().find(|p| p.code == "Shutter").expect("Shutter");
        assert_eq!(shutter.function, ChannelFunction::Shutter);
        assert_eq!(shutter.default_value, 30);
        assert_eq!(shutter.capabilities.len(), 2);
        assert_eq!(shutter.capabilities[1].label, "开光");
        assert_eq!(shutter.capabilities[0].label, "Closed");
        let color = m.properties.iter().find(|p| p.code == "Color").expect("Color");
        assert_eq!(color.function, ChannelFunction::ColorWheel);
        assert_eq!(color.capabilities[1].color, Some([255, 0, 0]));
        // 第 8 通道为空，Mystery 在第 9 通道
        assert_eq!(m.properties.last().map(|p| (p.channel, p.function)), Some((9, ChannelFunction::Other)));
        assert_eq!(m.channel_count(), 9);

        let physical = m.physical.as_ref().expect("物理参数");
        assert_eq!(physical.pan_range_deg, Some(540.0));
        assert_eq!(physical.beam_max_deg, Some(30.0));
        assert_eq!(m.validate(), Ok(()));
    }

    #[test]
    fn 比例能力区间解析起止物理量_定义分辨率换算到位宽() {
        let report = import_ofl(SPOT, "test/spot").expect("应能导入");
        let m = &report.models[0];
        // Pan 定义分辨率 16 位、模式里也是 16 位：区间（隐含整段）不生成；物理量在单能力上不展开为区间
        assert!(m.properties[0].capabilities.is_empty());
        let basic = &m.modes[0];
        assert_eq!(basic.id, "6ch");
        assert_eq!(basic.name, "Basic");
        // 基本模式只用粗调：Tilt 默认值 50% 按 16 位定义换算到 8 位
        let tilt = &basic.properties[1];
        assert_eq!((tilt.width, tilt.default_value), (1, 128));
    }

    #[test]
    fn 不紧跟粗调的精细通道独立导入并告警() {
        let report = import_ofl(SPOT, "t/s").expect("应能导入");
        let basic = &report.models[0].modes[0];
        let last = basic.properties.last().expect("最后一个通道");
        assert_eq!((last.code.as_str(), last.channel), ("Tilt fine", 6));
        assert!(report
            .warnings
            .iter()
            .any(|w| w.kind == ImportWarningKind::FineChannelSeparate && w.detail.as_deref() == Some("Tilt fine")));
        assert!(report
            .warnings
            .iter()
            .any(|w| w.kind == ImportWarningKind::UnknownFunction && w.detail.as_deref() == Some("Mystery")));
    }

    #[test]
    fn 像素矩阵按像素展开并记录所属像素() {
        let bar = r#"{
          "name": "Pixel Bar 4",
          "matrix": {"pixelCount": [4, 1, 1]},
          "availableChannels": {"Master": {"capability": {"type": "Intensity"}}},
          "templateChannels": {
            "Red $pixelKey": {"capability": {"type": "ColorIntensity", "color": "Red"}},
            "Green $pixelKey": {"capability": {"type": "ColorIntensity", "color": "Green"}},
            "Blue $pixelKey": {"capability": {"type": "ColorIntensity", "color": "Blue"}}
          },
          "modes": [{"name": "13ch", "channels": ["Master",
            {"insert": "matrixChannels", "repeatFor": "eachPixelXYZ", "channelOrder": "perPixel",
             "templateChannels": ["Red $pixelKey", "Green $pixelKey", "Blue $pixelKey"]}]}]
        }"#;
        let report = import_ofl(bar, "x/bar").expect("应能导入");
        let m = &report.models[0];
        assert_eq!(m.matrix, Some(MatrixLayout { cols: 4, rows: 1 }));
        assert_eq!(m.channel_count(), 13);
        let blue4 = m.properties.last().expect("最后一个通道");
        assert_eq!((blue4.code.as_str(), blue4.head, blue4.function), ("Blue 4", 4, ChannelFunction::Blue));
        assert_eq!(m.properties[1].head, 1);
        assert_eq!(m.validate(), Ok(()));
    }

    #[test]
    fn 非法输入() {
        assert!(matches!(import_ofl("[1,2]", "x"), Err(ImportError::Open(_))));
        assert!(matches!(import_ofl("{nope", "x"), Err(ImportError::Open(_))));
        assert!(matches!(import_ofl(r#"{"name":"x","modes":[]}"#, "x"), Err(ImportError::NoModels)));
    }

    #[test]
    fn 物理量解析() {
        assert_eq!(entity(&Value::from("530deg")), Some((530.0, "deg".into())));
        assert_eq!(entity(&Value::from("-50%")), Some((-50.0, "%".into())));
        assert_eq!(entity(&Value::from("fast")), None);
        assert_eq!(hex_color("#00ff80"), Some([0, 255, 128]));
        assert_eq!(dmx_value(&Value::from("100%"), 8), Some(255));
    }
}
