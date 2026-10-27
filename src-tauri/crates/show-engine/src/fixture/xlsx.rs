//! 物模型 Excel（`DMX物模型表.xlsx`）导入。
//!
//! 表格结构（见 `doc/DMX物模型表.xlsx`）：每个模型占若干行，每行一个属性。
//! 某一行的 B 列为 `product_code` 时，这一行是“代码行”，它的各列单元格给出列的含义：
//!
//! | 列代码 | 含义 |
//! |---|---|
//! | `product_code` | 模型编号 |
//! | `product_name` | 模型名称 |
//! | `system` / `product_type` | 系统 / 产品类型 |
//! | `property_name` | 属性名，形如 `红光_Red`（中文名 + 下划线 + 英文代码） |
//! | `channel` / `channel_num` | 起始通道 / 占通道数 |
//! | `endian` | 多通道属性字节序，`1` 大端，`0` 小端 |
//! | `data` / `description` | DMX 数值说明 / 字段描述 |
//!
//! 代码行之后的行是数据行；没有代码行的工作表（“概念说明”等）被忽略。
//! 标准物模型里同一模型的各属性起始通道都写成 `1`，导入时按行顺序依次排布，并给出警告。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use calamine::{open_workbook_auto, Reader};
use super::import::{ImportError, ImportReport, ImportWarning, ImportWarningKind};
use super::model::{
    find_overlap, reassign_sequential, ChannelFunction, FixtureModel, FixtureProperty,
};

/// 单个数据行解析出的属性，连同其所属模型的信息。
struct Row {
    /// 表格行号（从 1 开始）。
    number: usize,
    id: String,
    name: String,
    system: String,
    product_type: String,
    property: FixtureProperty,
}

/// 读取 Excel 工作簿并解析其中的物模型。
///
/// # Arguments
///
/// * `path` - `.xlsx` 文件路径。
///
/// # Returns
///
/// 解析出的模型与警告。
///
/// # Errors
///
/// - 文件无法打开或不是合法工作簿时返回 [`ImportError::Open`]。
/// - 所有工作表里都没有可用模型时返回 [`ImportError::NoModels`]。
pub fn import_xlsx(path: &Path) -> Result<ImportReport, ImportError> {
    let mut workbook =
        open_workbook_auto(path).map_err(|e| ImportError::Open(e.to_string()))?;
    let mut report = ImportReport::default();
    let mut seen = HashSet::new();
    for name in workbook.sheet_names() {
        let Ok(range) = workbook.worksheet_range(&name) else {
            continue;
        };
        let rows: Vec<Vec<String>> = range
            .rows()
            .map(|r| r.iter().map(ToString::to_string).collect())
            .collect();
        // 工作表的 `rows()` 从已使用区域的第一行开始，需要换算回表格里的真实行号
        let first_row = range.start().map_or(0, |(r, _)| r as usize);
        parse_sheet(&name, first_row, &rows, &mut seen, &mut report);
    }
    if report.models.is_empty() {
        return Err(ImportError::NoModels);
    }
    Ok(report)
}

/// 解析一个工作表的单元格文本，把结果追加到 `report`。
///
/// # Arguments
///
/// * `sheet` - 工作表名（写入警告）。
/// * `first_row` - `rows[0]` 在表格中的行号（从 0 开始）。
/// * `rows` - 工作表的单元格文本，外层为行，内层为列。
/// * `seen` - 已经出现过的模型编号，用于跨工作表去重。
/// * `report` - 解析结果的累加器。
pub fn parse_sheet(
    sheet: &str,
    first_row: usize,
    rows: &[Vec<String>],
    seen: &mut HashSet<String>,
    report: &mut ImportReport,
) {
    let Some(code_row) = rows
        .iter()
        .position(|r| r.iter().any(|c| c.trim().eq_ignore_ascii_case("product_code")))
    else {
        return;
    };
    let columns = column_map(&rows[code_row]);
    let (Some(&c_id), Some(&c_name), Some(&c_prop), Some(&c_ch), Some(&c_num)) = (
        columns.get("product_code"),
        columns.get("product_name"),
        columns.get("property_name"),
        columns.get("channel"),
        columns.get("channel_num"),
    ) else {
        return;
    };
    let cell = |row: &[String], col: usize| row.get(col).map_or("", |s| s.trim()).to_owned();
    let optional = |row: &[String], key: &str| {
        columns.get(key).map(|&c| cell(row, c)).unwrap_or_default()
    };

    // 按首次出现的顺序归组
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Row>> = HashMap::new();
    for (i, row) in rows.iter().enumerate().skip(code_row + 1) {
        let number = first_row + i + 1;
        let id = cell(row, c_id);
        if id.is_empty() {
            continue;
        }
        let warn = |kind| ImportWarning {
            kind,
            sheet: sheet.to_owned(),
            row: Some(number),
            model_id: Some(id.clone()),
            detail: None,
        };
        let raw_name = cell(row, c_prop);
        let channel = parse_u16(&cell(row, c_ch));
        let width = parse_u16(&cell(row, c_num));
        let (Some(channel), Some(width)) = (channel, width) else {
            report.warnings.push(warn(ImportWarningKind::InvalidRow));
            continue;
        };
        if raw_name.is_empty() || !(1..=2).contains(&width) {
            report.warnings.push(warn(ImportWarningKind::InvalidRow));
            continue;
        }
        let (name, code) = split_property_name(&raw_name);
        let function = ChannelFunction::from_code(&code);
        if function == ChannelFunction::Other {
            report.warnings.push(ImportWarning {
                detail: Some(code.clone()),
                ..warn(ImportWarningKind::UnknownFunction)
            });
        }
        let width = width as u8;
        let property = FixtureProperty {
            name,
            code,
            function,
            channel,
            width,
            // 表格约定：1 为大端，0 为小端
            big_endian: optional(row, "endian") == "1",
            default_value: function.default_value(width),
            value_desc: optional(row, "data"),
            description: optional(row, "description"),
            ..FixtureProperty::default()
        };
        if !groups.contains_key(&id) {
            order.push(id.clone());
        }
        groups.entry(id.clone()).or_default().push(Row {
            number,
            id: id.clone(),
            name: cell(row, c_name),
            system: optional(row, "system"),
            product_type: optional(row, "product_type"),
            property,
        });
    }

    finish_models(sheet, order, groups, seen, report);
}

