//! Open Fixture Library（OFL）灯具 JSON 导入（适配器）。
//!
//! 把 OFL 的灯具定义转成本工程的 [`FixtureModel`]。主要规则（完整说明见 `doc/OFL 适配说明.md`）：
//!
//! - 第一个可用的 OFL 模式成为默认模式，其余进入 `modes`（最多 [`MAX_MODES`] 个）；
//! - 模板通道按像素 / 像素组展开，矩阵插入块按 `repeatFor` 与 `channelOrder` 展开；
//! - 切换通道（`switchChannels`）按依赖通道的默认值解析成实际通道，其它取值写进说明；
//! - 粗调后紧跟第一级精细通道时合并为 16 位；更高级的精细通道独立保留并告警；
//! - 通道功能按“覆盖 DMX 范围最大的一类能力”判定（不计无功能区间），轮子先看槽位类型、再看名称，
//!   省略 `wheel` 时轮子名取通道名（OFL 规范）；
//! - 单个能力也生成覆盖整条通道的区间，比例区间按固定优先级解析起止物理量（支持 `fast`、`near` 等关键字）；
//! - 同一像素里重复的唯一功能降为“其他”；单个通道、区间或模式出问题只降级它自己，不拒收整台灯。
//!
//! 参考：<https://github.com/OpenLightingProject/open-fixture-library/blob/master/docs/fixture-format.md>、
//! <https://github.com/OpenLightingProject/open-fixture-library/blob/master/docs/capability-types.md>。

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fmt;

use regex_lite::Regex;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

use super::color_names::lookup_color_name;
use super::import::{ImportError, ImportReport, ImportWarning, ImportWarningKind};
use super::model::{
    validate_layout, Appearance, AppearanceOrigin, Capability, CapabilityTag, ChannelFunction, Emitter,
    FixtureMode, FixtureModel, FixtureProperty, FixtureShape, FocusType, MatrixLayout, ModelSource, Physical,
    Precedence, DMX_CHANNELS, MAX_CAPABILITIES, MAX_HEADS, MAX_ID_LEN, MAX_MODES,
};

/// OFL 导入时的工作表名占位（警告里的 `sheet` 字段）。
const SHEET: &str = "OFL";

/// OFL 识别规则的版本：映射规则变化时递增，库里旧版本识别的模型会被标为“可更新”。
///
/// - 3：导入外形尺寸 / 重量 / 功率 / 镜头名 / 运动方式，按规则推断外形模板，
///   色轮槽位按名字查色、分色片保留第二种颜色。
pub const OFL_RECOGNIZER_VERSION: u32 = 3;

type Obj = Map<String, Value>;

/// 解析一个 OFL 灯具 JSON（制造商名取 JSON 或标识的第一段）。
///
/// # Arguments
///
/// * `text` - 灯具 JSON 文本。
/// * `fallback_key` - 生成模型编号用的标识，通常为 `制造商目录/文件名`（例如 `cameo/auro-spot-200`）。
///
/// # Returns
///
/// 只含一个模型的导入结果，以及过程中的警告。
///
/// # Errors
///
/// - 文本不是 JSON 对象时返回 [`ImportError::Open`]。
/// - 是重定向文件时返回 [`ImportError::Redirect`]。
/// - 没有任何可用模式时返回 [`ImportError::NoModels`]（各模式不可用的原因写入警告）。
pub fn import_ofl(text: &str, fallback_key: &str) -> Result<ImportReport, ImportError> {
    import_ofl_as(text, fallback_key, None)
}

/// 解析一个 OFL 灯具 JSON，并指定制造商显示名（整库导入时取自 `manufacturers.json`）。
///
/// # Arguments
///
/// * `text` - 灯具 JSON 文本。
/// * `key` - 生成模型编号用的标识（`制造商目录/文件名`）。
/// * `manufacturer` - 制造商显示名；`None` 时取 JSON 里的 `manufacturer`，再退回标识的第一段。
///
/// # Returns
///
/// 只含一个模型的导入结果，以及过程中的警告。
///
/// # Errors
///
/// 同 [`import_ofl`]。
pub fn import_ofl_as(text: &str, key: &str, manufacturer: Option<&str>) -> Result<ImportReport, ImportError> {
    let root: Value = serde_json::from_str(text).map_err(|e| ImportError::Open(e.to_string()))?;
    let Some(root) = root.as_object() else {
        return Err(ImportError::Open("not an object".into()));
    };
    if let Some(target) = str_of(root, "redirectTo")
        && !root.contains_key("modes")
    {
        return Err(ImportError::Redirect(target.to_owned()));
    }
    let name = str_of(root, "name").unwrap_or(key).trim().to_owned();
    let manufacturer = manufacturer
        .map(str::to_owned)
        .or_else(|| {
            root.get("manufacturer")
                .and_then(|m| m.as_object().and_then(|o| str_of(o, "name")).or_else(|| m.as_str()))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| key.split('/').next().unwrap_or_default().to_owned());
    let id = model_id(key, &name);

    let ctx = Context::new(root, &pixel_group_order(text), id.clone());
    let all_modes: Vec<&Obj> = root
        .get("modes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .collect();
    // 默认模式 + 附加模式
    if all_modes.len() > MAX_MODES + 1 {
        ctx.warn(ImportWarningKind::UnsupportedFeature, "", &format!("modes>{}", MAX_MODES + 1));
    }
    let mut built: Vec<(String, String, Vec<FixtureProperty>)> = Vec::new();
    for mode in all_modes.into_iter().take(MAX_MODES + 1) {
        let mode_name = str_of(mode, "name").unwrap_or_default().to_owned();
        let short = str_of(mode, "shortName").unwrap_or(&mode_name).to_owned();
        if let Some(props) = ctx.mode_layout(mode, &mode_name) {
            built.push((short, mode_name, props));
        }
    }

    // 像素排布：网格能容纳各模式用到的最大像素号时用网格，否则（按像素组编号）退化为单行
    let max_head = built.iter().flat_map(|(_, _, p)| p.iter().map(|x| x.head)).max().unwrap_or(0);
    let matrix = match ctx.matrix.layout {
        Some(l) if max_head <= l.heads() => Some(l),
        _ if max_head > 0 => Some(MatrixLayout { cols: max_head.min(MAX_HEADS), rows: 1 }),
        other => other,
    };
    let heads = matrix.map_or(0, |m| m.heads());
    built.retain(|(_, mode_name, props)| match validate_layout(props, heads) {
        Ok(()) => true,
        Err(e) => {
            ctx.warn(ImportWarningKind::ModeSkipped, mode_name, e.code());
            false
        }
    });
    if built.is_empty() {
        return Err(ImportError::NoModels);
    }

    let (_, default_name, properties) = built.remove(0);
    let mut used_ids: Vec<String> = Vec::new();
    let extra_modes: Vec<FixtureMode> = built
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
    let emitters = emitters_of(root, std::iter::once(&properties).chain(extra_modes.iter().map(|m| &m.properties)));
    let physical = physical_of(root);
    let appearance = Appearance {
        shape: shape_of(&categories, physical.as_ref(), matrix, &properties),
        origin: AppearanceOrigin::Rule,
        ..Appearance::default()
    };
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
        matrix,
        emitters,
        physical,
        appearance: Some(appearance),
        source: Some(ModelSource { kind: "ofl".into(), key: key.to_owned(), recognizer: OFL_RECOGNIZER_VERSION }),
    };
    let mut report = ImportReport { models: Vec::new(), warnings: ctx.into_warnings() };
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

// ---------------------------------------------------------------------------
// 像素组的出现顺序（serde_json 的对象按键排序，`eachPixelGroup` 需要 JSON 里的原始顺序）
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct OrderProbe {
    #[serde(default)]
    matrix: Option<MatrixProbe>,
}

#[derive(Deserialize, Default)]
struct MatrixProbe {
    #[serde(default, rename = "pixelGroups")]
    pixel_groups: Option<KeyOrder>,
}

/// 只记录对象键的出现顺序。
struct KeyOrder(Vec<String>);

impl<'de> Deserialize<'de> for KeyOrder {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = KeyOrder;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<KeyOrder, A::Error> {
                let mut keys = Vec::new();
                while let Some(k) = map.next_key::<String>()? {
                    map.next_value::<IgnoredAny>()?;
                    keys.push(k);
                }
                Ok(KeyOrder(keys))
            }
        }
        d.deserialize_map(V)
    }
}

