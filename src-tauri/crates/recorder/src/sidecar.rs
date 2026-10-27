//! 节目元数据 sidecar（`xxx.artrec.json`）与时间线概览缓存（`xxx.artrec.ovw`）的路径与读写。
//!
//! `.artrec` 本体严格遵循规范、保持与核心板固件互通；名称、备注、过滤条件、
//! 来源设备等元信息放在同名 sidecar 里，缺失时节目库仍可仅凭 `.artrec` 列出。
//!
//! 回放可视化用的时间线概览存成独立的二进制缓存 `xxx.artrec.ovw`（格式见 `player::ovw`）；
//! 本模块只处理它的路径与字节，不依赖 player。旧版本曾把概览以 JSON 内嵌在 sidecar 的
//! `overview` 字段里：现在读取时该字段被忽略，之后任何写 sidecar 都不会再带上它，
//! 残留的旧字段可用 [`purge_legacy_overview`] 主动去掉。

use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use artnet_net::Protocol;
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};

use crate::filter::RecordFilter;

/// sidecar 当前版本。
pub const SIDECAR_VERSION: u32 = 1;

/// 概览缓存文件相对 `.artrec` 路径追加的后缀（`show.artrec` → `show.artrec.ovw`）。
pub const OVERVIEW_CACHE_SUFFIX: &str = ".ovw";

/// 节目编辑器工程文件相对 `.artrec` 路径追加的后缀（`show.artrec` → `show.artrec.show`）。
pub const SHOW_SUFFIX: &str = ".show";

/// sidecar 的 `source` 取值：节目由节目编辑器保存（有可编辑的工程）。
pub const SOURCE_EDITOR: &str = "editor";

/// 节目元数据。所有字段带默认值，保证读取旧版或手写 JSON 时前向兼容；
/// 未知字段（含旧版内嵌的 `overview` 概览）读取时被忽略、写回时不再保留。
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
    /// 节目来源：空串表示录制得到，[`SOURCE_EDITOR`] 表示由节目编辑器保存。
    pub source: String,
}

/// 探测 sidecar 里是否残留旧版内嵌的 `overview` 字段（内容不解析，`IgnoredAny` 直接跳过）。
#[derive(Deserialize)]
struct LegacyOverviewProbe {
    /// 旧版概览字段；存在且非 `null` 时为 `Some`。
    #[serde(default)]
    overview: Option<IgnoredAny>,
}

/// 在路径末尾追加后缀（不替换扩展名）。
///
/// # Arguments
///
/// * `path` - 原路径。
/// * `suffix` - 要追加的后缀，如 `.json`。
///
/// # Returns
///
/// 追加后缀后的新路径。
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// 原子写入：先写同目录临时文件（`目标.tmp`）再重命名覆盖；失败时尽力删除临时文件。
///
/// # Arguments
///
/// * `target` - 目标文件路径。
/// * `bytes` - 文件内容。
///
/// # Errors
///
/// 写临时文件或重命名失败返回 [`io::Error`]，此时目标文件保持原样。
fn write_atomic(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = with_suffix(target, ".tmp");
    let result = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, target));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
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
    with_suffix(artrec, ".json")
}

