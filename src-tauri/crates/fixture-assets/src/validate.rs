//! 资源文件的内容校验：文件头魔数、大小上限、SVG 里的危险内容。
//!
//! 扩展名不可信，一律按内容判断格式是否与声明一致。

use show_engine::fixture::AssetFormat;

use crate::AssetError;

/// SVG 图标的大小上限（字节）。
pub const MAX_SVG_BYTES: usize = 1024 * 1024;
/// PNG / WebP 图标的大小上限（字节）。
pub const MAX_RASTER_BYTES: usize = 4 * 1024 * 1024;
/// GLB 模型的大小上限（字节）。
pub const MAX_GLB_BYTES: usize = 16 * 1024 * 1024;
/// 3D 缩略图（WebP）的大小上限（字节）。
pub const MAX_THUMB_BYTES: usize = 512 * 1024;

/// 格式对应的大小上限。
///
/// # Arguments
///
/// * `format` - 资源格式。
///
/// # Returns
///
/// 上限（字节）。
#[must_use]
pub fn max_bytes(format: AssetFormat) -> usize {
    match format {
        AssetFormat::Svg => MAX_SVG_BYTES,
        AssetFormat::Png | AssetFormat::Webp => MAX_RASTER_BYTES,
        AssetFormat::Glb => MAX_GLB_BYTES,
    }
}

/// PNG 文件头。
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// 是否是 WebP（`RIFF....WEBP`）。
fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

/// 是否是 glTF 2.0 二进制：`glTF` 魔数、版本 2、头里的总长度与实际长度一致。
fn is_glb(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[0..4] != b"glTF" {
        return false;
    }
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    u32_at(4) == 2 && u32_at(8) as usize == bytes.len()
}

/// SVG 里不允许出现的内容（小写比较）：脚本、嵌入 HTML、实体声明、`javascript:` 链接、外部网络引用。
const SVG_FORBIDDEN: &[&str] = &[
    "<script",
    "<foreignobject",
    "<!entity",
    "javascript:",
    "href=\"http",
    "href='http",
    "href=\"//",
    "href='//",
    "url(http",
    "url(//",
    "@import",
];