/// 像素组键在 JSON 里的出现顺序；解析失败时为空（退回按键排序）。
fn pixel_group_order(text: &str) -> Vec<String> {
    serde_json::from_str::<OrderProbe>(text)
        .ok()
        .and_then(|p| p.matrix?.pixel_groups)
        .map(|k| k.0)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 矩阵
// ---------------------------------------------------------------------------

/// 一个像素：键、网格位置（1 起的 x / y / z）与像素号（网格行优先，1 起）。
#[derive(Debug, Clone)]
struct Pixel {
    key: String,
    pos: [u32; 3],
    head: u16,
}

/// 解析后的矩阵。
#[derive(Debug, Default)]
struct Matrix {
    /// 像素，按 XYZ 顺序（即网格行优先）。
    pixels: Vec<Pixel>,
    /// 网格排布；像素数超过 [`MAX_HEADS`] 或没有矩阵时为 `None`。
    layout: Option<MatrixLayout>,
    /// 像素组：`(组名, 像素下标)`，按 JSON 里的顺序。
    groups: Vec<(String, Vec<usize>)>,
}

/// 像素或像素组（模板通道里 `$pixelKey` 的取值）。
#[derive(Debug, Clone, Copy)]
enum Unit {
    /// 像素（`Matrix::pixels` 的下标）。
    Pixel(usize),
    /// 像素组（`Matrix::groups` 的下标）。
    Group(usize),
}

fn parse_matrix(m: Option<&Value>, group_order: &[String]) -> (Matrix, Vec<String>) {
    let mut notes = Vec::new();
    let Some(m) = m.and_then(Value::as_object) else {
        return (Matrix::default(), notes);
    };
    let mut pixels = Vec::new();
    let (mut xc, mut yc, mut zc) = (0u32, 0u32, 0u32);
    if let Some(count) = m.get("pixelCount").and_then(Value::as_array) {
        let dim = |i: usize| count.get(i).and_then(Value::as_u64).unwrap_or(1).clamp(1, 4096) as u32;
        (xc, yc, zc) = (dim(0), dim(1), dim(2));
        let dims = [xc, yc, zc].iter().filter(|&&c| c > 1).count();
        for z in 1..=zc {
            for y in 1..=yc {
                for x in 1..=xc {
                    let key = match dims {
                        3 => format!("({x}, {y}, {z})"),
                        2 if zc == 1 => format!("({x}, {y})"),
                        2 if yc == 1 => format!("({x}, {z})"),
                        2 => format!("({y}, {z})"),
                        _ if xc > 1 => format!("{x}"),
                        _ if yc > 1 => format!("{y}"),
                        _ => format!("{z}"),
                    };
                    pixels.push((key, [x, y, z]));
                }
            }
        }
    } else if let Some(grid) = m.get("pixelKeys").and_then(Value::as_array) {
        // pixelKeys[z][y][x]，null 为空洞
        zc = grid.len() as u32;
        for (zi, layer) in grid.iter().enumerate() {
            let rows = layer.as_array().map(Vec::as_slice).unwrap_or_default();
            yc = yc.max(rows.len() as u32);
            for (yi, row) in rows.iter().enumerate() {
                let cells = row.as_array().map(Vec::as_slice).unwrap_or_default();
                xc = xc.max(cells.len() as u32);
                for (xi, cell) in cells.iter().enumerate() {
                    if let Some(key) = cell.as_str() {
                        pixels.push((key.to_owned(), [xi as u32 + 1, yi as u32 + 1, zi as u32 + 1]));
                    }
                }
            }
        }
    }
    if pixels.is_empty() {
        return (Matrix::default(), notes);
    }
    let (xc, yc) = (xc.max(1), yc.max(1));
    let zc = zc.max(1);
    let cells = u64::from(xc) * u64::from(yc) * u64::from(zc);
    let layout = if cells <= u64::from(MAX_HEADS) {
        Some(MatrixLayout { cols: xc as u16, rows: (yc * zc) as u16 })
    } else {
        notes.push("matrix".to_owned());
        None
    };
    let mut pixels: Vec<Pixel> = pixels
        .into_iter()
        .map(|(key, [x, y, z])| {
            let index = (u64::from(z - 1) * u64::from(yc) + u64::from(y - 1)) * u64::from(xc) + u64::from(x - 1);
            Pixel { key, pos: [x, y, z], head: u16::try_from(index + 1).unwrap_or(u16::MAX) }
        })
        .collect();
    pixels.sort_by_key(|p| (p.pos[2], p.pos[1], p.pos[0]));

    let mut groups = Vec::new();
    if let Some(defs) = m.get("pixelGroups").and_then(Value::as_object) {
        let mut names: Vec<String> = group_order.iter().filter(|k| defs.contains_key(*k)).cloned().collect();
        for k in defs.keys() {
            if !names.contains(k) {
                names.push(k.clone());
            }
        }
        for name in names {
            match group_members(&defs[&name], &pixels) {
                Some(members) => groups.push((name, members)),
                None => notes.push(format!("pixelGroup:{name}")),
            }
        }
    }
    (Matrix { pixels, layout, groups }, notes)
}

/// 像素组的成员（像素下标）；约束无法解析时为 `None`。
fn group_members(def: &Value, pixels: &[Pixel]) -> Option<Vec<usize>> {
    match def {
        Value::String(s) if s == "all" => Some((0..pixels.len()).collect()),
        Value::Array(keys) => Some(
            keys.iter()
                .filter_map(Value::as_str)
                .filter_map(|k| pixels.iter().position(|p| p.key == k))
                .collect(),
        ),
        Value::Object(c) => {
            let list_of = |name: &str| -> Option<Vec<String>> {
                Some(c.get(name)?.as_array()?.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            };
            let coord_rules: Vec<(usize, Vec<String>)> =
                [(0, "x"), (1, "y"), (2, "z")].iter().filter_map(|&(i, n)| list_of(n).map(|v| (i, v))).collect();
            let names: Vec<Regex> = match list_of("name") {
                Some(list) => list.iter().map(|r| Regex::new(r).ok()).collect::<Option<Vec<_>>>()?,
                None => Vec::new(),
            };
            let mut out = Vec::new();
            for (i, p) in pixels.iter().enumerate() {
                let coords_ok = coord_rules
                    .iter()
                    .all(|(a, cs)| cs.iter().all(|c| axis_constraint(p.pos[*a], c).unwrap_or(false)));
                if coords_ok && names.iter().all(|r| r.is_match(&p.key)) {
                    out.push(i);
                }
            }
            Some(out)
        }
        _ => None,
    }
}

/// 像素组的坐标约束：`<=5`、`=5`、`>=5`、`3n`、`3n+1`、`even`、`odd`。
fn axis_constraint(v: u32, c: &str) -> Option<bool> {
    let c = c.trim();
    let num = |s: &str| s.trim().parse::<u32>().ok();
    Some(if let Some(n) = c.strip_prefix("<=") {
        v <= num(n)?
    } else if let Some(n) = c.strip_prefix(">=") {
        v >= num(n)?
    } else if let Some(n) = c.strip_prefix('=') {
        v == num(n)?
    } else if c == "even" {
        v.is_multiple_of(2)
    } else if c == "odd" {
        v % 2 == 1
    } else if let Some((a, b)) = c.split_once('n') {
        let a = num(a)?;
        let b = if b.trim().is_empty() { 0 } else { num(b.trim().strip_prefix('+')?)? };
        a > 0 && v % a == b % a
    } else {
        return None;
    })
}

/// 自然排序（数字段按数值比较）：`"2"` 排在 `"10"` 前面。
fn natural_cmp(left: &str, right: &str) -> Ordering {
    fn digits(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
        let mut s = String::new();
        while let Some(&ch) = it.peek() {
            if !ch.is_ascii_digit() {
                break;
            }
            s.push(ch);
            it.next();
        }
        s
    }
    let (mut lhs, mut rhs) = (left.chars().peekable(), right.chars().peekable());
    loop {
        match (lhs.peek().copied(), rhs.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) if a.is_ascii_digit() && b.is_ascii_digit() => {
                let (num_l, num_r) = (digits(&mut lhs), digits(&mut rhs));
                let (num_l, num_r) = (num_l.trim_start_matches('0'), num_r.trim_start_matches('0'));
                let ord = num_l.len().cmp(&num_r.len()).then_with(|| num_l.cmp(num_r));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(a), Some(b)) => {
                let ord = a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                lhs.next();
                rhs.next();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 通道键解析
// ---------------------------------------------------------------------------

/// 模式里一个通道键的含义。
#[derive(Debug, Clone)]
enum Entry<'a> {
    /// 粗调通道（普通通道或展开后的模板通道），`unit` 为模板的像素 / 像素组名。
    Coarse { def: &'a Obj, unit: Option<String> },
    /// 精细通道：粗调通道键、精细级别（1 起）与所属像素。
    Fine { coarse: String, level: usize, unit: Option<String> },
    /// 切换通道别名：取值由 `owner`（依赖通道键）的当前能力决定。
    Switch { owner: String },
}

/// 展开后的一个 DMX 通道：通道键，以及切换通道的说明。
#[derive(Debug, Clone)]
struct SlotKey {
    key: String,
    note: Option<String>,
}

/// 解析上下文。
struct Context<'a> {
    wheels: Option<&'a Obj>,
    matrix: Matrix,
    units: HashMap<String, Unit>,
    entries: HashMap<String, Entry<'a>>,
    model_id: String,
    warnings: RefCell<Vec<ImportWarning>>,
}

impl<'a> Context<'a> {
    fn new(root: &'a Obj, group_order: &[String], model_id: String) -> Self {
        let (matrix, notes) = parse_matrix(root.get("matrix"), group_order);
        let mut units = HashMap::new();
        for (i, p) in matrix.pixels.iter().enumerate() {
            units.insert(p.key.clone(), Unit::Pixel(i));
        }
        for (i, (name, _)) in matrix.groups.iter().enumerate() {
            units.entry(name.clone()).or_insert(Unit::Group(i));
        }

        let mut entries: HashMap<String, Entry<'a>> = HashMap::new();
        let insert_def = |entries: &mut HashMap<String, Entry<'a>>, key: String, def: &'a Obj, unit: Option<String>| {
            for (i, alias) in def
                .get("fineChannelAliases")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .enumerate()
            {
                entries.insert(
                    subst(alias, unit.as_deref()),
                    Entry::Fine { coarse: key.clone(), level: i + 1, unit: unit.clone() },
                );
            }
            entries.insert(key, Entry::Coarse { def, unit });
        };
        if let Some(templates) = root.get("templateChannels").and_then(Value::as_object) {
            let names: Vec<&String> = matrix.pixels.iter().map(|p| &p.key).chain(matrix.groups.iter().map(|g| &g.0)).collect();
            for unit in names {
                for (tpl, def) in templates {
                    let Some(def) = def.as_object() else { continue };
                    insert_def(&mut entries, subst(tpl, Some(unit)), def, Some(unit.clone()));
                }
            }
        }
        if let Some(channels) = root.get("availableChannels").and_then(Value::as_object) {
            for (key, def) in channels {
                let Some(def) = def.as_object() else { continue };
                // 覆盖展开后的模板通道时保留所属像素
                let unit = match entries.get(key) {
                    Some(Entry::Coarse { unit, .. }) => unit.clone(),
                    _ => None,
                };
                insert_def(&mut entries, key.clone(), def, unit);
            }
        }
        // 切换通道别名：依赖通道各能力的 switchChannels 键
        let mut switches = Vec::new();
        for (key, entry) in &entries {
            let Entry::Coarse { def, unit } = entry else { continue };
            for cap in capabilities_of(def) {
                if let Some(sw) = cap.get("switchChannels").and_then(Value::as_object) {
                    for alias in sw.keys() {
                        switches.push((subst(alias, unit.as_deref()), key.clone()));
                    }
                }
            }
        }
        for (alias, owner) in switches {
            entries.entry(alias).or_insert(Entry::Switch { owner });
        }

        let ctx = Self {
            wheels: root.get("wheels").and_then(Value::as_object),
            matrix,
            units,
            entries,
            model_id,
            warnings: RefCell::new(Vec::new()),
        };
        for note in notes {
            ctx.warn(ImportWarningKind::UnsupportedFeature, "", &note);
        }
        ctx
    }

    fn warn(&self, kind: ImportWarningKind, mode: &str, detail: &str) {
        let w = ImportWarning {
            kind,
            sheet: if mode.is_empty() { SHEET.into() } else { format!("{SHEET} · {mode}") },
            row: None,
            model_id: Some(self.model_id.clone()),
            detail: Some(detail.to_owned()),
        };
        let mut list = self.warnings.borrow_mut();
        if !list.contains(&w) {
            list.push(w);
        }
    }

    fn into_warnings(self) -> Vec<ImportWarning> {
        self.warnings.into_inner()
    }

    // ---- 模式 ----

    /// 构造一个模式的通道布局；模式无法使用时告警并返回 `None`。
    fn mode_layout(&self, mode: &Obj, mode_name: &str) -> Option<Vec<FixtureProperty>> {
        let mut slots: Vec<Option<SlotKey>> = Vec::new();
        for entry in mode.get("channels").and_then(Value::as_array).into_iter().flatten() {
            match entry {
                Value::String(key) => slots.push(self.switch_target(key)),
                Value::Object(ins) => {
                    if let Err(reason) = self.expand_insert(ins, &mut slots) {
                        self.warn(ImportWarningKind::ModeSkipped, mode_name, &reason);
                        return None;
                    }
                }
                // `null` 表示未使用的通道
                _ => slots.push(None),
            }
        }
        if slots.len() > usize::from(DMX_CHANNELS) {
            self.warn(ImportWarningKind::ModeSkipped, mode_name, "channels>512");
            return None;
        }

        let mut props: Vec<FixtureProperty> = Vec::new();
        let mut units: Vec<Option<String>> = Vec::new();
        let mut i = 0usize;
        while i < slots.len() {
            let channel = (i + 1) as u16;
            let Some(slot) = &slots[i] else {
                i += 1;
                continue;
            };
            match self.entries.get(&slot.key) {
                Some(Entry::Coarse { def, unit }) => {
                    let first_fine = def
                        .get("fineChannelAliases")
                        .and_then(Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(Value::as_str)
                        .map(|alias| subst(alias, unit.as_deref()));
                    let merged = matches!(
                        (first_fine.as_deref(), slots.get(i + 1)),
                        (Some(f), Some(Some(next))) if f == next.key
                    );
                    let width: u8 = if merged { 2 } else { 1 };
                    let mut prop = self.property(&slot.key, def, unit.as_deref(), channel, width, mode_name);
                    if let Some(note) = &slot.note {
                        prop.description.clone_from(note);
                    }
                    props.push(prop);
                    units.push(unit.clone());
                    i += usize::from(width);
                }
                Some(Entry::Fine { coarse, level, unit }) => {
                    let kind = if *level == 1 {
                        ImportWarningKind::FineChannelSeparate
                    } else {
                        ImportWarningKind::FineChannelTruncated
                    };
                    self.warn(kind, mode_name, &slot.key);
                    props.push(FixtureProperty {
                        name: slot.key.clone(),
                        code: slot.key.clone(),
                        function: ChannelFunction::Other,
                        channel,
                        width: 1,
                        big_endian: true,
                        description: format!("fine of {coarse}"),
                        ..FixtureProperty::default()
                    });
                    units.push(unit.clone());
                    i += 1;
                }
                Some(Entry::Switch { .. }) | None => {
                    self.warn(ImportWarningKind::UnknownChannel, mode_name, &slot.key);
                    i += 1;
                }
            }
        }
        if props.is_empty() {
            self.warn(ImportWarningKind::ModeSkipped, mode_name, "empty");
            return None;
        }
        self.assign_heads(&mut props, &units, mode_name);
        self.demote_duplicates(&mut props, mode_name);
        Some(props)
    }

    /// 通道键为切换通道别名时，按依赖通道的默认值换成实际通道；`null` 目标为空通道。
    fn switch_target(&self, key: &str) -> Option<SlotKey> {
        let Some(Entry::Switch { owner }) = self.entries.get(key) else {
            return Some(SlotKey { key: key.to_owned(), note: None });
        };
        let Some(Entry::Coarse { def, unit }) = self.entries.get(owner) else {
            return Some(SlotKey { key: key.to_owned(), note: None });
        };
        let unit = unit.as_deref();
        let bits = source_bits(def);
        let full = (1u64 << bits) - 1;
        let default = def.get("defaultValue").and_then(|v| dmx_value(v, bits)).unwrap_or(0);
        let mut chosen: Option<Option<String>> = None;
        let mut alternatives: Vec<String> = Vec::new();
        for (cap, [lo, hi]) in ranged_capabilities(def, full) {
            let Some(sw) = cap.get("switchChannels").and_then(Value::as_object) else { continue };
            let Some(target) = sw.iter().find(|(k, _)| subst(k, unit) == key).map(|(_, v)| v.as_str().map(|s| subst(s, unit))) else {
                continue;
            };
            if chosen.is_none() && (lo..=hi).contains(&default) {
                chosen = Some(target.clone());
            }
            let label = target.unwrap_or_else(|| "—".into());
            match alternatives.last_mut() {
                Some(last) if last.ends_with(&format!(" {label}")) => {}
                _ => alternatives.push(format!("{lo}~{hi} {label}")),
            }
        }
        let owner_name = str_of(def, "name").map_or_else(|| owner.clone(), |n| subst(n, unit));
        let note = format!("随“{owner_name}”切换：{}", alternatives.join("；"));
        chosen.flatten().map(|k| SlotKey { key: k, note: Some(note) })
    }

    /// 展开矩阵插入块。
    fn expand_insert(&self, ins: &Obj, slots: &mut Vec<Option<SlotKey>>) -> Result<(), String> {
        if str_of(ins, "insert") != Some("matrixChannels") {
            return Err(format!("insert:{}", str_of(ins, "insert").unwrap_or("?")));
        }
        let templates: Vec<&str> = ins
            .get("templateChannels")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let units = self.repeat_units(ins.get("repeatFor"))?;
        let per_pixel = str_of(ins, "channelOrder") != Some("perChannel");
        let mut push = |unit: &str, tpl: &str| slots.push(self.switch_target(&subst(tpl, Some(unit))));
        if per_pixel {
            for u in &units {
                for t in &templates {
                    push(u, t);
                }
            }
        } else {
            for t in &templates {
                for u in &units {
                    push(u, t);
                }
            }
        }
        Ok(())
    }

    /// `repeatFor` 得到的像素 / 像素组名。
    fn repeat_units(&self, repeat: Option<&Value>) -> Result<Vec<String>, String> {
        let pixels = &self.matrix.pixels;
        match repeat {
            Some(Value::Array(list)) => {
                let names: Vec<String> = list.iter().filter_map(Value::as_str).map(str::to_owned).collect();
                match names.iter().find(|n| !self.units.contains_key(*n)) {
                    Some(missing) => Err(format!("repeatFor:{missing}")),
                    None => Ok(names),
                }
            }
            Some(Value::String(s)) if s == "eachPixelGroup" => Ok(self.matrix.groups.iter().map(|g| g.0.clone()).collect()),
            Some(Value::String(s)) if s == "eachPixelABC" => {
                let mut keys: Vec<String> = pixels.iter().map(|p| p.key.clone()).collect();
                keys.sort_by(|a, b| natural_cmp(a, b));
                Ok(keys)
            }
            Some(Value::String(s)) if s.len() == 12 && s.starts_with("eachPixel") => {
                let order: Vec<usize> = s[9..]
                    .chars()
                    .map(|c| match c {
                        'X' => Some(0),
                        'Y' => Some(1),
                        'Z' => Some(2),
                        _ => None,
                    })
                    .collect::<Option<Vec<_>>>()
                    .filter(|o| o.iter().collect::<HashSet<_>>().len() == 3)
                    .ok_or_else(|| format!("repeatFor:{s}"))?;
                // 第一个字母变化最快：按（第三、第二、第一）字母的坐标排序
                let mut list: Vec<&Pixel> = pixels.iter().collect();
                list.sort_by_key(|p| (p.pos[order[2]], p.pos[order[1]], p.pos[order[0]]));
                Ok(list.into_iter().map(|p| p.key.clone()).collect())
            }
            Some(other) => Err(format!("repeatFor:{other}")),
            None => Err("repeatFor".into()),
        }
    }

    /// 按通道所属的像素 / 像素组分配像素号。
    ///
    /// 只有真实像素时用网格位置；用到像素组时按组出现的顺序从 1 编号（并告警）。
    /// 覆盖全部像素的组（例如 `Master`）在模式里还有其它像素单元时视为整灯（像素号 0）。
    fn assign_heads(&self, props: &mut [FixtureProperty], units: &[Option<String>], mode_name: &str) {
        let mut order: Vec<&str> = Vec::new();
        for u in units.iter().flatten() {
            if !order.contains(&u.as_str()) {
                order.push(u);
            }
        }
        if order.is_empty() {
            return;
        }
        let covers_all = |u: &str| match self.units.get(u) {
            Some(Unit::Group(g)) => {
                let n = self.matrix.groups[*g].1.len();
                n > 0 && n == self.matrix.pixels.len()
            }
            _ => false,
        };
        let multiple = order.len() > 1;
        let rest: Vec<&str> = order.iter().copied().filter(|u| !(multiple && covers_all(u))).collect();
        let any_group = rest.iter().any(|u| matches!(self.units.get(*u), Some(Unit::Group(_))));
        let mut head_of: HashMap<&str, u16> = order.iter().map(|u| (*u, 0)).collect();
        if any_group {
            self.warn(ImportWarningKind::PixelGroupsAsHeads, mode_name, &rest.join(", "));
            for (n, u) in rest.iter().enumerate() {
                head_of.insert(u, (n + 1) as u16);
            }
        } else {
            for u in &rest {
                if let Some(Unit::Pixel(i)) = self.units.get(*u) {
                    head_of.insert(u, self.matrix.pixels[*i].head);
                }
            }
        }
        for (p, u) in props.iter_mut().zip(units) {
            p.head = u.as_deref().and_then(|u| head_of.get(u).copied()).unwrap_or(0);
        }
    }

    /// 同一像素里重复的唯一功能：第一个保留，其余降为“其他”。
    fn demote_duplicates(&self, props: &mut [FixtureProperty], mode_name: &str) {
        let mut seen: HashSet<(ChannelFunction, u16)> = HashSet::new();
        for p in props {
            if p.function.is_unique() && !seen.insert((p.function, p.head)) {
                self.warn(ImportWarningKind::DuplicateFunctionDemoted, mode_name, &p.code);
                p.function = ChannelFunction::Other;
            }
        }
    }

    // ---- 通道 ----

    fn property(
        &self,
        key: &str,
        def: &Obj,
        unit: Option<&str>,
        channel: u16,
        width: u8,
        mode_name: &str,
    ) -> FixtureProperty {
        let name = str_of(def, "name").map_or_else(|| key.to_owned(), |n| subst(n, unit));
        let res = Resolution { source: source_bits(def), target: 8 * u32::from(width) };
        let max = if width >= 2 { u16::MAX } else { 255 };
        let ranged = ranged_capabilities(def, res.full());
        let function = self.channel_function(&name, key, &ranged);
        if function == ChannelFunction::Other {
            self.warn(ImportWarningKind::UnknownFunction, mode_name, key);
        }

        let mut capabilities: Vec<Capability> = Vec::new();
        for (cap, [lo, hi]) in &ranged {
            let lo = res.convert(*lo, false).min(max);
            let hi = res.convert(*hi, true).min(max);
            if lo > hi || capabilities.last().is_some_and(|p| lo <= p.range[1]) {
                self.warn(ImportWarningKind::CapabilityDropped, mode_name, key);
                continue;
            }
            if capabilities.len() == MAX_CAPABILITIES {
                self.warn(ImportWarningKind::CapabilityDropped, mode_name, key);
                break;
            }
            capabilities.push(self.capability(cap, [lo, hi], &name, unit));
        }

        let default_value = match def.get("defaultValue").and_then(|v| dmx_value(v, res.source)) {
            Some(v) => res.convert(v, false).min(max),
            // 快门没有默认值时取“开光”区间的中点，否则摇头灯不出光
            None if function == ChannelFunction::Shutter => capabilities
                .iter()
                .find(|c| c.tag == Some(CapabilityTag::ShutterOpen))
                .map_or_else(|| function.default_value(width), |c| midpoint(c.range)),
            None => function.default_value(width),
        };
        let highlight_value = def
            .get("highlightValue")
            .and_then(|v| dmx_value(v, res.source))
            .map(|v| res.convert(v, true).min(max));
        let precedence = match str_of(def, "precedence") {
            Some("HTP") => Some(Precedence::Htp),
            Some("LTP") => Some(Precedence::Ltp),
            _ => None,
        };
        FixtureProperty {
            name,
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

    /// 通道功能：各能力按覆盖的 DMX 宽度投票（无功能 / 通用能力不计），票数相同取先出现的。
    ///
    /// 选槽通道上的抖动 / 旋转区间并入选槽；宏、程序速度、维护只在没有其它功能时胜出。
    /// 都没有时按通道名识别（含糊的名字如 `Color`、`Speed` 不识别）。
    fn channel_function(&self, name: &str, key: &str, ranged: &[(&Obj, [u64; 2])]) -> ChannelFunction {
        use ChannelFunction as F;
        let mut votes: Vec<(ChannelFunction, u64)> = Vec::new();
        for (cap, [lo, hi]) in ranged {
            let Some(f) = self.function_of(cap, name) else { continue };
            let weight = hi.saturating_sub(*lo) + 1;
            match votes.iter_mut().find(|(g, _)| *g == f) {
                Some((_, w)) => *w += weight,
                None => votes.push((f, weight)),
            }
        }
        // 选槽通道上的抖动 / 旋转区间算作选槽（例如图案轮上的“图案 3 抖动”）
        for (variant, base) in [
            (F::GoboShake, F::Gobo),
            (F::GoboRotate, F::Gobo),
            (F::ColorWheelRotate, F::ColorWheel),
            (F::PrismRotate, F::Prism),
        ] {
            let Some(vi) = votes.iter().position(|(f, _)| *f == variant) else { continue };
            if let Some(bi) = votes.iter().position(|(f, _)| *f == base) {
                let w = votes[vi].1;
                votes[bi].1 += w;
                votes.remove(vi);
            }
        }
        // 宏 / 程序速度 / 维护是通道上的附加功能：有其它功能时不参与比较
        let generic = |f: ChannelFunction| matches!(f, F::Macro | F::EffectSpeed | F::Maintenance | F::Reset);
        let specific = votes.iter().any(|(f, _)| !generic(*f));
        let mut best: Option<(ChannelFunction, u64)> = None;
        for (f, w) in votes {
            if specific && generic(f) {
                continue;
            }
            if best.is_none_or(|(_, b)| w > b) {
                best = Some((f, w));
            }
        }
        best.map(|(f, _)| f)
            .or_else(|| name_function(name))
            .or_else(|| name_function(key))
            .unwrap_or(ChannelFunction::Other)
    }

    /// 能力类型 → 通道功能；无功能、通用与未知类型为 `None`（不参与投票）。
    fn function_of(&self, cap: &Obj, channel_name: &str) -> Option<ChannelFunction> {
        use ChannelFunction as F;
        Some(match str_of(cap, "type").unwrap_or_default() {
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
                "Indigo" => F::Indigo,
                "Cyan" => F::Cyan,
                "Magenta" => F::Magenta,
                "Yellow" => F::Yellow,
                _ => return None,
            },
            "ColorPreset" => F::ColorWheel,
            "ColorTemperature" => F::ColorTemp,
            "Pan" | "PanContinuous" => F::Pan,
            "Tilt" | "TiltContinuous" => F::Tilt,
            "PanTiltSpeed" => F::Speed,
            "ShutterStrobe" | "StrobeSpeed" | "StrobeDuration" => F::Shutter,
            "WheelSlot" | "WheelRotation" | "WheelSlotRotation" | "WheelShake" => self.wheel_function(cap, channel_name),
            "Prism" => F::Prism,
            "PrismRotation" => F::PrismRotate,
            "Frost" | "FrostEffect" => F::Frost,
            "Focus" => F::Focus,
            "Zoom" | "BeamAngle" => F::Zoom,
            "Iris" | "IrisEffect" => F::Iris,
            "BladeInsertion" => F::Blade,
            "BladeRotation" | "BladeSystemRotation" => F::BladeRotate,
            "Rotation" => F::Rotation,
            "Fog" | "FogOutput" | "FogType" => F::Fog,
            "EffectSpeed" | "EffectDuration" | "Speed" | "Time" => F::EffectSpeed,
            "Effect" | "EffectParameter" | "SoundSensitivity" => F::Macro,
            "Maintenance" => {
                let text = str_of(cap, "comment").unwrap_or_default().to_ascii_lowercase();
                if text.contains("reset") { F::Reset } else { F::Maintenance }
            }
            _ => return None,
        })
    }

    /// 轮子能力：轮子名默认取通道名；按轮子槽位的主要类型（颜色 / 图案 / 棱镜…）判断。
    fn wheel_function(&self, cap: &Obj, channel_name: &str) -> ChannelFunction {
        use ChannelFunction as F;
        let wheel = str_of(cap, "wheel").unwrap_or(channel_name);
        let class = self.wheel_class(wheel);
        match (str_of(cap, "type").unwrap_or_default(), class) {
            ("WheelShake", _) => F::GoboShake,
            ("WheelRotation", WheelClass::Color) => F::ColorWheelRotate,
            ("WheelRotation" | "WheelSlotRotation", WheelClass::Prism) => F::PrismRotate,
            ("WheelRotation" | "WheelSlotRotation", _) => F::GoboRotate,
            (_, WheelClass::Color) => F::ColorWheel,
            (_, WheelClass::Prism) => F::Prism,
            (_, WheelClass::Iris) => F::Iris,
            (_, WheelClass::Frost) => F::Frost,
            (_, WheelClass::Gobo) => F::Gobo,
        }
    }

    fn wheel(&self, name: &str) -> Option<&'a Obj> {
        let wheels = self.wheels?;
        wheels
            .get(name)
            .or_else(|| wheels.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v))
            .and_then(Value::as_object)
    }

    fn wheel_class(&self, name: &str) -> WheelClass {
        if let Some(slots) = self.wheel(name).and_then(|w| w.get("slots")).and_then(Value::as_array) {
            let mut counts: Vec<(WheelClass, usize)> = Vec::new();
            for s in slots {
                let class = match s.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "Color" => WheelClass::Color,
                    "Gobo" | "AnimationGoboStart" => WheelClass::Gobo,
                    "Prism" => WheelClass::Prism,
                    "Iris" => WheelClass::Iris,
                    "Frost" => WheelClass::Frost,
                    _ => continue,
                };
                match counts.iter_mut().find(|(c, _)| *c == class) {
                    Some((_, n)) => *n += 1,
                    None => counts.push((class, 1)),
                }
            }
            let mut best: Option<(WheelClass, usize)> = None;
            for (c, n) in counts {
                if best.is_none_or(|(_, b)| n > b) {
                    best = Some((c, n));
                }
            }
            if let Some((c, _)) = best {
                return c;
            }
        }
        let lower = name.to_ascii_lowercase();
        if lower.contains("color") || lower.contains("colour") {
            WheelClass::Color
        } else if lower.contains("prism") {
            WheelClass::Prism
        } else if lower.contains("iris") {
            WheelClass::Iris
        } else if lower.contains("frost") {
            WheelClass::Frost
        } else {
            WheelClass::Gobo
        }
    }

    /// 轮子槽位（`slotNumber` 1 起，小数取整数部分）。
    fn wheel_slot(&self, cap: &Obj, channel_name: &str) -> Option<&'a Obj> {
        let wheel = self.wheel(str_of(cap, "wheel").unwrap_or(channel_name))?;
        let slot = cap.get("slotNumber").or_else(|| cap.get("slotNumberStart"))?.as_f64()?;
        let index = (slot.floor() as usize).checked_sub(1)?;
        wheel.get("slots")?.as_array()?.get(index)?.as_object()
    }

    /// 构造能力区间。
    fn capability(&self, cap: &Obj, range: [u16; 2], channel_name: &str, unit: Option<&str>) -> Capability {
        let kind = str_of(cap, "type").unwrap_or_default();
        let is_wheel = kind.starts_with("Wheel");
        let slot = if is_wheel { self.wheel_slot(cap, channel_name) } else { None };
        let detail = str_of(cap, "shutterEffect")
            .or_else(|| str_of(cap, "effectName"))
            .or_else(|| str_of(cap, "effectPreset"))
            .or_else(|| str_of(cap, "color"))
            .map(str::to_owned)
            .or_else(|| slot.and_then(slot_label))
            .or_else(|| cap.get("slotNumber").map(|v| format!("{kind} {v}")));
        let label = str_of(cap, "comment")
            .map(|c| subst(c, unit))
            .or(detail)
            .unwrap_or_else(|| kind.to_owned());
        let (physical, unit_str, proportional) = cap_physical(cap);
        let (color, color_alt) = capability_colors(cap, slot);
        Capability { range, label, proportional, physical, unit: unit_str, color, color_alt, pattern: None, tag: capability_tag(cap) }
    }
}

/// 能力区间的颜色：先取能力自己的 `colors`，再取槽位的 `colors`；都没有时按槽位名（颜色槽位）
/// 或能力注释（`ColorPreset`）查颜色名字典。第二种不同的颜色记为分色片的 `color_alt`。
fn capability_colors(cap: &Obj, slot: Option<&Obj>) -> (Option<[u8; 3]>, Option<[u8; 3]>) {
    let hexes = |o: &Obj| -> Vec<[u8; 3]> {
        o.get("colors")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).filter_map(hex_color).collect())
            .unwrap_or_default()
    };
    let mut colors = hexes(cap);
    if colors.is_empty() {
        colors = slot.map(hexes).unwrap_or_default();
    }
    if let Some(&first) = colors.first() {
        let alt = colors.iter().copied().find(|c| *c != first);
        return (Some(first), alt);
    }
    let by_name = match (slot, str_of(cap, "type")) {
        (Some(s), _) if str_of(s, "type") == Some("Color") => str_of(s, "name").and_then(lookup_color_name),
        (_, Some("ColorPreset")) => str_of(cap, "comment").and_then(lookup_color_name),
        _ => None,
    };
    (by_name, None)
}

