//! Tauri 命令：节目编辑器“文件”菜单的辅助操作——在文件管理器中显示工程、查询工程文件信息、
//! 把当前工程导出为 `.artrec`。
//!
//! 路径规则沿用 `recorder`：节目库条目必须是录制目录的直接子级（[`recorder::resolve_entry`]），
//! 库外工程只接受 `.artshow`，导出目标只接受 `.artrec`。错误以字符串错误码返回，与
//! [`crate::show_commands`] 一致（`outside_library`、`not_found`、`bad_path`…）。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use recorder::{resolve_entry, show_project_path, EXTERNAL_EXTENSION};
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::recording_commands::{lib_err, resolved_dir, LIB_ERR_NOT_FOUND};
use crate::show_commands::ERR_BAD_PATH;

/// 错误码：无法打开系统文件管理器。
pub const ERR_REVEAL_FAILED: &str = "reveal_failed";

/// 工程所在位置的种类：节目库里的节目，或库外的 `.artshow` 文件。
const KIND_LIBRARY: &str = "library";
const KIND_EXTERNAL: &str = "external";

/// 解析出的工程位置。
struct Located {
    /// 工程文件（节目库为 `名称.artrec.show`，库外为 `.artshow` 本身）。
    project: PathBuf,
    /// 节目库里的回放文件 `.artrec`（库外工程为 `None`；文件不一定存在）。
    artrec: Option<PathBuf>,
}

/// 扩展名是否为 `ext`（不区分大小写）。
///
/// # Arguments
///
/// * `path` - 路径。
/// * `ext` - 不带点的扩展名。
///
/// # Returns
///
/// 扩展名相同时为 `true`。
fn has_ext(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// 校验并解析工程位置。
///
/// # Arguments
///
/// * `app` - 应用句柄（解析录制目录）。
/// * `kind` - `library` 或 `external`。
/// * `path` - 节目的 `.artrec` 路径，或库外 `.artshow` 路径。
///
/// # Returns
///
/// 工程文件与回放文件的路径。
///
/// # Errors
///
/// 种类未知或库外路径扩展名不对时返回 `bad_path`；节目库路径不在录制目录内时返回 `outside_library`。
fn locate(app: &AppHandle, kind: &str, path: &str) -> Result<Located, String> {
    match kind {
        KIND_LIBRARY => {
            let artrec = resolve_entry(&resolved_dir(app), Path::new(path)).map_err(lib_err)?;
            Ok(Located { project: show_project_path(&artrec), artrec: Some(artrec) })
        }
        KIND_EXTERNAL => {
            let project = PathBuf::from(path);
            if !has_ext(&project, EXTERNAL_EXTENSION) {
                return Err(ERR_BAD_PATH.to_owned());
            }
            Ok(Located { project, artrec: None })
        }
        _ => Err(ERR_BAD_PATH.to_owned()),
    }
}

/// 文件大小与修改时间。
///
/// # Arguments
///
/// * `path` - 文件路径。
///
/// # Returns
///
/// 是普通文件时返回 `(字节数, 修改时间（Unix 毫秒，取不到时为 None）)`；不存在或不是文件时为 `None`。
fn stat(path: &Path) -> Option<(u64, Option<u64>)> {
    let meta = std::fs::metadata(path).ok().filter(std::fs::Metadata::is_file)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_millis()).ok());
    Some((meta.len(), modified))
}

/// 工程文件信息（文件菜单“节目信息”与最近文件的失效检查用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowFileInfo {
    /// 工程文件是否存在。
    pub exists: bool,
    /// 工程文件路径。
    pub project_path: String,
    /// 工程文件字节数（不存在时为 0）。
    pub bytes: u64,
    /// 工程文件修改时间（Unix 毫秒）。
    pub modified_unix_ms: Option<u64>,
    /// 节目库里回放文件 `.artrec` 的路径（库外工程为 `None`）。
    pub artrec_path: Option<String>,
    /// 回放文件字节数（还没生成时为 `None`）。
    pub artrec_bytes: Option<u64>,
    /// 回放文件修改时间（Unix 毫秒）。
    pub artrec_modified_unix_ms: Option<u64>,
}

