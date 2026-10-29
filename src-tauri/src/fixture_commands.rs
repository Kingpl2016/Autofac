//! Tauri 命令：灯具素材库（物模型）的查询、Excel 导入与自定义模型维护。
//!
//! 命令只做"提取 → 调用领域 → 返回 DTO"；模型定义、导入与持久化位于 `show-engine` crate。
//! 错误以字符串错误码返回（前端据此选择本地化文案）：`bad_path`、`file_too_large`、
//! `import_failed:<open|no_models>`、`builtin_readonly`、`not_found`、`invalid_model:<原因>`、`io`。

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;
use show_engine::fixture::{
    import_ofl, import_xlsx, FixtureLibrary, FixtureModel, ImportWarning, MergeOutcome,
};
use tauri::{AppHandle, Manager, State};

/// 灯具库文件名（位于应用数据目录下）。
const LIBRARY_FILE: &str = "fixtures.json";

/// 允许导入的 Excel 文件大小上限（字节）。
const MAX_XLSX_BYTES: u64 = 20 * 1024 * 1024;

/// 错误码：导入路径不是 `.xlsx` 文件。
pub const ERR_BAD_PATH: &str = "bad_path";

/// 错误码：导入文件超过大小上限。
pub const ERR_FILE_TOO_LARGE: &str = "file_too_large";

/// 应用壳托管的灯具库状态。
pub struct FixtureState {
    /// 灯具库；命令之间串行访问。
    library: Mutex<FixtureLibrary>,
}

impl FixtureState {
    /// 打开应用数据目录下的灯具库。
    ///
    /// # Arguments
    ///
    /// * `app` - Tauri 应用句柄，用于取得数据根目录（软件目录下的 `data`）。
    ///
    /// # Returns
    ///
    /// 灯具库状态；数据目录无法解析时库文件落在当前目录（极少见）。
    #[must_use]
    pub fn new(app: &AppHandle) -> Self {
        let dir = app.state::<crate::data_dir::DataRoot>().path().to_path_buf();
        Self {
            library: Mutex::new(FixtureLibrary::open(dir.join(LIBRARY_FILE))),
        }
    }

    /// 在持有库锁期间执行操作。
    ///
    /// # Arguments
    ///
    /// * `f` - 要执行的操作。
    ///
    /// # Returns
    ///
    /// `f` 的返回值。
    fn with<T>(&self, f: impl FnOnce(&mut FixtureLibrary) -> T) -> T {
        // parking_lot 锁不毒化；库总是整体替换，即便某次操作 panic 数据也保持一致
        let mut guard = self.library.lock();
        f(&mut guard)
    }
}

/// Excel 导入的结果：合并统计 + 解析警告。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ImportOutcome {
    /// 新增 / 覆盖 / 忽略的模型编号。
    #[serde(flatten)]
    pub merge: MergeOutcome,
    /// 解析过程中的警告。
    pub warnings: Vec<ImportWarning>,
}

/// 列出全部灯具模型：内置模型在前，用户模型在后。
///
/// # Arguments
///
/// * `state` - 灯具库状态。
///
/// # Returns
///
/// 全部模型。
#[tauri::command]
pub fn fixture_list(state: State<'_, FixtureState>) -> Vec<FixtureModel> {
    state.with(|lib| lib.list())
}

/// 检查导入路径并返回规范化后的 `PathBuf`。
///
/// # Arguments
///
/// * `path` - 用户在对话框里选择的文件路径。
///
/// # Returns
///
/// 通过检查的路径。
///
/// # Errors
///
/// - 扩展名不是 `.xlsx` 或不是文件时返回 [`ERR_BAD_PATH`]。
/// - 文件超过 20 MiB 时返回 [`ERR_FILE_TOO_LARGE`]。
fn check_xlsx_path(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path.trim());
    let is_xlsx = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("xlsx"));
    let meta = std::fs::metadata(path).map_err(|_| ERR_BAD_PATH.to_owned())?;
    if !is_xlsx || !meta.is_file() {
        return Err(ERR_BAD_PATH.to_owned());
    }
    if meta.len() > MAX_XLSX_BYTES {
        return Err(ERR_FILE_TOO_LARGE.to_owned());
    }
    Ok(path.to_path_buf())
}

/// 导入物模型 Excel，并把得到的模型合并进用户库。
///
/// # Arguments
///
/// * `state` - 灯具库状态。
/// * `path` - 用户选择的 `.xlsx` 文件路径。
///
/// # Returns
///
/// 合并统计与解析警告。
///
/// # Errors
///
/// 路径或大小不符合要求、文件无法解析、没有可用模型、写库失败时返回对应错误码（见模块文档）。
#[tauri::command]
pub async fn fixture_import_xlsx(
    state: State<'_, FixtureState>,
    path: String,
) -> Result<ImportOutcome, String> {
    let path = check_xlsx_path(&path)?;
    // 解析工作簿可能较慢，放到阻塞线程池，避免占用异步运行时
    let report = tauri::async_runtime::spawn_blocking(move || import_xlsx(&path))
        .await
        .map_err(|e| format!("import_failed:{e}"))?
        .map_err(|e| e.code())?;
    let merge = state
        .with(|lib| lib.merge_import(report.models))
        .map_err(|e| e.code())?;
    Ok(ImportOutcome {
        merge,
        warnings: report.warnings,
    })
}