/// 轮子的类别（按槽位的主要类型）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WheelClass {
    Color,
    Gobo,
    Prism,
    Iris,
    Frost,
}

/// 槽位的显示名：`name`，否则按类型（颜色槽位附十六进制色）。
fn slot_label(slot: &Obj) -> Option<String> {
    if let Some(n) = str_of(slot, "name") {
        return Some(n.to_owned());
    }
    let kind = str_of(slot, "type")?;
    Some(match slot.get("colors").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_str) {
        Some(c) if kind == "Color" => format!("Color {c}"),
        _ => kind.to_owned(),
    })
}

/// 能力的语义标签。
fn capability_tag(cap: &Obj) -> Option<CapabilityTag> {
    let has_speed = cap.contains_key("speed") || cap.contains_key("speedStart");
    Some(match str_of(cap, "type").unwrap_or_default() {
        "ShutterStrobe" => match str_of(cap, "shutterEffect").unwrap_or_default() {
            "Open" => CapabilityTag::ShutterOpen,
            "Closed" => CapabilityTag::ShutterClosed,
            _ => CapabilityTag::Strobe,
        },
        "NoFunction" => CapabilityTag::NoFunction,
        "WheelSlot" => CapabilityTag::Slot,
        "WheelRotation" | "WheelSlotRotation" | "PrismRotation" | "Rotation" if has_speed => CapabilityTag::Rotation,
        "Effect" => CapabilityTag::Effect,
        "Maintenance" => CapabilityTag::Maintenance,
        _ => return None,
    })
}