/// 把按编号归好组的数据行组装成模型：去重、必要时重排通道、校验。
///
/// # Arguments
///
/// * `sheet` - 工作表名（写入警告）。
/// * `order` - 模型编号，按首次出现的顺序。
/// * `groups` - 每个编号对应的数据行。
/// * `seen` - 已经出现过的模型编号，用于跨工作表去重。
/// * `report` - 解析结果的累加器。
fn finish_models(
    sheet: &str,
    order: Vec<String>,
    mut groups: HashMap<String, Vec<Row>>,
    seen: &mut HashSet<String>,
    report: &mut ImportReport,
) {
    for id in order {
        let rows = groups.remove(&id).unwrap_or_default();
        let Some(first) = rows.first() else { continue };
        let first_number = first.number;
        if !seen.insert(id.clone()) {
            report.warnings.push(ImportWarning {
                kind: ImportWarningKind::DuplicateModel,
                sheet: sheet.to_owned(),
                row: Some(first_number),
                model_id: Some(id),
                detail: None,
            });
            continue;
        }
        let mut model = FixtureModel {
            id: first.id.clone(),
            name: first.name.clone(),
            system: first.system.clone(),
            product_type: first.product_type.clone(),
            builtin: false,
            properties: rows.into_iter().map(|r| r.property).collect(),
            ..FixtureModel::default()
        };
        if find_overlap(&model.properties).is_some() {
            reassign_sequential(&mut model.properties);
            report.warnings.push(ImportWarning {
                kind: ImportWarningKind::ChannelsReassigned,
                sheet: sheet.to_owned(),
                row: Some(first_number),
                model_id: Some(model.id.clone()),
                detail: None,
            });
        }
        match model.validate() {
            Ok(()) => report.models.push(model),
            Err(e) => report.warnings.push(ImportWarning {
                kind: ImportWarningKind::InvalidModel,
                sheet: sheet.to_owned(),
                row: Some(first_number),
                model_id: Some(model.id),
                detail: Some(e.code().to_owned()),
            }),
        }
    }
}

/// 由代码行建立“列代码 → 列下标”的映射（列代码统一转小写）。
///
/// # Arguments
///
/// * `code_row` - 含 `product_code` 的那一行。
///
/// # Returns
///
/// 列代码到列下标的映射；同名列取第一次出现的位置。
fn column_map(code_row: &[String]) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    for (i, cell) in code_row.iter().enumerate() {
        let key = cell.trim().to_ascii_lowercase();
        if !key.is_empty() {
            map.entry(key).or_insert(i);
        }
    }
    map
}

/// 把属性名 `红光_Red` 拆成（中文名，英文代码）。
///
/// # Arguments
///
/// * `raw` - 表格里的属性名。
///
/// # Returns
///
/// 第一个下划线前后的两段（各自去除首尾空白）；没有下划线时两段都是原文。
fn split_property_name(raw: &str) -> (String, String) {
    match raw.split_once('_') {
        Some((zh, code)) => (zh.trim().to_owned(), code.trim().to_owned()),
        None => (raw.trim().to_owned(), raw.trim().to_owned()),
    }
}