/// 允许导入的 OFL JSON 文件大小上限（字节）。
const MAX_OFL_BYTES: u64 = 5 * 1024 * 1024;

/// 检查 OFL 导入路径，并给出生成模型编号用的标识（`上级目录/文件名`）。
///
/// # Arguments
///
/// * `path` - 用户选择的文件路径。
///
/// # Returns
///
/// 通过检查的路径与标识，例如 `cameo/auro-spot-200`。
///
/// # Errors
///
/// - 扩展名不是 `.json` 或不是文件时返回 [`ERR_BAD_PATH`]。
/// - 文件超过 5 MiB 时返回 [`ERR_FILE_TOO_LARGE`]。
fn check_ofl_path(path: &str) -> Result<(PathBuf, String), String> {
    let path = Path::new(path.trim());
    let is_json = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    let meta = std::fs::metadata(path).map_err(|_| ERR_BAD_PATH.to_owned())?;
    if !is_json || !meta.is_file() {
        return Err(ERR_BAD_PATH.to_owned());
    }
    if meta.len() > MAX_OFL_BYTES {
        return Err(ERR_FILE_TOO_LARGE.to_owned());
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("fixture");
    let parent = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
        .unwrap_or("ofl");
    Ok((path.to_path_buf(), format!("{parent}/{stem}")))
}

/// 导入一个 Open Fixture Library 灯具 JSON，并合并进用户库。
///
/// # Arguments
///
/// * `state` - 灯具库状态。
/// * `path` - 用户选择的 `.json` 文件路径。
///
/// # Returns
///
/// 合并统计与解析警告。
///
/// # Errors
///
/// 路径或大小不符合要求（`bad_path` / `file_too_large`）、不是合法 OFL JSON
/// （`import_failed:open`）、没有可用模式（`import_failed:no_models`）、写库失败（`io`）。
#[tauri::command]
pub async fn fixture_import_ofl(
    state: State<'_, FixtureState>,
    path: String,
) -> Result<ImportOutcome, String> {
    let (path, key) = check_ofl_path(&path)?;
    let text = tokio::fs::read_to_string(&path)
        .await
        .map_err(|_| "import_failed:open".to_owned())?;
    // 解析与校验是纯计算，几十毫秒级；放到阻塞线程池，避免大文件占住异步运行时
    let report = tauri::async_runtime::spawn_blocking(move || import_ofl(&text, &key))
        .await
        .map_err(|e| format!("import_failed:{e}"))?
        .map_err(|e| e.code())?;
    let merge = state
        .with(|lib| lib.merge_import(report.models))
        .map_err(|e| e.code())?;
    Ok(ImportOutcome {
        merge,
        warnings: report.warnings,
    })
}

/// 新增或更新一个自定义灯具模型。
///
/// # Arguments
///
/// * `state` - 灯具库状态。
/// * `model` - 要保存的模型。
///
/// # Returns
///
/// 实际保存的模型。
///
/// # Errors
///
/// 编号属于内置模型（`builtin_readonly`）、模型不合法（`invalid_model:<原因>`）或写库失败（`io`）。
#[tauri::command]
pub fn fixture_save(
    state: State<'_, FixtureState>,
    model: FixtureModel,
) -> Result<FixtureModel, String> {
    state.with(|lib| lib.upsert(model)).map_err(|e| e.code())
}

/// 删除一个自定义灯具模型。
///
/// # Arguments
///
/// * `state` - 灯具库状态。
/// * `id` - 要删除的模型编号。
///
/// # Errors
///
/// 内置模型（`builtin_readonly`）、不存在（`not_found`）或写库失败（`io`）。
#[tauri::command]
pub fn fixture_delete(state: State<'_, FixtureState>, id: String) -> Result<(), String> {
    state.with(|lib| lib.remove(&id)).map_err(|e| e.code())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 导入路径必须是xlsx文件() {
        assert_eq!(check_xlsx_path("Z:\\不存在的目录\\a.xlsx"), Err(ERR_BAD_PATH.to_owned()));
        // 目录和非 xlsx 文件都拒绝
        let dir = std::env::temp_dir();
        assert_eq!(check_xlsx_path(&dir.to_string_lossy()), Err(ERR_BAD_PATH.to_owned()));
        let txt = dir.join(format!("fixture-cmd-{}.txt", std::process::id()));
        std::fs::write(&txt, b"x").expect("写临时文件");
        assert_eq!(check_xlsx_path(&txt.to_string_lossy()), Err(ERR_BAD_PATH.to_owned()));
        let _ = std::fs::remove_file(&txt);
    }

    #[test]
    fn ofl路径必须是json文件_标识取上级目录与文件名() {
        let dir = std::env::temp_dir().join(format!("ofl-cmd-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("cameo")).expect("建临时目录");
        let json = dir.join("cameo").join("auro-spot.json");
        std::fs::write(&json, b"{}").expect("写临时文件");
        let (_, key) = check_ofl_path(&json.to_string_lossy()).expect("应通过");
        assert_eq!(key, "cameo/auro-spot");
        let txt = dir.join("cameo").join("a.txt");
        std::fs::write(&txt, b"x").expect("写临时文件");
        assert_eq!(check_ofl_path(&txt.to_string_lossy()).map(|_| ()), Err(ERR_BAD_PATH.to_owned()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 合法的xlsx路径通过检查() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../doc/DMX物模型表.xlsx");
        assert!(check_xlsx_path(&path.to_string_lossy()).is_ok());
    }
}