/// 带起止物理量的属性，按优先级排列（同一能力只取第一个）。
const ENTITY_PROPS: &[&str] = &[
    "angle",
    "colorTemperature",
    "speed",
    "duration",
    "slotNumber",
    "brightness",
    "openPercent",
    "frostIntensity",
    "insertion",
    "distance",
    "horizontalAngle",
    "verticalAngle",
    "shakeAngle",
    "shakeSpeed",
    "fogOutput",
    "soundSensitivity",
    "time",
    "parameter",
];

/// 能力的物理量：`(起止值, 单位, 是否比例)`。
fn cap_physical(cap: &Obj) -> (Option<[f64; 2]>, String, bool) {
    for prop in ENTITY_PROPS {
        let start = cap.get(&format!("{prop}Start")).and_then(entity);
        let end = cap.get(&format!("{prop}End")).and_then(entity);
        if let (Some((a, ua)), Some((b, ub))) = (start, end)
            && ua == ub
        {
            return (Some([a, b]), ua, true);
        }
        if let Some((v, u)) = cap.get(*prop).and_then(entity) {
            return (Some([v, v]), u, false);
        }
    }
    (None, String::new(), false)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/// DMX 值的定义分辨率与目标位宽。
#[derive(Debug, Clone, Copy)]
struct Resolution {
    source: u32,
    target: u32,
}

impl Resolution {
    /// 定义分辨率下的满值。
    fn full(self) -> u64 {
        (1u64 << self.source) - 1
    }

    /// 定义分辨率 → 目标位宽；区间上界（`high`）升位时低位填满。
    fn convert(self, v: u64, high: bool) -> u16 {
        let v = if self.source >= self.target {
            v >> (self.source - self.target)
        } else {
            let shift = self.target - self.source;
            let scaled = v << shift;
            if high { scaled | ((1u64 << shift) - 1) } else { scaled }
        };
        u16::try_from(v).unwrap_or(u16::MAX)
    }
}

/// 通道定义的 DMX 值分辨率：`dmxValueResolution`，否则为 8 × (1 + 精细别名数)。
fn source_bits(def: &Obj) -> u32 {
    match str_of(def, "dmxValueResolution") {
        Some("8bit") => 8,
        Some("16bit") => 16,
        Some("24bit") => 24,
        _ => {
            let fine = def.get("fineChannelAliases").and_then(Value::as_array).map_or(0, Vec::len);
            (8 * (1 + fine as u32)).min(32)
        }
    }
}

/// 通道定义的能力对象（单个 `capability` 或 `capabilities` 数组）。
fn capabilities_of(def: &Obj) -> Vec<&Obj> {
    match (def.get("capability"), def.get("capabilities")) {
        (Some(Value::Object(c)), _) => vec![c],
        (_, Some(Value::Array(list))) => list.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    }
}

/// 能力及其 DMX 区间（定义分辨率）；单个 `capability` 覆盖整条通道。
fn ranged_capabilities(def: &Obj, full: u64) -> Vec<(&Obj, [u64; 2])> {
    if let Some(Value::Object(c)) = def.get("capability") {
        return vec![(c, range_of(c).unwrap_or([0, full]))];
    }
    capabilities_of(def).into_iter().filter_map(|c| range_of(c).map(|r| (c, r))).collect()
}

/// 按名称识别功能（OFL 通道名的兜底）；`Color`、`Speed` 这类含糊的名字不识别。
fn name_function(name: &str) -> Option<ChannelFunction> {
    let normalized: String =
        name.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase();
    if matches!(normalized.as_str(), "color" | "colour" | "speed") {
        return None;
    }
    if let Some(f) = Some(ChannelFunction::from_code(name)).filter(|f| *f != ChannelFunction::Other) {
        return Some(f);
    }
    // 常见的 OFL 通道名片段（整库统计里最常见的未识别通道）
    let has = |s: &str| normalized.contains(s);
    Some(if has("framing") || has("blade") {
        if has("rot") || has("swivel") { ChannelFunction::BladeRotate } else { ChannelFunction::Blade }
    } else if has("fog") || has("haze") {
        ChannelFunction::Fog
    } else if has("crossfade") || has("fadetime") {
        ChannelFunction::EffectSpeed
    } else if has("curve") || has("tuning") || has("outputtype") || has("lamp") {
        ChannelFunction::Maintenance
    } else if has("program") || has("macro") || has("modeselection") {
        ChannelFunction::Macro
    } else {
        return None;
    })
}

/// 用像素 / 像素组名替换 `$pixelKey`。
fn subst(s: &str, unit: Option<&str>) -> String {
    match unit {
        Some(u) => s.replace("$pixelKey", u),
        None => s.to_owned(),
    }
}

fn midpoint([lo, hi]: [u16; 2]) -> u16 {
    u32::midpoint(u32::from(lo), u32::from(hi)) as u16
}

/// 白光发光体的色温校准：取 `physical.bulb.colorTemperature`（只在模型有白光通道时生成）。
fn emitters_of<'p>(root: &Obj, layouts: impl Iterator<Item = &'p Vec<FixtureProperty>>) -> Vec<Emitter> {
    let kelvin = root
        .get("physical")
        .and_then(|p| p.get("bulb"))
        .and_then(|b| b.get("colorTemperature"))
        .and_then(Value::as_f64)
        .filter(|k| (1000.0..=20000.0).contains(k));
    let Some(kelvin) = kelvin else { return Vec::new() };
    let has_white = layouts.flatten().any(|p| p.function == ChannelFunction::White);
    if !has_white {
        return Vec::new();
    }
    vec![Emitter { function: ChannelFunction::White, rgb: None, kelvin: Some(kelvin.round() as u16), intensity: 1.0 }]
}

