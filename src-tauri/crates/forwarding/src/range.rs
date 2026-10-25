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

/// 范围记法里无法解析的片段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeError {
    /// 出错的原始片段（已去掉首尾空白）。
    pub fragment: String,
}

impl std::fmt::Display for RangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "无法解析的范围片段 `{}`", self.fragment)
    }
}

impl std::error::Error for RangeError {}

/// 严格解析范围记法：与 [`parse_range`] 规则相同，但遇到非法片段时报错而不是跳过。
///
/// 用于需要把输入错误告诉用户的场合（如信号检测器的 Universe 范围）。
/// 空片段（如 `1,,2` 或末尾逗号）仍被忽略；`a-b` 中 `a > b` 时自动交换。
///
/// # Arguments
///
/// * `text` - 形如 `0-20,30-40,50` 的字符串（空白被忽略）。
///
/// # Returns
///
/// 去重并升序排列的 Universe 列表；整串为空时返回空列表。
///
/// # Errors
///
/// 任一片段不是 `u16` 整数或 `a-b` 区间（包括负数、小数、超过 65535）时，
/// 返回携带该片段的 [`RangeError`]。
pub fn try_parse_range(text: &str) -> Result<Vec<u16>, RangeError> {
    let mut set = std::collections::BTreeSet::new();
    for part in text.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let bad = || RangeError {
            fragment: part.to_string(),
        };
        if let Some((a, b)) = part.split_once('-') {
            let lo = a.trim().parse::<u16>().map_err(|_| bad())?;
            let hi = b.trim().parse::<u16>().map_err(|_| bad())?;
            let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
            set.extend(lo..=hi);
        } else {
            set.insert(part.parse::<u16>().map_err(|_| bad())?);
        }
    }
    Ok(set.into_iter().collect())
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
