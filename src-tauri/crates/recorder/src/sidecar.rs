//! 节目元数据 sidecar（`xxx.artrec.json`）。
//!
//! `.artrec` 本体严格遵循规范、保持与核心板固件互通；名称、备注、过滤条件、
//! 来源设备等元信息放在同名 sidecar 里，缺失时节目库仍可仅凭 `.artrec` 列出。

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use artnet_net::Protocol;
use serde::{Deserialize, Serialize};

use crate::filter::RecordFilter;

/// sidecar 当前版本。
pub const SIDECAR_VERSION: u32 = 1;

/// 节目元数据。所有字段带默认值，保证读取旧版或手写 JSON 时前向兼容。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sidecar {
    /// sidecar 版本。
    pub version: u32,
    /// 节目显示名。
    pub name: String,
    /// 备注。
    pub notes: String,
    /// 创建时间（Unix 毫秒）。
    pub created_unix_ms: u64,
    /// 录制所用应用版本。
    pub app_version: String,
    /// 录制时生效的过滤条件。
    pub filter: RecordFilter,
    /// 文件内的 Universe 集合（与 UniDesc 顺序一致）。
    pub universes: Vec<u16>,
    /// 合并模式（`htp` / `ltp` / `priority`）。
    pub merge_mode: String,
    /// 实际录到数据的来源 IP。
    pub sources: Vec<IpAddr>,
    /// 实际录到数据的协议。
    pub protocols: Vec<Protocol>,
    /// 录制期间因不在固定集合内而被忽略的 Universe。
    pub ignored_universes: Vec<u16>,
    /// 节目总时长（微秒）。
    pub duration_us: u64,
    /// 帧数。
    pub frames: u64,
    /// 文件字节数。
    pub bytes: u64,
    /// 是否由崩溃恢复生成。
    pub recovered: bool,
    /// 回放可视化用的时间线概览缓存（由 player 生成，格式见 player crate）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overview: Option<serde_json::Value>,
}

/// 给定 `.artrec` 路径，返回其 sidecar 路径（追加 `.json`）。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 文件路径。
///
/// # Returns
///
/// 在 `artrec` 末尾追加 `.json` 后的路径，如 `show.artrec` 对应 `show.artrec.json`。
#[must_use]
pub fn sidecar_path(artrec: &Path) -> PathBuf {
    let mut s = artrec.as_os_str().to_owned();
    s.push(".json");
    PathBuf::from(s)
}

/// 读取 sidecar；文件不存在或损坏时返回 `None`（不视为错误）。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 文件路径（读取其对应的 sidecar）。
///
/// # Returns
///
/// 读取并解析成功返回 `Some(`[`Sidecar`]`)`；sidecar 不存在、无法读取或 JSON 损坏时返回 `None`。
#[must_use]
pub fn read_sidecar(artrec: &Path) -> Option<Sidecar> {
    let text = std::fs::read_to_string(sidecar_path(artrec)).ok()?;
    serde_json::from_str(&text).ok()
}

/// 原子写入 sidecar：先写临时文件再重命名覆盖。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 文件路径（写入其对应的 sidecar）。
/// * `meta` - 要写入的节目元数据。
///
/// # Errors
///
/// 序列化或写盘失败返回 [`std::io::Error`]。
pub fn write_sidecar(artrec: &Path, meta: &Sidecar) -> std::io::Result<()> {
    let target = sidecar_path(artrec);
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let text = serde_json::to_string_pretty(meta)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &target)
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use super::{read_sidecar, sidecar_path, write_sidecar, Sidecar};
    use crate::testutil::TempDir;

    #[test]
    fn path_appends_json() {
        let p = std::path::Path::new("a/b/show.artrec");
        assert_eq!(sidecar_path(p), std::path::PathBuf::from("a/b/show.artrec.json"));
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = TempDir::new("sidecar");
        let art = dir.path().join("x.artrec");
        let meta = Sidecar {
            version: 1,
            name: "开场".into(),
            sources: vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9))],
            universes: vec![0, 1],
            frames: 12,
            ..Sidecar::default()
        };
        write_sidecar(&art, &meta).unwrap();
        assert_eq!(read_sidecar(&art), Some(meta));
    }

    #[test]
    fn missing_or_corrupt_is_none_and_unknown_fields_ignored() {
        let dir = TempDir::new("sidecar-bad");
        let art = dir.path().join("y.artrec");
        assert!(read_sidecar(&art).is_none());
        std::fs::write(sidecar_path(&art), "not json").unwrap();
        assert!(read_sidecar(&art).is_none());
        std::fs::write(sidecar_path(&art), r#"{"name":"n","futureField":1}"#).unwrap();
        assert_eq!(read_sidecar(&art).unwrap().name, "n");
    }
}