/// 镜头名的最大长度（字符数，与模型校验一致）。
const MAX_LENS_NAME: usize = 64;

fn physical_of(root: &Obj) -> Option<Physical> {
    let p = root.get("physical")?.as_object()?;
    let lens_obj = p.get("lens").and_then(Value::as_object);
    let lens = lens_obj.and_then(|l| l.get("degreesMinMax")).and_then(Value::as_array);
    let focus = p.get("focus").and_then(Value::as_object);
    let num = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|x| *x > 0.0 && x.is_finite());
    let dimensions = p.get("dimensions").and_then(Value::as_array).and_then(|d| {
        let [w, h, depth] = [num(d.first())?, num(d.get(1))?, num(d.get(2))?];
        Some([w, h, depth])
    });
    let lens_name = lens_obj
        .and_then(|l| str_of(l, "name"))
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(MAX_LENS_NAME).collect());
    let focus_type = focus.and_then(|f| str_of(f, "type")).and_then(|t| match t {
        "Head" => Some(FocusType::Head),
        "Mirror" => Some(FocusType::Mirror),
        "Barrel" => Some(FocusType::Barrel),
        "Fixed" => Some(FocusType::Fixed),
        _ => None,
    });
    let physical = Physical {
        pan_range_deg: num(focus.and_then(|f| f.get("panMax"))),
        tilt_range_deg: num(focus.and_then(|f| f.get("tiltMax"))),
        beam_min_deg: num(lens.and_then(|l| l.first())),
        beam_max_deg: num(lens.and_then(|l| l.get(1))),
        dimensions_mm: dimensions,
        weight_kg: num(p.get("weight")),
        power_w: num(p.get("power")),
        lens_name,
        focus_type,
    };
    (physical != Physical::default()).then_some(physical)
}

