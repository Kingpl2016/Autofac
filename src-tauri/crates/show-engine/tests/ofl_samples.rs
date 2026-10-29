//! OFL 真实样本回归测试：逐个导入 `tests/fixtures/ofl/` 下的官方灯具，检查识别结果。
//!
//! 用 `cargo test -p show-engine --test ofl_samples -- --nocapture` 可以看到每台灯的识别表。

use std::fmt::Write as _;
use std::path::PathBuf;

use show_engine::fixture::{
    import_ofl, CapabilityTag, ChannelFunction, FixtureModel, FixtureProperty, ImportReport, ImportWarningKind,
};

/// 样本目录。
fn sample_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ofl")
}

/// 导入一个样本（`制造商/灯具`）。
fn import(key: &str) -> Result<ImportReport, String> {
    let path = sample_dir().join(format!("{key}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读取样本 {key} 失败：{e}"));
    import_ofl(&text, key).map_err(|e| e.to_string())
}

/// 导入并要求成功。
fn model(key: &str) -> (FixtureModel, ImportReport) {
    let report = import(key).unwrap_or_else(|e| panic!("样本 {key} 应能导入：{e}"));
    (report.models[0].clone(), report)
}

/// 识别表：每个模式一段，每个通道一行。
fn report_table(m: &FixtureModel) -> String {
    let mut s = String::new();
    let mut section = |name: &str, props: &[FixtureProperty]| {
        let _ = writeln!(s, "  [{name}] {} 通道", show_engine::fixture::footprint(props));
        for p in props {
            let _ = writeln!(
                s,
                "    {:>3} w{} h{:<3} {:<16} caps={:<3} {}",
                p.channel,
                p.width,
                p.head,
                format!("{:?}", p.function),
                p.capabilities.len(),
                p.code
            );
        }
    };
    section(if m.default_mode_name.is_empty() { "默认" } else { &m.default_mode_name }, &m.properties);
    for mode in &m.modes {
        section(&mode.name, &mode.properties);
    }
    s
}

/// 某模式里按通道键找通道。
fn find<'a>(props: &'a [FixtureProperty], code: &str) -> &'a FixtureProperty {
    props
        .iter()
        .find(|p| p.code == code)
        .unwrap_or_else(|| panic!("找不到通道 {code}"))
}

const SAMPLES: &[&str] = &[
    "cameo/hydrabeam-300-rgbw",
    "futurelight/pro-slim-par-7-hcl",
    "eurolite/led-kls-801",
    "tmb/solaris-flare",
    "generic/desk-channel",
    "robe/robin-600e-spot",
    "martin/mac-aura",
    "clay-paky/sharpy",
];

#[test]
fn 打印识别报告() {
    for key in SAMPLES {
        match import(key) {
            Ok(r) => {
                let m = &r.models[0];
                println!("== {key} → {} ({}), 模式 {}，警告 {}", m.id, m.name, 1 + m.modes.len(), r.warnings.len());
                print!("{}", report_table(m));
                for w in &r.warnings {
                    println!("  ! {:?} {} {:?}", w.kind, w.sheet, w.detail);
                }
            }
            Err(e) => println!("== {key} 导入失败：{e}"),
        }
    }
}

#[test]
fn 全部样本都能导入且通过校验() {
    for key in SAMPLES {
        let (m, _) = model(key);
        assert_eq!(m.validate(), Ok(()), "{key}");
        assert_eq!(m.system, "OFL");
    }
}

/// 断言某模式里的通道功能。
fn assert_functions(props: &[FixtureProperty], expect: &[(&str, ChannelFunction)]) {
    for (code, f) in expect {
        assert_eq!(find(props, code).function, *f, "通道 {code}");
    }
}

fn has_kind(r: &ImportReport, kind: ImportWarningKind) -> bool {
    r.warnings.iter().any(|w| w.kind == kind)
}

#[test]
fn 光束摇头灯_色轮图案轮与快门() {
    use ChannelFunction as F;
    let (m, r) = model("clay-paky/sharpy");
    assert_functions(
        &m.properties,
        &[
            ("Color Wheel", F::ColorWheel),
            ("Shutter / Strobe", F::Shutter),
            ("Dimmer", F::Dimmer),
            ("Gobo Wheel", F::Gobo),
            ("Prism Insertion", F::Prism),
            ("Prism Rotation", F::PrismRotate),
            ("Pan", F::Pan),
            ("Tilt", F::Tilt),
        ],
    );
    let pan = find(&m.properties, "Pan");
    assert_eq!(pan.width, 2, "Pan 与 Pan fine 合并为 16 位");
    // dmxValueResolution 8bit：默认值 128 换算到 16 位
    assert_eq!(pan.default_value, 128 << 8);
    let color = find(&m.properties, "Color Wheel");
    assert!(color.capabilities.iter().any(|c| c.color.is_some()), "色轮槽位应带颜色");
    assert!(!has_kind(&r, ImportWarningKind::UnknownChannel));
}