/// 是否带事件属性（`onload=`、`onclick =` 等）：属性名以 `on` 开头、前面是空白、后面跟字母与 `=`。
fn has_event_attribute(lower: &str) -> bool {
    let b = lower.as_bytes();
    let mut i = 0;
    while i + 2 < b.len() {
        if b[i].is_ascii_whitespace() && b[i + 1] == b'o' && b[i + 2] == b'n' {
            let mut j = i + 3;
            while j < b.len() && b[j].is_ascii_alphabetic() {
                j += 1;
            }
            let name_len = j - (i + 3);
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if name_len > 0 && j < b.len() && b[j] == b'=' {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// 校验 SVG：UTF-8 文本、含 `<svg` 根元素、没有危险内容。
fn check_svg(bytes: &[u8]) -> Result<(), AssetError> {
    let text = std::str::from_utf8(bytes).map_err(|_| AssetError::BadFormat)?;
    let lower = text.to_ascii_lowercase();
    if !lower.contains("<svg") {
        return Err(AssetError::BadFormat);
    }
    if SVG_FORBIDDEN.iter().any(|p| lower.contains(p)) || has_event_attribute(&lower) {
        return Err(AssetError::UnsafeSvg);
    }
    Ok(())
}

/// 校验资源内容与声明的格式一致且不超过大小上限。
///
/// # Arguments
///
/// * `bytes` - 文件内容。
/// * `format` - 声明的格式。
///
/// # Errors
///
/// - 为空或超过上限时返回 [`AssetError::TooLarge`] / [`AssetError::BadFormat`]。
/// - 文件头与格式不符时返回 [`AssetError::BadFormat`]。
/// - SVG 含脚本、事件属性、外部引用等时返回 [`AssetError::UnsafeSvg`]。
pub fn check_content(bytes: &[u8], format: AssetFormat) -> Result<(), AssetError> {
    check_content_within(bytes, format, max_bytes(format))
}

/// 场馆 GLB 的大小上限（字节）：整个场馆的模型比单台灯具大。
pub const MAX_VENUE_BYTES: usize = 64 * 1024 * 1024;

/// 同 [`check_content`]，但用指定的大小上限。
///
/// # Arguments
///
/// * `bytes` - 文件内容。
/// * `format` - 声明的格式。
/// * `max` - 大小上限（字节）。
///
/// # Errors
///
/// 同 [`check_content`]。
pub fn check_content_within(bytes: &[u8], format: AssetFormat, max: usize) -> Result<(), AssetError> {
    if bytes.is_empty() {
        return Err(AssetError::BadFormat);
    }
    if bytes.len() > max {
        return Err(AssetError::TooLarge);
    }
    let ok = match format {
        AssetFormat::Svg => return check_svg(bytes),
        AssetFormat::Png => bytes.starts_with(PNG_MAGIC),
        AssetFormat::Webp => is_webp(bytes),
        AssetFormat::Glb => is_glb(bytes),
    };
    if ok { Ok(()) } else { Err(AssetError::BadFormat) }
}

/// 校验 3D 缩略图：WebP、不超过 [`MAX_THUMB_BYTES`]。
///
/// # Arguments
///
/// * `bytes` - 文件内容。
///
/// # Errors
///
/// 超限时返回 [`AssetError::TooLarge`]，不是 WebP 时返回 [`AssetError::BadFormat`]。
pub fn check_thumb(bytes: &[u8]) -> Result<(), AssetError> {
    if bytes.len() > MAX_THUMB_BYTES {
        return Err(AssetError::TooLarge);
    }
    if is_webp(bytes) { Ok(()) } else { Err(AssetError::BadFormat) }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 最小的合法 GLB（只有 12 字节头）。
    pub fn tiny_glb() -> Vec<u8> {
        let mut v = b"glTF".to_vec();
        v.extend_from_slice(&2u32.to_le_bytes());
        v.extend_from_slice(&12u32.to_le_bytes());
        v
    }

    /// 最小的 WebP 头。
    pub fn tiny_webp() -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&4u32.to_le_bytes());
        v.extend_from_slice(b"WEBPVP8 ");
        v
    }

    #[test]
    fn 按内容判断格式() {
        assert!(check_content(&tiny_glb(), AssetFormat::Glb).is_ok());
        let mut bad_len = tiny_glb();
        bad_len.push(0);
        assert_eq!(check_content(&bad_len, AssetFormat::Glb), Err(AssetError::BadFormat));
        assert!(check_content(&tiny_webp(), AssetFormat::Webp).is_ok());
        assert!(check_content(b"\x89PNG\r\n\x1a\nxxxx", AssetFormat::Png).is_ok());
        // 扩展名说是 PNG，内容其实是 GLB
        assert_eq!(check_content(&tiny_glb(), AssetFormat::Png), Err(AssetError::BadFormat));
        assert_eq!(check_content(b"", AssetFormat::Png), Err(AssetError::BadFormat));
        assert_eq!(check_content(&vec![0; MAX_SVG_BYTES + 1], AssetFormat::Svg), Err(AssetError::TooLarge));
        assert!(check_thumb(&tiny_webp()).is_ok());
        assert_eq!(check_thumb(b"\x89PNG\r\n\x1a\n"), Err(AssetError::BadFormat));
    }

    #[test]
    fn svg_拒绝脚本_事件属性与外部引用() {
        let ok = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#fff" /></svg>"##;
        assert!(check_content(ok, AssetFormat::Svg).is_ok());
        for bad in [
            "<svg><script>alert(1)</script></svg>",
            r#"<svg onload="x()"></svg>"#,
            r#"<svg><rect ONCLICK = "x()"/></svg>"#,
            r#"<svg><image href="https://evil.example/a.png"/></svg>"#,
            r#"<svg><a href="javascript:x()">a</a></svg>"#,
            r#"<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>"#,
            "<svg><foreignObject><div/></foreignObject></svg>",
        ] {
            assert_eq!(check_content(bad.as_bytes(), AssetFormat::Svg), Err(AssetError::UnsafeSvg), "{bad}");
        }
        // 属性名只是以 on 开头的字母（如 `opacity`）不误判；不是 SVG 的文本拒绝
        assert!(check_content(br#"<svg opacity="1" font="one"></svg>"#, AssetFormat::Svg).is_ok());
        assert_eq!(check_content(b"hello", AssetFormat::Svg), Err(AssetError::BadFormat));
        assert_eq!(check_content(&[0xff, 0xfe], AssetFormat::Svg), Err(AssetError::BadFormat));
    }
}
