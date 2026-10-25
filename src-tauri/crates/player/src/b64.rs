//! 极简标准 Base64（带填充）编解码，以及 `Vec<Vec<u8>>` 的 serde 适配。
//!
//! 概览数据是按 Universe 分行的字节矩阵；以 Base64 字符串序列化，
//! 比 JSON 数字数组小约 3 倍，也让 sidecar 与 IPC 载荷保持紧凑。

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 编码为标准 Base64（带 `=` 填充）。
///
/// # Arguments
///
/// * `bytes` - 待编码的原始字节。
///
/// # Returns
///
/// 标准字母表（`+` 与 `/`）的 Base64 字符串，长度为 4 的倍数；输入为空时返回空字符串。
#[must_use]
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// 解码标准 Base64；非法字符或长度返回 `None`。
///
/// # Arguments
///
/// * `text` - 带 `=` 填充的标准 Base64 字符串。
///
/// # Returns
///
/// 解码成功返回原始字节；长度不是 4 的倍数、含非法字符或填充位置错误时返回 `None`。
#[must_use]
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (i, quad) in bytes.chunks(4).enumerate() {
        let last = (i + 1) * 4 == bytes.len();
        let pad = quad.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut n = 0u32;
        for &c in &quad[..4 - pad] {
            n = (n << 6) | value(c)?;
        }
        n <<= 6 * pad as u32;
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// serde 适配：`Vec<Vec<u8>>` ⇄ Base64 字符串数组。
pub mod rows {
    use serde::de::Error;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use super::{decode, encode};

    /// 序列化。
    ///
    /// # Arguments
    ///
    /// * `rows` - 按行排列的字节矩阵，每行编码为一个 Base64 字符串。
    /// * `s` - serde 序列化器。
    ///
    /// # Returns
    ///
    /// 序列化器的成功值（`S::Ok`），内容为 Base64 字符串数组。
    ///
    /// # Errors
    ///
    /// 底层序列化器失败时透传其错误。
    pub fn serialize<S: Serializer>(rows: &[Vec<u8>], s: S) -> Result<S::Ok, S::Error> {
        rows.iter()
            .map(|r| encode(r))
            .collect::<Vec<_>>()
            .serialize(s)
    }

    /// 反序列化。
    ///
    /// # Arguments
    ///
    /// * `d` - serde 反序列化器，输入应为 Base64 字符串数组。
    ///
    /// # Returns
    ///
    /// 每个 Base64 字符串解码得到的一行字节，按输入顺序组成的字节矩阵。
    ///
    /// # Errors
    ///
    /// 输入不是字符串数组或含非法 Base64 时返回错误。
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Vec<u8>>, D::Error> {
        let strs = Vec::<String>::deserialize(d)?;
        strs.iter()
            .map(|s| decode(s).ok_or_else(|| D::Error::custom("非法 Base64")))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{decode, encode};

    #[test]
    fn matches_rfc4648_vectors() {
        for (raw, enc) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode(raw.as_bytes()), enc);
            assert_eq!(decode(enc).unwrap(), raw.as_bytes());
        }
    }

    #[test]
    fn roundtrips_all_byte_values() {
        let data: Vec<u8> = (0..=255).collect();
        assert_eq!(decode(&encode(&data)).unwrap(), data);
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(decode("abc").is_none(), "长度不是 4 的倍数");
        assert!(decode("ab!d").is_none(), "非法字符");
        assert!(decode("=abc").is_none(), "填充位置错误");
        assert!(decode("Zg==Zg==").is_none(), "中间出现填充");
    }
}