/// 给定 `.artrec` 路径，返回节目编辑器工程文件的路径（追加 `.show`）。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 文件路径（文件本身可以不存在）。
///
/// # Returns
///
/// 在 `artrec` 末尾追加 `.show` 后的路径，如 `show.artrec` 对应 `show.artrec.show`。
#[must_use]
pub fn show_project_path(artrec: &Path) -> PathBuf {
    with_suffix(artrec, SHOW_SUFFIX)
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
pub fn write_sidecar(artrec: &Path, meta: &Sidecar) -> io::Result<()> {
    let text = serde_json::to_string_pretty(meta)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_atomic(&sidecar_path(artrec), text.as_bytes())
}

/// 若 sidecar 里残留旧版内嵌的 `overview` 概览字段，就重写一次 sidecar 把它去掉（其余字段原样保留）。
///
/// 旧版把整份概览（几十 KB 的 Base64）塞在 sidecar 里，节目库每次列举都要读入解析；
/// 概览已改存 `.artrec.ovw`，调用方在生成新缓存后调用本函数完成迁移。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 文件路径（处理其对应的 sidecar）。
///
/// # Returns
///
/// 确实重写了 sidecar 返回 `true`；sidecar 不存在、不含旧字段或 JSON 无法解析（不贸然覆盖）时返回 `false`。
///
/// # Errors
///
/// 读取 sidecar（不存在除外）或重写失败返回 [`std::io::Error`]。
pub fn purge_legacy_overview(artrec: &Path) -> io::Result<bool> {
    let text = match std::fs::read_to_string(sidecar_path(artrec)) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let legacy =
        serde_json::from_str::<LegacyOverviewProbe>(&text).is_ok_and(|p| p.overview.is_some());
    if !legacy {
        return Ok(false);
    }
    let Ok(meta) = serde_json::from_str::<Sidecar>(&text) else {
        return Ok(false);
    };
    write_sidecar(artrec, &meta)?;
    Ok(true)
}

/// 给定 `.artrec` 路径，返回其概览缓存路径（追加 [`OVERVIEW_CACHE_SUFFIX`]）。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 文件路径。
///
/// # Returns
///
/// 在 `artrec` 末尾追加 `.ovw` 后的路径，如 `show.artrec` 对应 `show.artrec.ovw`。
#[must_use]
pub fn overview_cache_path(artrec: &Path) -> PathBuf {
    with_suffix(artrec, OVERVIEW_CACHE_SUFFIX)
}

/// 读取概览缓存的原始字节（不校验内容，由 `player::decode_overview` 解码校验）。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 文件路径（读取其对应的 `.ovw`）。
///
/// # Returns
///
/// 读取成功返回文件全部字节；缓存不存在或无法读取时返回 `None`（不视为错误）。
#[must_use]
pub fn read_overview_cache(artrec: &Path) -> Option<Vec<u8>> {
    std::fs::read(overview_cache_path(artrec)).ok()
}

/// 原子写入概览缓存：先写临时文件（`.ovw.tmp`）再重命名覆盖。
///
/// # Arguments
///
/// * `artrec` - `.artrec` 文件路径（写入其对应的 `.ovw`）。
/// * `bytes` - 由 `player::encode_overview` 生成的缓存内容。
///
/// # Errors
///
/// 写盘或重命名失败返回 [`std::io::Error`]（如录制目录只读）；此时原缓存文件保持原样。
pub fn write_overview_cache(artrec: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic(&overview_cache_path(artrec), bytes)
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use super::{
        overview_cache_path, purge_legacy_overview, read_overview_cache, read_sidecar,
        sidecar_path, write_overview_cache, write_sidecar, Sidecar,
    };
    use crate::testutil::TempDir;

    #[test]
    fn path_appends_json() {
        let p = std::path::Path::new("a/b/show.artrec");
        assert_eq!(
            sidecar_path(p),
            std::path::PathBuf::from("a/b/show.artrec.json")
        );
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

    /// 旧版 sidecar：内嵌 `overview` 概览字段。
    const LEGACY: &str = r#"{
        "version": 1,
        "name": "旧节目",
        "notes": "备注",
        "frames": 440,
        "overview": { "version": 1, "buckets": 16, "change": ["AAAA"], "level": ["AAAA"] }
    }"#;

    #[test]
    fn legacy_overview_is_ignored_on_read_and_dropped_on_write() {
        let dir = TempDir::new("sidecar-legacy");
        let art = dir.path().join("old.artrec");
        std::fs::write(sidecar_path(&art), LEGACY).unwrap();
        let meta = read_sidecar(&art).expect("旧字段不影响解析");
        assert_eq!(
            (meta.name.as_str(), meta.notes.as_str(), meta.frames),
            ("旧节目", "备注", 440)
        );

        // 任何一次正常写回都不再带上旧字段
        write_sidecar(&art, &meta).unwrap();
        let text = std::fs::read_to_string(sidecar_path(&art)).unwrap();
        assert!(!text.contains("\"overview\""), "{text}");
        assert_eq!(read_sidecar(&art), Some(meta));
    }

    #[test]
    fn purge_rewrites_only_legacy_sidecars() {
        let dir = TempDir::new("sidecar-purge");
        let art = dir.path().join("old.artrec");
        assert!(
            !purge_legacy_overview(&art).unwrap(),
            "没有 sidecar 时什么都不做"
        );

        std::fs::write(sidecar_path(&art), LEGACY).unwrap();
        assert!(purge_legacy_overview(&art).unwrap());
        let text = std::fs::read_to_string(sidecar_path(&art)).unwrap();
        assert!(!text.contains("\"overview\""), "{text}");
        let meta = read_sidecar(&art).unwrap();
        assert_eq!(
            (meta.name.as_str(), meta.notes.as_str(), meta.frames),
            ("旧节目", "备注", 440)
        );
        assert!(
            !purge_legacy_overview(&art).unwrap(),
            "已迁移的 sidecar 不再重写"
        );

        // 损坏的 JSON 不贸然覆盖
        std::fs::write(sidecar_path(&art), "{\"overview\": ").unwrap();
        assert!(!purge_legacy_overview(&art).unwrap());
        assert_eq!(
            std::fs::read_to_string(sidecar_path(&art)).unwrap(),
            "{\"overview\": "
        );
    }

    #[test]
    fn overview_cache_path_appends_ovw() {
        let p = std::path::Path::new("a/b/show.artrec");
        assert_eq!(
            overview_cache_path(p),
            std::path::PathBuf::from("a/b/show.artrec.ovw")
        );
    }

    #[test]
    fn overview_cache_write_read_and_overwrite() {
        let dir = TempDir::new("ovw-cache");
        let art = dir.path().join("x.artrec");
        assert!(read_overview_cache(&art).is_none(), "缓存不存在时为 None");
        write_overview_cache(&art, b"first").unwrap();
        assert_eq!(read_overview_cache(&art).as_deref(), Some(&b"first"[..]));
        write_overview_cache(&art, b"second, longer").unwrap();
        assert_eq!(
            read_overview_cache(&art).as_deref(),
            Some(&b"second, longer"[..])
        );
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            vec![std::ffi::OsString::from("x.artrec.ovw")],
            "不应残留临时文件"
        );
    }

    #[test]
    fn overview_cache_write_failure_is_reported() {
        let dir = TempDir::new("ovw-cache-fail");
        // 父目录不存在：写临时文件失败
        let art = dir.path().join("missing").join("x.artrec");
        assert!(write_overview_cache(&art, b"x").is_err());
    }
}