/// 查询工程文件信息。文件不存在不算错误（`exists` 为 `false`）。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `kind` - `library`（节目库里的节目）或 `external`（库外 `.artshow`）。
/// * `path` - 节目的 `.artrec` 路径，或 `.artshow` 路径。
///
/// # Returns
///
/// 工程文件与（节目库条目的）回放文件的大小和修改时间。
///
/// # Errors
///
/// 路径不合格（`bad_path`、`outside_library`），或后台任务失败的描述。
#[tauri::command]
pub async fn show_file_info(app: AppHandle, kind: String, path: String) -> Result<ShowFileInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let located = locate(&app, &kind, &path)?;
        let project = stat(&located.project);
        let artrec = located.artrec.as_deref().and_then(stat);
        Ok(ShowFileInfo {
            exists: project.is_some(),
            project_path: located.project.to_string_lossy().into_owned(),
            bytes: project.map_or(0, |(b, _)| b),
            modified_unix_ms: project.and_then(|(_, m)| m),
            artrec_path: located.artrec.as_ref().map(|p| p.to_string_lossy().into_owned()),
            artrec_bytes: artrec.map(|(b, _)| b),
            artrec_modified_unix_ms: artrec.and_then(|(_, m)| m),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 在系统文件管理器里显示工程：节目库条目优先选中回放文件 `.artrec`（还没生成时选中工程文件），
/// 库外工程选中 `.artshow` 本身。
///
/// # Arguments
///
/// * `app` - 应用句柄（打开文件管理器）。
/// * `kind` - `library` 或 `external`。
/// * `path` - 节目的 `.artrec` 路径，或 `.artshow` 路径。
///
/// # Errors
///
/// 路径不合格（`bad_path`、`outside_library`）、文件都不存在（`not_found`），
/// 或无法打开文件管理器（`reveal_failed`）。
#[tauri::command]
pub fn show_reveal(app: AppHandle, kind: String, path: String) -> Result<(), String> {
    let located = locate(&app, &kind, &path)?;
    let target = located
        .artrec
        .filter(|p| p.is_file())
        .or_else(|| located.project.is_file().then_some(located.project))
        .ok_or_else(|| LIB_ERR_NOT_FOUND.to_owned())?;
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|_| ERR_REVEAL_FAILED.to_owned())
}

/// 导出 ArtRec 的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    /// 写入的帧数（静止段落不写帧）。
    pub frames: u64,
    /// 文件字节数。
    pub bytes: u64,
}

/// 校验导出目标：扩展名必须是 `.artrec`，不能是目录，所在目录必须存在。
///
/// # Arguments
///
/// * `path` - 用户在保存对话框里选的路径。
///
/// # Returns
///
/// 校验通过的路径。
///
/// # Errors
///
/// 不合格时返回 `bad_path`。
fn check_export_path(path: &str) -> Result<PathBuf, String> {
    let dest = PathBuf::from(path);
    let parent_ok = dest.parent().is_some_and(|p| !p.as_os_str().is_empty() && p.is_dir());
    if !has_ext(&dest, "artrec") || dest.is_dir() || !parent_ok {
        return Err(ERR_BAD_PATH.to_owned());
    }
    Ok(dest)
}

/// 把当前工程（不必先保存）烘焙成指定位置的 `.artrec`，可直接拷进核心板或交给回放。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `path` - 目标 `.artrec` 路径；已存在时原子替换。
/// * `json` - 工程 JSON 文本。
///
/// # Returns
///
/// 写入的帧数与文件大小。
///
/// # Errors
///
/// 路径不合格（`bad_path`）、目标正被回放打开（`in_use`）、工程无法解析（`invalid_project`）、
/// 没有可烘焙内容（`nothing_to_bake`）、被取消（`cancelled`），或编码 / 文件系统错误描述。
#[tauri::command]
pub async fn show_export_artrec(app: AppHandle, path: String, json: String) -> Result<ExportReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = check_export_path(&path)?;
        let report = crate::show_bake::bake_json_to(&app, &json, &dest)?;
        Ok(ExportReport { frames: report.frames, bytes: report.bytes })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_path_requires_artrec_in_existing_dir() {
        let dir = std::env::temp_dir();
        let ok = dir.join("ans-export.artrec");
        assert_eq!(check_export_path(&ok.to_string_lossy()), Ok(ok.clone()));
        assert_eq!(check_export_path(&dir.join("x.artshow").to_string_lossy()), Err(ERR_BAD_PATH.to_owned()));
        assert_eq!(
            check_export_path(&dir.join("no-such-dir-ans").join("x.artrec").to_string_lossy()),
            Err(ERR_BAD_PATH.to_owned())
        );
        assert_eq!(check_export_path("x.artrec"), Err(ERR_BAD_PATH.to_owned()));
        assert_eq!(check_export_path(&dir.to_string_lossy()), Err(ERR_BAD_PATH.to_owned()));
    }

    #[test]
    fn stat_reports_size_and_missing() {
        let p = std::env::temp_dir().join(format!("ans-stat-{}.artshow", std::process::id()));
        std::fs::write(&p, b"{}").unwrap();
        let (bytes, modified) = stat(&p).unwrap();
        assert_eq!(bytes, 2);
        assert!(modified.is_some());
        std::fs::remove_file(&p).unwrap();
        assert_eq!(stat(&p), None);
        assert_eq!(stat(&std::env::temp_dir()), None);
    }

    #[test]
    fn ext_check_is_case_insensitive() {
        assert!(has_ext(Path::new("a.ARTSHOW"), "artshow"));
        assert!(!has_ext(Path::new("a.artshow.bak"), "artshow"));
        assert!(!has_ext(Path::new("artshow"), "artshow"));
    }
}
