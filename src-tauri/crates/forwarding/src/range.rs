//! Universe 范围记法解析（如 `0-20,30-40,50`）。

/// 解析范围记法为去重升序的 Universe 列表。
///
/// # Arguments
///
/// * `text` - 形如 `0-20,30-40,50` 的字符串（空白被忽略）。
///
/// # Returns
///
/// 去重并升序排列的 Universe 列表；非法片段被跳过。
#[must_use]
pub fn parse_range(text: &str) -> Vec<u16> {
    let mut set = std::collections::BTreeSet::new();
    for part in text.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((a, b)) = part.split_once('-') {
            if let (Ok(lo), Ok(hi)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
                for u in lo..=hi {
                    set.insert(u);
                }
            }
        } else if let Ok(v) = part.parse::<u16>() {
            set.insert(v);
        }
    }
    set.into_iter().collect()
}

/// 将 Universe 列表格式化为紧凑范围记法。
///
/// # Arguments
///
/// * `universes` - 任意顺序的 Universe 列表。
///
/// # Returns
///
/// 形如 `0-20,30-40,50` 的紧凑字符串。
#[must_use]
pub fn format_range(universes: &[u16]) -> String {
    let mut v: Vec<u16> = universes.to_vec();
    v.sort_unstable();
    v.dedup();
    let mut parts = Vec::new();
    let mut i = 0;
    while i < v.len() {
        let start = v[i];
        let mut end = start;
        while i + 1 < v.len() && v[i + 1] == end + 1 {
            end = v[i + 1];
            i += 1;
        }
        if start == end {
            parts.push(start.to_string());
        } else {
            parts.push(format!("{start}-{end}"));
        }
        i += 1;
    }
    parts.join(",")
}