#[test]
fn cmy_摇头灯_省略轮子名时按通道名找轮子() {
    use ChannelFunction as F;
    let (m, r) = model("robe/robin-600e-spot");
    assert_functions(
        &m.properties,
        &[
            ("Color Wheel", F::ColorWheel),
            ("Cyan", F::Cyan),
            ("Magenta", F::Magenta),
            ("Yellow", F::Yellow),
            ("CTO Filter", F::ColorTemp),
            ("Static Gobo Wheel", F::Gobo),
            ("Rotating Gobo Wheel", F::Gobo),
            ("Rotating Gobo Indexing", F::GoboRotate),
            ("Prism", F::Prism),
            ("Prism Rotation", F::PrismRotate),
            ("Frost", F::Frost),
            ("Iris", F::Iris),
            ("Zoom", F::Zoom),
            ("Focus", F::Focus),
            ("Shutter", F::Shutter),
            ("Dimmer", F::Dimmer),
        ],
    );
    let shutter = find(&m.properties, "Shutter");
    let open = shutter.capability_at(shutter.default_value).and_then(|c| c.tag);
    assert_eq!(open, Some(CapabilityTag::ShutterOpen), "快门默认值应落在开光区间");
    assert!(!has_kind(&r, ImportWarningKind::UnknownChannel));
    assert!(!has_kind(&r, ImportWarningKind::UnknownFunction));
}

#[test]
fn 模板通道与模板切换通道() {
    let (m, r) = model("cameo/hydrabeam-300-rgbw");
    let full = m.modes.iter().find(|x| x.name == "42-channel").expect("42 通道模式");
    let speed = full.properties.iter().find(|p| p.channel == 10).expect("第 10 通道");
    assert_eq!(speed.code, "Show mode speed 1");
    assert_eq!(speed.function, ChannelFunction::EffectSpeed);
    assert!(speed.description.contains("Sound sensitivity 1"), "{}", speed.description);
    // pixelKeys 带空洞：三个头按网格位置编号
    let heads: Vec<u16> = full.properties.iter().filter(|p| p.function == ChannelFunction::Pan).map(|p| p.head).collect();
    assert_eq!(heads, vec![2, 4, 6]);
    assert!(!has_kind(&r, ImportWarningKind::UnknownChannel));
}

#[test]
fn 官方切换通道示例() {
    let (m, r) = model("futurelight/pro-slim-par-7-hcl");
    let mode = m.modes.iter().find(|x| x.name == "12-channel").expect("12 通道模式");
    let p = mode.properties.iter().find(|p| p.channel == 11).expect("第 11 通道");
    assert_eq!((p.code.as_str(), p.function), ("Program Speed", ChannelFunction::EffectSpeed));
    assert!(p.description.contains("Mic Sensitivity"), "{}", p.description);
    assert!(!has_kind(&r, ImportWarningKind::UnknownChannel));
}

#[test]
fn 矩阵灯切换到模板通道() {
    let (m, r) = model("eurolite/led-kls-801");
    let red1 = find(&m.properties, "Red 1");
    assert_eq!((red1.channel, red1.function), (4, ChannelFunction::Red));
    assert!(red1.head > 0);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    assert_eq!(m.validate(), Ok(()));
}

#[test]
fn 像素组模式按组编号() {
    let (m, _) = model("tmb/solaris-flare");
    let mode = m.modes.iter().find(|x| x.name == "Advanced RGB Strobe 12-Pixel").expect("12 像素模式");
    let heads: std::collections::BTreeSet<u16> = mode.properties.iter().map(|p| p.head).filter(|h| *h > 0).collect();
    assert_eq!(heads, (1..=12).collect());
    assert_eq!(m.matrix.map(|l| (l.cols, l.rows)), Some((16, 6)));
}

#[test]
fn 二十四位精细通道与重定向文件() {
    let (m, r) = model("generic/desk-channel");
    let mode = m.modes.iter().find(|x| x.name == "24 bit").expect("24 位模式");
    assert_eq!(mode.properties[0].width, 2);
    assert!(has_kind(&r, ImportWarningKind::FineChannelTruncated));
    assert_eq!(import("minuit-une/m-carre").err(), Some("这是一个重定向文件，指向 minuit-une/ivl-carre".to_owned()));
}

#[test]
fn 双光源摇头灯_重复功能降级() {
    let (m, r) = model("martin/mac-aura");
    let ext = m.modes.iter().find(|x| x.name == "Extended").expect("扩展模式");
    assert_eq!(find(&ext.properties, "Beam dimmer").function, ChannelFunction::Dimmer);
    assert_eq!(find(&ext.properties, "Aura dimmer").function, ChannelFunction::Other);
    assert!(has_kind(&r, ImportWarningKind::DuplicateFunctionDemoted));
}
