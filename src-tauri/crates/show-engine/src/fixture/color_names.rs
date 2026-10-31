//! 颜色名字典：OFL 色轮槽位只写了名字（例如 `Congo Blue`、`LEE 106`）而没有十六进制色时，按名字查出近似色。
//!
//! 取值是常见滤色片与颜色名的**近似显示色**（sRGB），只用于预览和按颜色选槽位，
//! 不代表滤色片的真实光谱。查找规则见 [`lookup_color_name`]。

/// 颜色名（已规整：小写、只保留字母数字）→ 近似色。
const NAMES: &[(&str, [u8; 3])] = &[
    // 基本颜色
    ("white", [255, 255, 255]),
    ("red", [255, 0, 0]),
    ("deepred", [200, 0, 20]),
    ("darkred", [170, 0, 20]),
    ("lightred", [255, 80, 80]),
    ("green", [0, 255, 0]),
    ("darkgreen", [0, 140, 40]),
    ("lightgreen", [130, 255, 130]),
    ("deepgreen", [0, 160, 60]),
    ("blue", [0, 0, 255]),
    ("darkblue", [0, 0, 170]),
    ("deepblue", [20, 0, 200]),
    ("lightblue", [120, 180, 255]),
    ("paleblue", [180, 210, 255]),
    ("skyblue", [100, 190, 255]),
    ("royalblue", [40, 80, 230]),
    ("navyblue", [0, 20, 130]),
    ("yellow", [255, 230, 0]),
    ("lightyellow", [255, 245, 150]),
    ("paleyellow", [255, 245, 180]),
    ("deepyellow", [255, 200, 0]),
    ("orange", [255, 120, 0]),
    ("lightorange", [255, 170, 80]),
    ("deeporange", [255, 85, 0]),
    ("darkorange", [240, 90, 0]),
    ("amber", [255, 170, 0]),
    ("deepamber", [255, 130, 0]),
    ("magenta", [255, 0, 255]),
    ("darkmagenta", [170, 0, 170]),
    ("pink", [255, 120, 200]),
    ("lightpink", [255, 180, 220]),
    ("deeppink", [255, 40, 140]),
    ("hotpink", [255, 60, 170]),
    ("rose", [255, 70, 120]),
    ("purple", [140, 0, 255]),
    ("deeppurple", [100, 0, 200]),
    ("lightpurple", [190, 130, 255]),
    ("violet", [150, 60, 255]),
    ("lavender", [190, 150, 255]),
    ("lilac", [200, 160, 255]),
    ("mauve", [210, 100, 180]),
    ("cyan", [0, 255, 255]),
    ("lightcyan", [150, 255, 255]),
    ("turquoise", [0, 220, 200]),
    ("teal", [0, 160, 150]),
    ("aqua", [0, 230, 255]),
    ("lime", [180, 255, 0]),
    ("limegreen", [150, 255, 40]),
    ("indigo", [75, 0, 255]),
    ("uv", [100, 0, 255]),
    ("blacklight", [100, 0, 255]),
    ("ultraviolet", [100, 0, 255]),
    ("gold", [255, 200, 40]),
    ("straw", [255, 230, 160]),
    ("salmon", [255, 140, 110]),
    ("coral", [255, 110, 80]),
    ("peach", [255, 190, 150]),
    ("apricot", [255, 175, 110]),
    ("warmwhite", [255, 214, 170]),
    ("coldwhite", [235, 242, 255]),
    ("coolwhite", [235, 242, 255]),
    // 色温校正
    ("cto", [255, 180, 110]),
    ("fullcto", [255, 180, 110]),
    ("halfcto", [255, 210, 160]),
    ("quartercto", [255, 230, 200]),
    ("ctb", [160, 200, 255]),
    ("fullctb", [160, 200, 255]),
    ("halfctb", [200, 222, 255]),
    ("quarterctb", [222, 236, 255]),
    ("3200k", [255, 190, 130]),
    ("5600k", [255, 240, 230]),
    ("6500k", [255, 249, 253]),
    // 常见滤色片名
    ("congoblue", [40, 0, 150]),
    ("primaryred", [230, 0, 20]),
    ("primarygreen", [0, 190, 70]),
    ("primaryblue", [0, 60, 220]),
    ("flamered", [240, 30, 0]),
    ("brightred", [255, 20, 20]),
    ("brightpink", [255, 60, 150]),
    ("surprisepink", [220, 150, 255]),
    ("moroccanpink", [255, 150, 160]),
    ("mediumblue", [0, 90, 230]),
    ("mediumbluegreen", [0, 180, 160]),
    ("peacockblue", [0, 170, 200]),
    ("steelblue", [110, 160, 210]),
    ("specialsteelblue", [110, 160, 210]),
    ("tokyoblue", [40, 0, 180]),
    ("deeplavender", [140, 90, 255]),
    ("mossgreen", [100, 200, 60]),
    ("jadegreen", [0, 200, 120]),
    ("emeraldgreen", [0, 200, 100]),
    ("forestgreen", [30, 140, 60]),
    ("chocolate", [210, 130, 80]),
    ("bastardamber", [255, 190, 140]),
    ("redorange", [255, 70, 0]),
];

