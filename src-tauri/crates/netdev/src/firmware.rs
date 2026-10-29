//! 固件镜像预检：在上传前读取 ESP-IDF 应用镜像头与 `esp_app_desc_t`，提前发现选错文件。
//!
//! 布局（ESP-IDF 标准应用镜像）：24 字节镜像头（首字节魔数 `0xE9`）+ 8 字节首段头，
//! 随后是 `esp_app_desc_t`（魔数 `0xABCD5432`），位于文件偏移 32。

use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::error::{NetdevError, Result};

/// ESP 镜像头魔数。
const IMAGE_MAGIC: u8 = 0xE9;
/// `esp_app_desc_t` 魔数。
const APP_DESC_MAGIC: u32 = 0xABCD_5432;
/// `esp_app_desc_t` 在镜像中的偏移（镜像头 24 + 首段头 8）。
const APP_DESC_OFFSET: usize = 32;
/// `esp_app_desc_t` 大小。
const APP_DESC_LEN: usize = 256;
/// 设备 OTA 分区大小（见固件 `partitions.csv`：每槽 4 MiB）。
pub const OTA_SLOT_BYTES: u64 = 0x40_0000;

/// 固件预检结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct FirmwareInfo {
    /// 文件名。
    pub file_name: String,
    /// 文件字节数。
    pub size: u64,
    /// 固件版本字符串。
    pub version: String,
    /// 工程名。
    pub project_name: String,
    /// 编译时间（HH:MM:SS）。
    pub build_time: String,
    /// 编译日期。
    pub build_date: String,
    /// 构建所用 ESP-IDF 版本。
    pub idf_version: String,
}

/// 取 NUL 结尾的定长字符串字段。
fn cstr(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

/// 解析镜像头部字节。
///
/// # Arguments
///
/// * `head` - 文件开头至少 288 字节。
/// * `file_name` - 展示用文件名。
/// * `size` - 文件总字节数。
///
/// # Errors
///
/// 数据过短、魔数不符或超过 OTA 分区大小时返回 [`NetdevError::Invalid`]。
pub fn parse(head: &[u8], file_name: &str, size: u64) -> Result<FirmwareInfo> {
    if size > OTA_SLOT_BYTES {
        return Err(NetdevError::Invalid(format!(
            "固件 {size} 字节，超过设备 OTA 分区（{OTA_SLOT_BYTES} 字节）"
        )));
    }
    if head.len() < APP_DESC_OFFSET + APP_DESC_LEN {
        return Err(NetdevError::Invalid("文件过小，不是有效的固件镜像".into()));
    }
    if head[0] != IMAGE_MAGIC {
        return Err(NetdevError::Invalid(
            "不是 ESP 应用固件（镜像头魔数不符），请选择 .bin 应用镜像而非整片 Flash 或分区表".into(),
        ));
    }
    let d = &head[APP_DESC_OFFSET..APP_DESC_OFFSET + APP_DESC_LEN];
    let magic = u32::from_le_bytes([d[0], d[1], d[2], d[3]]);
    if magic != APP_DESC_MAGIC {
        return Err(NetdevError::Invalid("固件缺少应用描述，无法确认版本".into()));
    }
    Ok(FirmwareInfo {
        file_name: file_name.to_string(),
        size,
        version: cstr(&d[16..48]),
        project_name: cstr(&d[48..80]),
        build_time: cstr(&d[80..96]),
        build_date: cstr(&d[96..112]),
        idf_version: cstr(&d[112..144]),
    })
}

/// 读取本地固件文件并做预检。
///
/// # Arguments
///
/// * `path` - 固件 `.bin` 路径。
///
/// # Returns
///
/// 固件的版本、工程名、构建时间与大小。
///
/// # Errors
///
/// 文件无法读取，或内容未通过 [`parse`] 的检查时返回 [`NetdevError`]。
pub fn inspect(path: &Path) -> Result<FirmwareInfo> {
    let meta = std::fs::metadata(path)?;
    let mut head = vec![0u8; APP_DESC_OFFSET + APP_DESC_LEN];
    let mut f = std::fs::File::open(path)?;
    let mut read = 0;
    while read < head.len() {
        let n = f.read(&mut head[read..])?;
        if n == 0 {
            break;
        }
        read += n;
    }
    head.truncate(read);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("firmware.bin");
    parse(&head, name, meta.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        let mut b = vec![0u8; 512];
        b[0] = IMAGE_MAGIC;
        let d = APP_DESC_OFFSET;
        b[d..d + 4].copy_from_slice(&APP_DESC_MAGIC.to_le_bytes());
        b[d + 16..d + 16 + 5].copy_from_slice(b"1.4.2");
        b[d + 48..d + 48 + 10].copy_from_slice(b"artnet_p4\0");
        b[d + 80..d + 88].copy_from_slice(b"12:30:00");
        b[d + 96..d + 107].copy_from_slice(b"Oct 27 2026");
        b[d + 112..d + 118].copy_from_slice(b"v5.5.1");
        b
    }

    #[test]
    fn parses_valid_header() {
        let info = parse(&sample(), "fw.bin", 512).unwrap();
        assert_eq!(info.version, "1.4.2");
        assert_eq!(info.project_name, "artnet_p4");
        assert_eq!(info.build_date, "Oct 27 2026");
        assert_eq!(info.idf_version, "v5.5.1");
    }

    #[test]
    fn rejects_bad_images() {
        let mut bad_magic = sample();
        bad_magic[0] = 0x00;
        assert!(parse(&bad_magic, "x", 512).is_err());
        let mut no_desc = sample();
        no_desc[APP_DESC_OFFSET] = 0;
        assert!(parse(&no_desc, "x", 512).is_err());
        assert!(parse(&sample()[..100], "x", 100).is_err());
        assert!(parse(&sample(), "x", OTA_SLOT_BYTES + 1).is_err());
    }

    #[test]
    fn inspect_reads_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("fw.bin");
        std::fs::write(&p, sample()).unwrap();
        assert_eq!(inspect(&p).unwrap().file_name, "fw.bin");
        assert!(inspect(&dir.path().join("nope.bin")).is_err());
    }
}
