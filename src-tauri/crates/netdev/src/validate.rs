//! 请求发出前的本地校验（规则镜像固件，避免明知会被拒的请求）。

use crate::error::{NetdevError, Result};

/// 固件允许的节目文件扩展名。
const PROGRAM_EXT: &str = ".artrec";
/// 文件名最大字节数。
const MAX_FILE_NAME_BYTES: usize = 128;

/// 校验节目文件名：以 `.artrec` 结尾、≤128 字节、无路径分隔符 / `..` / 控制字符。
///
/// # Arguments
///
/// * `name` - 待校验文件名。
///
/// # Errors
///
/// 违反任一规则时返回 [`NetdevError::Invalid`]，描述具体原因。
pub fn check_program_file_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(NetdevError::Invalid("文件名不能为空".into()));
    }
    if name.len() > MAX_FILE_NAME_BYTES {
        return Err(NetdevError::Invalid(format!(
            "文件名过长（最多 {MAX_FILE_NAME_BYTES} 字节）"
        )));
    }
    if name.contains(['/', '\\']) || name.contains("..") {
        return Err(NetdevError::Invalid("文件名不能包含路径分隔符或 ..".into()));
    }
    if name.chars().any(char::is_control) {
        return Err(NetdevError::Invalid("文件名不能包含控制字符".into()));
    }
    if !name.to_ascii_lowercase().ends_with(PROGRAM_EXT) || name.len() == PROGRAM_EXT.len() {
        return Err(NetdevError::Invalid("文件名须以 .artrec 结尾".into()));
    }
    Ok(())
}

/// 校验主机：IPv4 / 主机名（RFC1123 子集，允许 `.local`），不得带协议、路径、端口或空白。
///
/// # Arguments
///
/// * `host` - 用户输入的主机。
///
/// # Returns
///
/// 去除首尾空白后的主机串。
///
/// # Errors
///
/// 格式非法时返回 [`NetdevError::Invalid`]。
pub fn check_host(host: &str) -> Result<String> {
    let h = host.trim();
    if h.is_empty() {
        return Err(NetdevError::Invalid("主机不能为空".into()));
    }
    if h.len() > 253 {
        return Err(NetdevError::Invalid("主机过长".into()));
    }
    let ok_chars = h
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if !ok_chars || h.starts_with(['.', '-']) || h.ends_with(['.', '-']) || h.contains("..") {
        return Err(NetdevError::Invalid(
            "主机只能是 IP 或主机名，不要包含 http://、端口或路径".into(),
        ));
    }
    // 全数字加点号的串必须是合法 IPv4，避免 999.1.1.1 之类被当主机名放行。
    if h.chars().all(|c| c.is_ascii_digit() || c == '.') && h.parse::<std::net::Ipv4Addr>().is_err()
    {
        return Err(NetdevError::Invalid("IP 地址格式不正确".into()));
    }
    Ok(h.to_string())
}

/// 校验端口号。
///
/// # Arguments
///
/// * `port` - 端口。
///
/// # Errors
///
/// 端口为 0 时返回 [`NetdevError::Invalid`]。
pub fn check_port(port: u16) -> Result<()> {
    if port == 0 {
        return Err(NetdevError::Invalid("端口必须在 1~65535 之间".into()));
    }
    Ok(())
}

/// 校验 HTTP Token：空串（表示清除）或 8~64 位可见 ASCII。
///
/// # Arguments
///
/// * `token` - 待校验 Token。
///
/// # Errors
///
/// 长度或字符非法时返回 [`NetdevError::Invalid`]。
pub fn check_token(token: &str) -> Result<()> {
    if token.is_empty() {
        return Ok(());
    }
    if !(8..=64).contains(&token.len()) || !token.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(NetdevError::Invalid("Token 须为 8~64 位可见 ASCII 字符".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names() {
        assert!(check_program_file_name("show.artrec").is_ok());
        assert!(check_program_file_name("开场秀.ARTREC").is_ok());
        for bad in ["", ".artrec", "a.txt", "a/b.artrec", "a\\b.artrec", "..a.artrec", "a\n.artrec"] {
            assert!(check_program_file_name(bad).is_err(), "{bad:?}");
        }
        let long = format!("{}.artrec", "x".repeat(130));
        assert!(check_program_file_name(&long).is_err());
    }

    #[test]
    fn hosts() {
        assert_eq!(check_host(" 192.168.1.20 ").unwrap(), "192.168.1.20");
        assert!(check_host("artnet-core.local").is_ok());
        for bad in ["", "http://1.2.3.4", "1.2.3.4:80", "a/b", "999.1.1.1", "-a", "a..b", "a b"] {
            assert!(check_host(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn ports_and_tokens() {
        assert!(check_port(80).is_ok());
        assert!(check_port(0).is_err());
        assert!(check_token("").is_ok());
        assert!(check_token("abcd1234").is_ok());
        assert!(check_token("short").is_err());
        assert!(check_token("has space 123").is_err());
        assert!(check_token(&"x".repeat(65)).is_err());
    }
}
