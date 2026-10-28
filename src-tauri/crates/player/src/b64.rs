//! 极简标准 Base64（带填充）编解码，以及 `Vec<Vec<u8>>` 的 serde 适配。
//!
//! 概览数据是按 Universe 分行的字节矩阵；以 Base64 字符串序列化，
//! 比 JSON 数字数组小约 3 倍，也让 sidecar 与 IPC 载荷保持紧凑。

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

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
    STANDARD.encode(bytes)
}

/// 解码标准 Base64；非法字符、长度或填充不合法返回 `None`。
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
    STANDARD.decode(text).ok()
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