/// 按 OFL 分类、物理参数与通道推断外形模板（导入时的默认外观，来源记为规则）。
///
/// 分类优先；只有“变色 / 调光”这类不说明外形的分类时，再看像素排布、光束运动方式、镜头名与外形比例。
fn shape_of(categories: &[&str], physical: Option<&Physical>, matrix: Option<MatrixLayout>, props: &[FixtureProperty]) -> FixtureShape {
    let has = |c: &str| categories.contains(&c);
    let moves = props.iter().any(|p| matches!(p.function, ChannelFunction::Pan | ChannelFunction::Tilt));
    let focus = physical.and_then(|p| p.focus_type);
    if has("Moving Head") {
        return FixtureShape::MovingHead;
    }
    if has("Scanner") || has("Barrel Scanner") {
        return FixtureShape::Scanner;
    }
    if has("Laser") {
        return FixtureShape::Laser;
    }
    if has("Smoke") || has("Hazer") {
        return FixtureShape::Fogger;
    }
    if has("Blinder") {
        return FixtureShape::Blinder;
    }
    if has("Pixel Bar") {
        return FixtureShape::Bar;
    }
    if has("Matrix") {
        return FixtureShape::PixelPanel;
    }
    if has("Strobe") {
        return FixtureShape::Strobe;
    }
    match focus {
        Some(FocusType::Head) => return FixtureShape::MovingHead,
        Some(FocusType::Mirror | FocusType::Barrel) => return FixtureShape::Scanner,
        _ if moves => return FixtureShape::MovingHead,
        _ => {}
    }
    if let Some(m) = matrix {
        if m.rows == 1 && m.cols >= 4 {
            return FixtureShape::Bar;
        }
        if m.rows > 1 && m.cols > 1 {
            return FixtureShape::PixelPanel;
        }
    }
    let lens = physical.and_then(|p| p.lens_name.as_deref()).unwrap_or_default().to_ascii_lowercase();
    if lens.contains("profile") || lens.contains("ellips") {
        return FixtureShape::Profile;
    }
    if let Some([w, h, d]) = physical.and_then(|p| p.dimensions_mm) {
        // 宽度远大于高和深：灯条；宽高都远大于深：面板 / 泛光
        if w >= 3.0 * h.max(d) {
            return FixtureShape::Bar;
        }
        if w.min(h) >= 2.0 * d {
            return FixtureShape::Wash;
        }
    }
    if has("Color Changer") || has("Dimmer") {
        return FixtureShape::Par;
    }
    FixtureShape::Generic
}

fn str_of<'a>(obj: &'a Obj, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

