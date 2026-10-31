//! `SKILL.md` 的 YAML 前言（frontmatter）解析：只支持 Agent Skills 规范用到的子集——
//! 顶层 `key: value`、`metadata:` 下缩进一层的 `key: value`，值可带单 / 双引号。

use std::collections::BTreeMap;

use crate::error::SkillError;

/// 名称最长字符数（Agent Skills 规范）。
pub const MAX_NAME_CHARS: usize = 64;
/// 描述最长字符数（Agent Skills 规范）。
pub const MAX_DESCRIPTION_CHARS: usize = 1024;

/// 解析出的前言。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Frontmatter {
    /// 技能名（小写字母、数字与连字符）。
    pub name: String,
    /// 描述：做什么、什么时候用。
    pub description: String,
    /// `metadata` 下的键值。
    pub metadata: BTreeMap<String, String>,
    /// 其它顶层键（`license`、`compatibility`、`allowed-tools`…）。
    pub extra: BTreeMap<String, String>,
}

/// 校验技能名：1~64 个字符，只有小写字母、数字与连字符，不以连字符开头或结尾，没有连续的连字符。
///
/// # Arguments
///
/// * `name` - 技能名。
///
/// # Returns
///
/// 合法时为 `true`。
pub fn valid_name(name: &str) -> bool {
    let n = name.chars().count();
    (1..=MAX_NAME_CHARS).contains(&n)
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
}

/// 去掉值两端的引号。
fn unquote(v: &str) -> String {
    let v = v.trim();
    let bytes = v.as_bytes();
    if v.len() >= 2 && ((bytes[0] == b'"' && bytes[v.len() - 1] == b'"') || (bytes[0] == b'\'' && bytes[v.len() - 1] == b'\'')) {
        v[1..v.len() - 1].to_owned()
    } else {
        v.to_owned()
    }
}

/// 拆出前言与正文。
///
/// # Arguments
///
/// * `text` - `SKILL.md` 全文。
///
/// # Returns
///
/// `(前言文本, 正文)`。
///
/// # Errors
///
/// 没有以 `---` 开头、或没有结束的 `---` 时返回 [`SkillError::Invalid`]。
pub fn split(text: &str) -> Result<(&str, &str), SkillError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| SkillError::Invalid("SKILL.md must start with a '---' frontmatter block".into()))?;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Ok((&rest[..offset], &rest[offset + line.len()..]));
        }
        offset += line.len();
    }
    Err(SkillError::Invalid("the frontmatter block is not closed with '---'".into()))
}

/// 解析并校验前言。
///
/// # Arguments
///
/// * `text` - `SKILL.md` 全文。
///
/// # Returns
///
/// 前言与正文。
///
/// # Errors
///
/// 格式不对、缺少 `name` / `description`、名称不合规或描述过长时返回 [`SkillError::Invalid`]。
pub fn parse(text: &str) -> Result<(Frontmatter, String), SkillError> {
    let (head, body) = split(text)?;
    let mut fm = Frontmatter::default();
    let mut in_metadata = false;
    for raw in head.lines() {
        if raw.trim().is_empty() || raw.trim_start().starts_with('#') {
            continue;
        }
        let indented = raw.starts_with(' ') || raw.starts_with('\t');
        let Some((key, value)) = raw.trim().split_once(':') else {
            return Err(SkillError::Invalid(format!("cannot read frontmatter line: {}", raw.trim())));
        };
        let key = key.trim().to_owned();
        let value = unquote(value);
        if indented && in_metadata {
            fm.metadata.insert(key, value);
            continue;
        }
        in_metadata = key == "metadata" && value.is_empty();
        match key.as_str() {
            "name" => fm.name = value,
            "description" => fm.description = value,
            "metadata" => {}
            _ => {
                fm.extra.insert(key, value);
            }
        }
    }
    if !valid_name(&fm.name) {
        return Err(SkillError::Invalid(format!("invalid skill name '{}': use 1-64 lowercase letters, digits and single hyphens", fm.name)));
    }
    let len = fm.description.chars().count();
    if len == 0 || len > MAX_DESCRIPTION_CHARS {
        return Err(SkillError::Invalid("description must be 1-1024 characters".into()));
    }
    Ok((fm, body.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析名称_描述与元数据() {
        let text = "---\nname: beat-flash\ndescription: \"Flash on every beat: use for EDM\"\nlicense: MIT\nmetadata:\n  triggers: beat, 节拍\n  title: 'Beat flash'\n---\n# Body\nText\n";
        let (fm, body) = parse(text).unwrap();
        assert_eq!(fm.name, "beat-flash");
        assert_eq!(fm.description, "Flash on every beat: use for EDM");
        assert_eq!(fm.metadata.get("triggers").map(String::as_str), Some("beat, 节拍"));
        assert_eq!(fm.metadata.get("title").map(String::as_str), Some("Beat flash"));
        assert_eq!(fm.extra.get("license").map(String::as_str), Some("MIT"));
        assert_eq!(body, "# Body\nText\n");
    }

    #[test]
    fn crlf_与_bom() {
        let text = "\u{feff}---\r\nname: a\r\ndescription: d\r\n---\r\nbody";
        let (fm, body) = parse(text).unwrap();
        assert_eq!((fm.name.as_str(), fm.description.as_str(), body.as_str()), ("a", "d", "body"));
    }

    #[test]
    fn 不合规的被拒绝() {
        assert!(parse("name: a\n").is_err(), "没有前言");
        assert!(parse("---\nname: a\ndescription: d\n").is_err(), "没有结束");
        assert!(parse("---\nname: Bad_Name\ndescription: d\n---\n").is_err());
        assert!(parse("---\nname: a\n---\n").is_err(), "缺少描述");
        assert!(parse(&format!("---\nname: a\ndescription: {}\n---\n", "x".repeat(1025))).is_err());
        assert!(!valid_name("-a"));
        assert!(!valid_name("a--b"));
        assert!(!valid_name(&"a".repeat(65)));
        assert!(valid_name("pdf-2"));
    }
}