/// 把单元格文本解析成非负整数（允许 `1.0` 这样的整数浮点写法）。
///
/// # Arguments
///
/// * `text` - 单元格文本。
///
/// # Returns
///
/// 解析出的值；不是 `0..=65535` 的整数时为 `None`。
fn parse_u16(text: &str) -> Option<u16> {
    let v: f64 = text.trim().parse().ok()?;
    if v.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(&v) {
        Some(v as u16)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(data: &[&[&str]]) -> Vec<Vec<String>> {
        data.iter()
            .map(|r| r.iter().map(|c| (*c).to_owned()).collect())
            .collect()
    }

    const CODE_ROW: &[&str] = &[
        "", "product_code", "product_name", "system", "product_type", "interface",
        "property_name", "channel", "channel_num", "endian", "data", "description",
    ];

    fn parse(data: &[&[&str]]) -> ImportReport {
        let mut report = ImportReport::default();
        parse_sheet("测试", 0, &rows(data), &mut HashSet::new(), &mut report);
        report
    }

    #[test]
    fn 属性名拆成中文名与英文代码() {
        assert_eq!(split_property_name("红光_Red"), ("红光".into(), "Red".into()));
        assert_eq!(
            split_property_name("频闪 / 切光_Shutter/Strobe"),
            ("频闪 / 切光".into(), "Shutter/Strobe".into())
        );
        assert_eq!(split_property_name("调光 _Dimmer"), ("调光".into(), "Dimmer".into()));
        assert_eq!(split_property_name("Pan"), ("Pan".into(), "Pan".into()));
    }

    #[test]
    fn 数字单元格按整数解析() {
        assert_eq!(parse_u16("3"), Some(3));
        assert_eq!(parse_u16(" 2.0 "), Some(2));
        assert_eq!(parse_u16("2.5"), None);
        assert_eq!(parse_u16("-1"), None);
        assert_eq!(parse_u16("abc"), None);
        assert_eq!(parse_u16("70000"), None);
    }

    #[test]
    fn 没有代码行的工作表被忽略() {
        let report = parse(&[&["序号", "项目", "说明"], &["1", "物模型", "设备的模版"]]);
        assert!(report.models.is_empty());
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn 通道都写成1的模型按行顺序排布并警告() {
        let report = parse(&[
            CODE_ROW,
            &["1", "1.4.1.4", "RGB全彩灯", "照明", "全彩", "", "红光_Red", "1", "1", "0", "0~255:红光值", ""],
            &["1", "1.4.1.4", "RGB全彩灯", "照明", "全彩", "", "绿光_Green", "1", "1", "0", "", ""],
            &["1", "1.4.1.4", "RGB全彩灯", "照明", "全彩", "", "蓝光_Blue", "1", "1", "0", "", ""],
        ]);
        assert_eq!(report.models.len(), 1);
        let channels: Vec<u16> = report.models[0].properties.iter().map(|p| p.channel).collect();
        assert_eq!(channels, vec![1, 2, 3]);
        assert_eq!(report.warnings.len(), 1);
        assert_eq!(report.warnings[0].kind, ImportWarningKind::ChannelsReassigned);
        assert_eq!(report.warnings[0].model_id.as_deref(), Some("1.4.1.4"));
    }

    #[test]
    fn 自定义通道顺序被保留() {
        let report = parse(&[
            CODE_ROW,
            &["2", "2.2.1.4", "RGBW全彩灯1", "照明", "全彩", "", "红光_Red", "2", "1", "0", "", ""],
            &["2", "2.2.1.4", "RGBW全彩灯1", "照明", "全彩", "", "绿光_Green", "1", "1", "0", "", ""],
            &["2", "2.2.1.4", "RGBW全彩灯1", "照明", "全彩", "", "蓝光_Blue", "4", "1", "0", "", ""],
            &["2", "2.2.1.4", "RGBW全彩灯1", "照明", "全彩", "", "白光_White", "3", "1", "0", "", ""],
        ]);
        assert!(report.warnings.is_empty());
        let by_code: HashMap<&str, u16> = report.models[0]
            .properties
            .iter()
            .map(|p| (p.code.as_str(), p.channel))
            .collect();
        assert_eq!(by_code["Green"], 1);
        assert_eq!(by_code["Red"], 2);
        assert_eq!(by_code["White"], 3);
        assert_eq!(by_code["Blue"], 4);
    }

    #[test]
    fn 十六位属性与字节序() {
        let report = parse(&[
            CODE_ROW,
            &["1", "2.1.2.1", "摇头灯", "电动照明", "摇头灯", "", "水平_Pan ", "1", "2", "1", "0~65535:水平旋转", ""],
            &["1", "2.1.2.1", "摇头灯", "电动照明", "摇头灯", "", "调光 _Dimmer", "3", "1", "0", "", ""],
        ]);
        let pan = &report.models[0].properties[0];
        assert_eq!((pan.channel, pan.width, pan.big_endian), (1, 2, true));
        assert_eq!(pan.function, ChannelFunction::Pan);
        assert_eq!(pan.default_value, 32768);
        assert_eq!(report.models[0].properties[1].function, ChannelFunction::Dimmer);
    }

    #[test]
    fn 非法行被跳过_未知功能给出警告() {
        let report = parse(&[
            CODE_ROW,
            &["1", "9.9.9.9", "怪灯", "", "", "", "神秘_Mystery", "1", "1", "0", "", ""],
            &["1", "9.9.9.9", "怪灯", "", "", "", "坏行_Bad", "abc", "1", "0", "", ""],
            &["1", "9.9.9.9", "怪灯", "", "", "", "宽度_Wide", "2", "3", "0", "", ""],
        ]);
        assert_eq!(report.models.len(), 1);
        assert_eq!(report.models[0].properties.len(), 1);
        let kinds: Vec<ImportWarningKind> = report.warnings.iter().map(|w| w.kind).collect();
        assert_eq!(
            kinds,
            vec![
                ImportWarningKind::UnknownFunction,
                ImportWarningKind::InvalidRow,
                ImportWarningKind::InvalidRow
            ]
        );
        // 行号是表格里的真实行号（代码行在第 1 行，数据行从第 2 行开始）
        assert_eq!(report.warnings[1].row, Some(3));
    }

    #[test]
    fn 同一编号的重复功能使整个模型被拒绝() {
        let report = parse(&[
            CODE_ROW,
            &["1", "1.1.1.1", "开关灯", "照明", "开关", "", "开关_Swtch", "1", "1", "0", "", ""],
            &["2", "1.1.1.1", "开关灯副本", "照明", "开关", "", "开关_Swtch", "1", "1", "0", "", ""],
        ]);
        // 同一编号的两行属于同一模型，会触发重复属性（开关功能重复）而被整体拒绝
        assert!(report.models.is_empty());
        assert_eq!(report.warnings.last().map(|w| w.kind), Some(ImportWarningKind::InvalidModel));
    }

    #[test]
    fn 跨工作表的重复编号被忽略() {
        let sheet = rows(&[
            CODE_ROW,
            &["1", "1.1.1.1", "开关灯", "照明", "开关", "", "开关_Swtch", "1", "1", "0", "", ""],
        ]);
        let mut seen = HashSet::new();
        let mut report = ImportReport::default();
        parse_sheet("甲", 0, &sheet, &mut seen, &mut report);
        parse_sheet("乙", 0, &sheet, &mut seen, &mut report);
        assert_eq!(report.models.len(), 1);
        assert_eq!(report.warnings.len(), 1);
        assert_eq!(report.warnings[0].kind, ImportWarningKind::DuplicateModel);
        assert_eq!(report.warnings[0].sheet, "乙");
    }

    #[test]
    fn 缺少必需列时整个工作表被忽略() {
        let report = parse(&[&["", "product_code", "product_name"], &["1", "1.1.1.1", "x"]]);
        assert!(report.models.is_empty());
    }

    /// 真实的需求文档表格：6 个标准模型 + 2 个自定义模型全部解析成功。
    #[test]
    fn 导入真实物模型表() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../doc/DMX物模型表.xlsx");
        let report = import_xlsx(&path).expect("需求文档里的物模型表应当可以导入");
        let ids: Vec<&str> = report.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["1.1.1.1", "1.2.1.2", "1.3.1.3", "1.4.1.4", "1.5.1.4", "1.6.1.5", "2.1.2.1", "2.2.1.4"]
        );
        let count = |id: &str| {
            report.models.iter().find(|m| m.id == id).map(FixtureModel::channel_count)
        };
        assert_eq!(count("1.6.1.5"), Some(5));
        // 通用 16CH 摇头灯：Pan/Tilt 各占 2 个通道，共 16 个通道
        assert_eq!(count("2.1.2.1"), Some(16));
        assert_eq!(count("2.2.1.4"), Some(4));
        // 标准模型的通道在表格里都写成 1，导入时按顺序重新排布
        let reassigned: Vec<&str> = report
            .warnings
            .iter()
            .filter(|w| w.kind == ImportWarningKind::ChannelsReassigned)
            .filter_map(|w| w.model_id.as_deref())
            .collect();
        assert_eq!(reassigned, vec!["1.3.1.3", "1.4.1.4", "1.5.1.4", "1.6.1.5"]);
        // 摇头灯的频闪通道默认“常亮开光”
        let head = report.models.iter().find(|m| m.id == "2.1.2.1").expect("摇头灯");
        let shutter = head.properties.iter().find(|p| p.function == ChannelFunction::Shutter);
        assert_eq!(shutter.map(|p| p.default_value), Some(105));
    }
}