fn range_of(cap: &Obj) -> Option<[u64; 2]> {
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

/// 物理量的关键字（等价的百分比，见 OFL capability-types.md 的实体表）。
fn keyword_percent(s: &str) -> Option<f64> {
    Some(match s.to_ascii_lowercase().as_str() {
        "fast reverse" | "fast ccw" | "warm" | "cto" | "left" | "top" => -100.0,
        "slow reverse" | "slow ccw" => -1.0,
        "stop" | "off" | "instant" | "default" | "center" | "closed" | "out" => 0.0,
        "slow" | "slow cw" | "short" | "near" | "dark" | "weak" | "narrow" | "low" | "small" => 1.0,
        "fast" | "fast cw" | "long" | "far" | "bright" | "cold" | "ctb" | "strong" | "wide" | "right" | "bottom"
        | "high" | "big" | "in" | "open" => 100.0,
        _ => return None,
    })
}

/// 解析带单位的物理量：数字（无单位，例如槽位号）、`530deg`、`10Hz`、`-50%`，或关键字（换成 `%`）。
fn entity(v: &Value) -> Option<(f64, String)> {
    if let Some(n) = v.as_f64() {
        return n.is_finite().then(|| (n, String::new()));
    }
    let s = v.as_str()?.trim();
    if let Some(p) = keyword_percent(s) {
        return Some((p, "%".to_owned()));
    }
    let split = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E'))
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

/// OFL 灯具标识（`制造商/灯具`）对应的模型编号。
///
/// # Arguments
///
/// * `key` - 灯具标识。
///
/// # Returns
///
/// `ofl:` + 规整后的标识（截断到 [`MAX_ID_LEN`]），与导入时生成的编号一致。
#[must_use]
pub fn ofl_model_id(key: &str) -> String {
    model_id(key, key)
}

/// 生成模型编号：`ofl:` + 规整后的标识，截断到 [`MAX_ID_LEN`]。
fn model_id(fallback_key: &str, name: &str) -> String {
    let key = if fallback_key.trim().is_empty() { slug(name) } else { slug(fallback_key) };
    format!("ofl:{key}").chars().take(MAX_ID_LEN).collect()
}

/// 小写、空白转 `-`，只保留字母数字与 `-_/.`。
fn slug(s: &str) -> String {
    s.trim()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c.to_ascii_lowercase() })
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'))
        .collect()
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

    fn find<'a>(props: &'a [FixtureProperty], code: &str) -> &'a FixtureProperty {
        props.iter().find(|p| p.code == code).unwrap_or_else(|| panic!("找不到 {code}"))
    }

    fn has_warning(r: &ImportReport, kind: ImportWarningKind, detail: &str) -> bool {
        r.warnings.iter().any(|w| w.kind == kind && w.detail.as_deref() == Some(detail))
    }

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
        let shutter = find(&m.properties, "Shutter");
        assert_eq!(shutter.function, ChannelFunction::Shutter);
        assert_eq!(shutter.default_value, 30);
        assert_eq!(shutter.capabilities.len(), 2);
        assert_eq!(shutter.capabilities[1].label, "开光");
        assert_eq!(shutter.capabilities[0].label, "Closed");
        assert_eq!(shutter.capabilities[1].tag, Some(CapabilityTag::ShutterOpen));
        let color = find(&m.properties, "Color");
        assert_eq!(color.function, ChannelFunction::ColorWheel);
        assert_eq!(color.capabilities[1].color, Some([255, 0, 0]));
        assert_eq!(color.capabilities[1].tag, Some(CapabilityTag::Slot));
        // 第 8 通道为空，Mystery 在第 9 通道
        assert_eq!(m.properties.last().map(|p| (p.channel, p.function)), Some((9, ChannelFunction::Other)));
        assert_eq!(m.channel_count(), 9);

        let physical = m.physical.as_ref().expect("物理参数");
        assert_eq!(physical.pan_range_deg, Some(540.0));
        assert_eq!(physical.beam_max_deg, Some(30.0));
        assert_eq!(m.validate(), Ok(()));
    }

    #[test]
    fn 单个能力生成整段比例区间_定义分辨率换算到位宽() {
        let report = import_ofl(SPOT, "test/spot").expect("应能导入");
        let m = &report.models[0];
        let pan = &m.properties[0].capabilities;
        assert_eq!(pan.len(), 1);
        assert_eq!(pan[0].range, [0, 65535]);
        assert_eq!((pan[0].physical, pan[0].unit.as_str(), pan[0].proportional), (Some([0.0, 540.0]), "deg", true));
        let basic = &m.modes[0];
        assert_eq!(basic.id, "6ch");
        assert_eq!(basic.name, "Basic");
        // 基本模式只用粗调：Tilt 默认值 50% 按 16 位定义换算到 8 位
        let tilt = &basic.properties[1];
        assert_eq!((tilt.width, tilt.default_value), (1, 128));
        assert_eq!(tilt.capabilities[0].range, [0, 255]);
    }

    #[test]
    fn 不紧跟粗调的精细通道独立导入并告警() {
        let report = import_ofl(SPOT, "t/s").expect("应能导入");
        let basic = &report.models[0].modes[0];
        let last = basic.properties.last().expect("最后一个通道");
        assert_eq!((last.code.as_str(), last.channel), ("Tilt fine", 6));
        assert!(has_warning(&report, ImportWarningKind::FineChannelSeparate, "Tilt fine"));
        assert!(has_warning(&report, ImportWarningKind::UnknownFunction, "Mystery"));
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
             "templateChannels": ["Red $pixelKey", "Green $pixelKey", "Blue $pixelKey"]}]},
            {"name": "per channel", "shortName": "pc", "channels": [
            {"insert": "matrixChannels", "repeatFor": ["4", "1"], "channelOrder": "perChannel",
             "templateChannels": ["Red $pixelKey", "Green $pixelKey"]}]}]
        }"#;
        let report = import_ofl(bar, "x/bar").expect("应能导入");
        let m = &report.models[0];
        assert_eq!(m.matrix, Some(MatrixLayout { cols: 4, rows: 1 }));
        assert_eq!(m.channel_count(), 13);
        let blue4 = m.properties.last().expect("最后一个通道");
        assert_eq!((blue4.code.as_str(), blue4.head, blue4.function), ("Blue 4", 4, ChannelFunction::Blue));
        assert_eq!(m.properties[1].head, 1);
        let pc: Vec<(&str, u16)> = m.modes[0].properties.iter().map(|p| (p.code.as_str(), p.head)).collect();
        assert_eq!(pc, vec![("Red 4", 4), ("Red 1", 1), ("Green 4", 4), ("Green 1", 1)]);
        assert_eq!(m.validate(), Ok(()));
    }

    #[test]
    fn 不支持的插入块跳过整个模式而不是让通道错位() {
        let j = r#"{"name":"x","availableChannels":{"D":{"capability":{"type":"Intensity"}},"R":{"capability":{"type":"ColorIntensity","color":"Red"}}},
          "modes":[{"name":"bad","channels":["D",{"insert":"somethingNew"},"R"]},{"name":"ok","channels":["D","R"]}]}"#;
        let r = import_ofl(j, "x/y").expect("应能导入");
        let m = &r.models[0];
        assert_eq!(m.default_mode_name, "ok");
        assert_eq!(m.properties[1].channel, 2);
        assert!(has_warning(&r, ImportWarningKind::ModeSkipped, "insert:somethingNew"));
    }

    #[test]
    fn 切换通道按依赖通道默认值解析() {
        let j = r#"{"name":"Par","availableChannels":{
            "Programs":{"defaultValue":0,"capabilities":[
              {"dmxRange":[0,10],"type":"NoFunction","switchChannels":{"Speed / Mic":"Program Speed"}},
              {"dmxRange":[11,255],"type":"Effect","effectName":"Auto","switchChannels":{"Speed / Mic":"Mic Sensitivity"}}]},
            "Program Speed":{"capability":{"type":"EffectSpeed","speedStart":"slow","speedEnd":"fast"}},
            "Mic Sensitivity":{"capability":{"type":"SoundSensitivity","soundSensitivityStart":"0%","soundSensitivityEnd":"100%"}}},
          "modes":[{"name":"2ch","channels":["Programs","Speed / Mic"]}]}"#;
        let r = import_ofl(j, "f/par").expect("应能导入");
        let p = &r.models[0].properties[1];
        assert_eq!((p.code.as_str(), p.channel, p.function), ("Program Speed", 2, ChannelFunction::EffectSpeed));
        assert!(p.description.contains("Mic Sensitivity"), "{}", p.description);
        assert_eq!(p.capabilities[0].physical, Some([1.0, 100.0]));
        assert!(!r.warnings.iter().any(|w| w.kind == ImportWarningKind::UnknownChannel));
    }

    #[test]
    fn 模板精细通道合并_24位第二级精细通道保留并告警() {
        let j = r#"{"name":"Bar","matrix":{"pixelCount":[2,1,1]},
          "availableChannels":{"Dim":{"fineChannelAliases":["Dim fine","Dim fine^2"],"capability":{"type":"Intensity"}}},
          "templateChannels":{"Red $pixelKey":{"fineChannelAliases":["Red $pixelKey fine"],"capability":{"type":"ColorIntensity","color":"Red"}}},
          "modes":[{"name":"m","channels":["Dim","Dim fine","Dim fine^2","Red 1","Red 1 fine","Red 2","Red 2 fine"]}]}"#;
        let r = import_ofl(j, "x/bar").expect("应能导入");
        let props = &r.models[0].properties;
        let summary: Vec<(u16, u8, u16, ChannelFunction)> = props.iter().map(|p| (p.channel, p.width, p.head, p.function)).collect();
        assert_eq!(
            summary,
            vec![
                (1, 2, 0, ChannelFunction::Dimmer),
                (3, 1, 0, ChannelFunction::Other),
                (4, 2, 1, ChannelFunction::Red),
                (6, 2, 2, ChannelFunction::Red)
            ]
        );
        assert!(has_warning(&r, ImportWarningKind::FineChannelTruncated, "Dim fine^2"));
    }

    #[test]
    fn 重复的唯一功能降级而不是拒收整台灯() {
        let j = r#"{"name":"x","availableChannels":{
            "Dimmer":{"capability":{"type":"Intensity"}},
            "Strobe Dimmer":{"capability":{"type":"Intensity"}}},
          "modes":[{"name":"m","channels":["Dimmer","Strobe Dimmer"]}]}"#;
        let r = import_ofl(j, "x/y").expect("应能导入");
        let props = &r.models[0].properties;
        assert_eq!(props[0].function, ChannelFunction::Dimmer);
        assert_eq!(props[1].function, ChannelFunction::Other);
        assert!(has_warning(&r, ImportWarningKind::DuplicateFunctionDemoted, "Strobe Dimmer"));
    }

    #[test]
    fn 物理参数与外形模板() {
        let j = r#"{"name":"Spot","categories":["Moving Head"],
          "physical":{"dimensions":[300,450,250],"weight":12.5,"power":250,
            "lens":{"name":"PC","degreesMinMax":[12,30]},"focus":{"type":"Head","panMax":540,"tiltMax":270}},
          "availableChannels":{"Pan":{"capability":{"type":"Pan","angleStart":"0deg","angleEnd":"540deg"}}},
          "modes":[{"name":"1ch","channels":["Pan"]}]}"#;
        let m = &import_ofl(j, "acme/spot").expect("应能导入").models[0];
        let p = m.physical.as_ref().expect("有物理参数");
        assert_eq!(p.dimensions_mm, Some([300.0, 450.0, 250.0]));
        assert_eq!((p.weight_kg, p.power_w), (Some(12.5), Some(250.0)));
        assert_eq!(p.lens_name.as_deref(), Some("PC"));
        assert_eq!(p.focus_type, Some(FocusType::Head));
        let a = m.appearance.as_ref().expect("有外观");
        assert_eq!((a.shape, a.origin), (FixtureShape::MovingHead, AppearanceOrigin::Rule));
        assert_eq!(m.source.as_ref().map(|s| s.recognizer), Some(OFL_RECOGNIZER_VERSION));

        // 尺寸缺一维时不导入尺寸；分类不说明外形时按像素排布判断
        let j = r#"{"name":"Bar","categories":["Color Changer"],"matrix":{"pixelCount":[8,1,1]},
          "physical":{"dimensions":[1000,80]},
          "templateChannels":{"Red $pixelKey":{"capability":{"type":"ColorIntensity","color":"Red"}}},
          "modes":[{"name":"8ch","channels":[{"insert":"matrixChannels","repeatFor":"eachPixelXYZ","channelOrder":"perPixel","templateChannels":["Red $pixelKey"]}]}]}"#;
        let m = &import_ofl(j, "acme/bar").expect("应能导入").models[0];
        assert!(m.physical.is_none());
        assert_eq!(m.appearance.as_ref().map(|a| a.shape), Some(FixtureShape::Bar));
        assert_eq!(shape_of(&["Color Changer"], None, None, &[]), FixtureShape::Par);
        assert_eq!(shape_of(&["Smoke"], None, None, &[]), FixtureShape::Fogger);
        assert_eq!(shape_of(&[], None, None, &[]), FixtureShape::Generic);
    }

    #[test]
    fn 色轮槽位按名字查色_分色片保留第二种颜色() {
        let j = r##"{"name":"x",
          "wheels":{"Color Wheel":{"slots":[{"type":"Open"},{"type":"Color","name":"Congo Blue"},
            {"type":"Color","colors":["#ff0000","#0000ff"]},{"type":"Color","name":"Mystery"}]}},
          "availableChannels":{"Color Wheel":{"capabilities":[
            {"dmxRange":[0,63],"type":"WheelSlot","slotNumber":1},
            {"dmxRange":[64,127],"type":"WheelSlot","slotNumber":2},
            {"dmxRange":[128,191],"type":"WheelSlot","slotNumber":3},
            {"dmxRange":[192,255],"type":"WheelSlot","slotNumber":4}]}},
          "modes":[{"name":"1ch","channels":["Color Wheel"]}]}"##;
        let m = &import_ofl(j, "x/y").expect("应能导入").models[0];
        let caps = &m.properties[0].capabilities;
        assert_eq!(caps[0].color, None);
        assert_eq!(caps[1].color, lookup_color_name("Congo Blue"));
        assert_eq!((caps[2].color, caps[2].color_alt), (Some([255, 0, 0]), Some([0, 0, 255])));
        assert_eq!(caps[3].color, None);
    }

    #[test]
    fn 省略轮子名时取通道名_按槽位类型判断轮子类别() {
        let j = r##"{"name":"x",
          "wheels":{"Wheel 1":{"slots":[{"type":"Open"},{"type":"Color","colors":["#00ff00"]},{"type":"Color","colors":["#0000ff"]}]},
                    "Wheel 2":{"slots":[{"type":"Open"},{"type":"Gobo","name":"Dots"}]}},
          "availableChannels":{
            "Wheel 1":{"capabilities":[
              {"dmxRange":[0,99],"type":"WheelSlot","slotNumber":1},
              {"dmxRange":[100,199],"type":"WheelSlot","slotNumber":2},
              {"dmxRange":[200,255],"type":"WheelRotation","speedStart":"slow CW","speedEnd":"fast CW"}]},
            "Wheel 2":{"capabilities":[{"dmxRange":[0,127],"type":"WheelSlot","slotNumber":1},{"dmxRange":[128,255],"type":"WheelSlot","slotNumber":2}]},
            "Gobo Spin":{"capability":{"type":"WheelSlotRotation","wheel":"Wheel 2","speedStart":"slow CW","speedEnd":"fast CW"}},
            "Strobe":{"capabilities":[{"dmxRange":[0,9],"type":"NoFunction"},{"dmxRange":[10,249],"type":"ShutterStrobe","shutterEffect":"Strobe","speedStart":"1Hz","speedEnd":"20Hz"},{"dmxRange":[250,255],"type":"ShutterStrobe","shutterEffect":"Open"}]}},
          "modes":[{"name":"m","channels":["Wheel 1","Wheel 2","Gobo Spin","Strobe"]}]}"##;
        let r = import_ofl(j, "x/y").expect("应能导入");
        let p = &r.models[0].properties;
        assert_eq!(p[0].function, ChannelFunction::ColorWheel);
        assert_eq!(p[0].capabilities[1].color, Some([0, 255, 0]));
        assert_eq!(p[0].capabilities[2].tag, Some(CapabilityTag::Rotation));
        assert_eq!(p[1].function, ChannelFunction::Gobo);
        assert_eq!(p[1].capabilities[1].label, "Dots");
        assert_eq!(p[2].function, ChannelFunction::GoboRotate);
        // 无功能区间不计票：频闪通道是快门；没有默认值时取开光区间中点
        assert_eq!(p[3].function, ChannelFunction::Shutter);
        assert_eq!(p[3].default_value, 252);
        assert_eq!(p[3].capabilities[1].physical, Some([1.0, 20.0]));
        assert_eq!(p[3].capabilities[1].unit, "Hz");
    }

    #[test]
    fn 像素组按出现顺序编号_覆盖全部的组视为整灯() {
        let j = r#"{"name":"Flare","matrix":{"pixelCount":[4,2,1],"pixelGroups":{
            "Z-All":"all","Left":{"x":["<=2"]},"Right":{"x":[">=3"]},"Odd":{"x":["odd"]},"Named":{"name":["^\\(1, "]}}},
          "templateChannels":{"Red $pixelKey":{"capability":{"type":"ColorIntensity","color":"Red"}}},
          "modes":[
            {"name":"groups","channels":["Red Z-All",{"insert":"matrixChannels","repeatFor":"eachPixelGroup","channelOrder":"perPixel","templateChannels":["Red $pixelKey"]}]},
            {"name":"pixels","channels":[{"insert":"matrixChannels","repeatFor":"eachPixelYXZ","channelOrder":"perPixel","templateChannels":["Red $pixelKey"]}]}]}"#;
        let r = import_ofl(j, "t/f").expect("应能导入");
        let m = &r.models[0];
        let groups: Vec<(&str, u16)> = m.properties.iter().map(|p| (p.code.as_str(), p.head)).collect();
        // JSON 顺序：Z-All、Left、Right、Odd、Named；Z-All 覆盖全部 → 整灯；重复的 Red Z-All 降级
        assert_eq!(
            groups,
            vec![("Red Z-All", 0), ("Red Z-All", 0), ("Red Left", 1), ("Red Right", 2), ("Red Odd", 3), ("Red Named", 4)]
        );
        assert!(r.warnings.iter().any(|w| w.kind == ImportWarningKind::PixelGroupsAsHeads));
        // YXZ：Y 变化最快
        let order: Vec<&str> = m.modes[0].properties.iter().map(|p| p.code.as_str()).collect();
        assert_eq!(order[..3], ["Red (1, 1)", "Red (1, 2)", "Red (2, 1)"]);
        assert_eq!(m.modes[0].properties[1].head, 5);
        assert_eq!(m.matrix, Some(MatrixLayout { cols: 4, rows: 2 }));
    }

    #[test]
    fn 带空洞的像素键保留网格位置() {
        let j = r#"{"name":"Plus","matrix":{"pixelKeys":[[[null,"Top",null],["Left","Center","Right"],[null,"Bottom",null]]]},
          "templateChannels":{"Dim $pixelKey":{"capability":{"type":"Intensity"}}},
          "modes":[{"name":"m","channels":[{"insert":"matrixChannels","repeatFor":"eachPixelABC","channelOrder":"perPixel","templateChannels":["Dim $pixelKey"]}]}]}"#;
        let r = import_ofl(j, "t/p").expect("应能导入");
        let m = &r.models[0];
        assert_eq!(m.matrix, Some(MatrixLayout { cols: 3, rows: 3 }));
        let heads: Vec<(&str, u16)> = m.properties.iter().map(|p| (p.code.as_str(), p.head)).collect();
        assert_eq!(heads, vec![("Dim Bottom", 8), ("Dim Center", 5), ("Dim Left", 4), ("Dim Right", 6), ("Dim Top", 2)]);
    }

    #[test]
    fn 重定向文件与非法输入() {
        let redirect = r#"{"$schema":"x","name":"M-Carré","redirectTo":"minuit-une/ivl-carre","reason":"FixtureRenamed"}"#;
        assert_eq!(import_ofl(redirect, "minuit-une/m-carre"), Err(ImportError::Redirect("minuit-une/ivl-carre".into())));
        assert!(matches!(import_ofl("[1,2]", "x"), Err(ImportError::Open(_))));
        assert!(matches!(import_ofl("{nope", "x"), Err(ImportError::Open(_))));
        assert!(matches!(import_ofl(r#"{"name":"x","modes":[]}"#, "x"), Err(ImportError::NoModels)));
    }

    #[test]
    fn 物理量与工具函数() {
        assert_eq!(entity(&Value::from("530deg")), Some((530.0, "deg".into())));
        assert_eq!(entity(&Value::from("-50%")), Some((-50.0, "%".into())));
        assert_eq!(entity(&Value::from("fast CCW")), Some((-100.0, "%".into())));
        assert_eq!(entity(&Value::from(3)), Some((3.0, String::new())));
        assert_eq!(entity(&Value::from("whatever")), None);
        assert_eq!(hex_color("#00ff80"), Some([0, 255, 128]));
        assert_eq!(dmx_value(&Value::from("100%"), 8), Some(255));
        assert_eq!(natural_cmp("2", "10"), Ordering::Less);
        assert_eq!(natural_cmp("Pixel 10", "pixel 9"), Ordering::Greater);
        assert_eq!(axis_constraint(7, "3n+1"), Some(true));
        assert_eq!(axis_constraint(6, "3n"), Some(true));
        assert_eq!(axis_constraint(4, "odd"), Some(false));
        assert_eq!(axis_constraint(4, "nope"), None);
        assert_eq!(name_function("Color"), None);
        assert_eq!(name_function("Dimmer"), Some(ChannelFunction::Dimmer));
    }
}