/// LEE 滤色片编号 → 近似色。
const LEE: &[(u16, [u8; 3])] = &[
    (101, [255, 230, 0]),
    (102, [255, 210, 60]),
    (104, [255, 170, 0]),
    (105, [255, 120, 0]),
    (106, [230, 0, 20]),
    (111, [255, 140, 170]),
    (113, [255, 0, 130]),
    (115, [0, 170, 160]),
    (116, [0, 160, 150]),
    (117, [150, 230, 230]),
    (118, [0, 170, 230]),
    (119, [0, 30, 200]),
    (120, [0, 20, 170]),
    (121, [150, 255, 60]),
    (124, [0, 170, 70]),
    (126, [200, 0, 170]),
    (128, [255, 60, 150]),
    (132, [0, 90, 230]),
    (135, [255, 100, 0]),
    (136, [220, 150, 230]),
    (139, [0, 190, 70]),
    (141, [0, 170, 230]),
    (147, [255, 175, 110]),
    (158, [255, 85, 0]),
    (164, [240, 30, 0]),
    (179, [255, 180, 0]),
    (180, [140, 60, 230]),
    (181, [40, 0, 150]),
    (182, [255, 0, 0]),
    (195, [0, 60, 230]),
    (200, [60, 120, 255]),
    (201, [160, 200, 255]),
    (202, [200, 222, 255]),
    (203, [222, 236, 255]),
    (204, [255, 180, 110]),
    (205, [255, 210, 160]),
    (206, [255, 230, 200]),
];

/// 规整颜色名：小写、只保留字母数字。
fn normalize(s: &str) -> String {
    s.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

/// 按 LEE 编号查找：`LEE 106`、`L106`、`Lee106 Primary Red` 等。
fn lee_code(norm: &str) -> Option<[u8; 3]> {
    let rest = norm.strip_prefix("lee").or_else(|| norm.strip_prefix('l'))?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.len() != 3 {
        return None;
    }
    let code: u16 = digits.parse().ok()?;
    LEE.iter().find(|(c, _)| *c == code).map(|(_, rgb)| *rgb)
}

/// 按名字查近似色。
///
/// 依次尝试：规整后的完整名字；LEE 编号；去掉开头的滤色片编号（例如 `Rosco 80 Primary Blue` → `primaryblue`）。
///
/// # Arguments
///
/// * `name` - 槽位名或能力注释，例如 `Congo Blue`、`LEE 106`。
///
/// # Returns
///
/// 找到时为近似显示色（sRGB），否则为 `None`。
#[must_use]
pub fn lookup_color_name(name: &str) -> Option<[u8; 3]> {
    let norm = normalize(name);
    if norm.is_empty() {
        return None;
    }
    let exact = |n: &str| NAMES.iter().find(|(k, _)| *k == n).map(|(_, rgb)| *rgb);
    if let Some(rgb) = exact(&norm) {
        return Some(rgb);
    }
    if let Some(rgb) = lee_code(&norm) {
        return Some(rgb);
    }
    // 去掉品牌和编号前缀后再查
    let stripped = ["lee", "rosco", "roscolux", "gam", "r", "l"]
        .iter()
        .filter_map(|p| norm.strip_prefix(p))
        .chain(std::iter::once(norm.as_str()))
        .map(|s| s.trim_start_matches(|c: char| c.is_ascii_digit()))
        .find(|s| s.len() < norm.len() && !s.is_empty() && exact(s).is_some())?;
    exact(stripped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 按名字与编号查色() {
        assert_eq!(lookup_color_name("Congo Blue"), Some([40, 0, 150]));
        assert_eq!(lookup_color_name("light-blue"), lookup_color_name("Light Blue"));
        assert_eq!(lookup_color_name("LEE 106"), Some([230, 0, 20]));
        assert_eq!(lookup_color_name("L201"), Some([160, 200, 255]));
        assert_eq!(lookup_color_name("Rosco 80 Primary Blue"), Some([0, 60, 220]));
        assert_eq!(lookup_color_name("CTO"), Some([255, 180, 110]));
    }

    #[test]
    fn 查不到的名字返回空() {
        assert_eq!(lookup_color_name(""), None);
        assert_eq!(lookup_color_name("Dots"), None);
        assert_eq!(lookup_color_name("Rainbow effect"), None);
        assert_eq!(lookup_color_name("LEE 999"), None);
    }
}
