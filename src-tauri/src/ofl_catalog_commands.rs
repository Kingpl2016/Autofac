//! Tauri 命令：OFL 整库目录（打开 zip / 文件夹、搜索、勾选导入）。
//!
//! 打开包时建立轻量目录并写入数据根目录下的 `ofl-catalog.json`（重启后仍可浏览）；
//! 导入时按目录记录的路径重新打开包、核对指纹，全部解析完后一次性合并进灯具库（只写一次盘）。
//! 进度通过事件推送：`ofl:catalog-progress`（建目录）与 `ofl:import-progress`（导入），载荷为 `{ done, total }`。
//!
//! 错误码：`bundle_open`、`bundle_empty`、`bundle_too_large`、`bundle_not_found`、`catalog_stale`、
//! `catalog_missing`（还没有打开过包）、`io`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use show_engine::fixture::{
    build_catalog, import_from_bundle, Catalog, CatalogPage, CatalogQuery, CatalogStatus, CatalogSummary,
    FixtureModel, OflBundle, CATALOG_VERSION, OFL_RECOGNIZER_VERSION,
};
use tauri::{AppHandle, Emitter as _, Manager, State};

use crate::fixture_commands::{FixtureState, ImportOutcome, ImportFailure};

/// 目录文件名（位于数据根目录下）。
const CATALOG_FILE: &str = "ofl-catalog.json";
/// 建目录的进度事件。
const CATALOG_EVENT: &str = "ofl:catalog-progress";
/// 导入的进度事件。
const IMPORT_EVENT: &str = "ofl:import-progress";
/// 进度事件的最小间隔。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// 错误码：还没有打开过 OFL 包。
const ERR_CATALOG_MISSING: &str = "catalog_missing";

/// 进度事件载荷。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// 已处理数。
    done: usize,
    /// 总数。
    total: usize,
}

/// 应用壳托管的 OFL 目录状态。
pub struct OflCatalogState {
    /// 目录文件路径。
    path: PathBuf,
    /// 当前目录；`None` 表示尚未从磁盘读取或从未打开过包（见 `loaded`）。
    catalog: Mutex<Option<Arc<Catalog>>>,
    /// 是否已尝试从磁盘读取。
    loaded: Mutex<bool>,
}

impl OflCatalogState {
    /// 创建状态（目录文件位于数据根目录下，首次访问时读取）。
    ///
    /// # Arguments
    ///
    /// * `app` - Tauri 应用句柄，用于取得数据根目录。
    ///
    /// # Returns
    ///
    /// 目录状态。
    #[must_use]
    pub fn new(app: &AppHandle) -> Self {
        let dir = app.state::<crate::data_dir::DataRoot>().path().to_path_buf();
        Self { path: dir.join(CATALOG_FILE), catalog: Mutex::new(None), loaded: Mutex::new(false) }
    }

    /// 当前目录（首次调用时从磁盘读取；文件损坏或版本不符时视为没有目录）。
    fn current(&self) -> Option<Arc<Catalog>> {
        let mut loaded = self.loaded.lock();
        if !*loaded {
            *loaded = true;
            let from_disk = std::fs::read(&self.path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Catalog>(&b).ok())
                .filter(|c| c.version == CATALOG_VERSION);
            *self.catalog.lock() = from_disk.map(Arc::new);
        }
        self.catalog.lock().clone()
    }

    /// 替换当前目录并写盘。
    fn replace(&self, catalog: Catalog) -> Result<Arc<Catalog>, String> {
        let json = serde_json::to_vec(&catalog).map_err(|_| "io".to_owned())?;
        fsutil::write_atomic(&self.path, &json).map_err(|_| "io".to_owned())?;
        let catalog = Arc::new(catalog);
        *self.catalog.lock() = Some(catalog.clone());
        *self.loaded.lock() = true;
        Ok(catalog)
    }
}

/// 节流的进度回调：首尾必发，中间每 [`PROGRESS_INTERVAL`] 最多一次。
fn progress_emitter(app: AppHandle, event: &'static str) -> impl FnMut(usize, usize) {
    let mut last = Instant::now().checked_sub(PROGRESS_INTERVAL).unwrap_or_else(Instant::now);
    move |done, total| {
        if done == total || done <= 1 || last.elapsed() >= PROGRESS_INTERVAL {
            last = Instant::now();
            let _ = app.emit(event, Progress { done, total });
        }
    }
}

/// 按模型编号判断库里的状态。
fn status_lookup(models: Vec<FixtureModel>) -> impl Fn(&str) -> CatalogStatus {
    let by_id: HashMap<String, Option<u32>> =
        models.into_iter().map(|m| (m.id, m.source.filter(|s| s.kind == "ofl").map(|s| s.recognizer))).collect();
    move |id: &str| match by_id.get(id) {
        None => CatalogStatus::New,
        Some(Some(v)) if *v >= OFL_RECOGNIZER_VERSION => CatalogStatus::Imported,
        Some(_) => CatalogStatus::Outdated,
    }
}

/// 打开一个 OFL 包（`.zip` 或文件夹），建立目录。
///
/// # Arguments
///
/// * `app` - 应用句柄（推送进度事件）。
/// * `state` - 目录状态。
/// * `path` - 用户选择的 zip 文件或文件夹。
///
/// # Returns
///
/// 目录概况。
///
/// # Errors
///
/// 包无法打开、为空或超限（`bundle_*`），写目录文件失败（`io`）。
#[tauri::command]
pub async fn ofl_catalog_open(
    app: AppHandle,
    state: State<'_, OflCatalogState>,
    path: String,
) -> Result<CatalogSummary, String> {
    let source = PathBuf::from(path.trim());
    let emit = progress_emitter(app, CATALOG_EVENT);
    let catalog = tauri::async_runtime::spawn_blocking(move || -> Result<Catalog, String> {
        let mut emit = emit;
        let mut bundle = OflBundle::open(&source).map_err(|e| e.code().to_owned())?;
        Ok(build_catalog(&mut bundle, &source.to_string_lossy(), &mut emit))
    })
    .await
    .map_err(|_| "io".to_owned())??;
    Ok(state.replace(catalog)?.summary())
}

/// 当前目录的概况。
///
/// # Arguments
///
/// * `state` - 目录状态。
///
/// # Returns
///
/// 打开过包时为概况，否则为 `None`。
#[tauri::command]
pub fn ofl_catalog_summary(state: State<'_, OflCatalogState>) -> Option<CatalogSummary> {
    state.current().map(|c| c.summary())
}

/// 分页搜索目录。
///
/// # Arguments
///
/// * `state` - 目录状态。
/// * `fixtures` - 灯具库状态（判断每项是否已导入）。
/// * `query` - 查询条件。
///
/// # Returns
///
/// 总数与本页条目。
///
/// # Errors
///
/// 还没有打开过包时返回 `catalog_missing`。
#[tauri::command]
pub fn ofl_catalog_search(
    state: State<'_, OflCatalogState>,
    fixtures: State<'_, FixtureState>,
    query: CatalogQuery,
) -> Result<CatalogPage, String> {
    let catalog = state.current().ok_or_else(|| ERR_CATALOG_MISSING.to_owned())?;
    let status = status_lookup(fixtures.with(|lib| lib.list()));
    Ok(catalog.search(&query, &status))
}

/// 符合条件的全部灯具标识（“全选当前筛选结果”）。
///
/// # Arguments
///
/// * `state` - 目录状态。
/// * `fixtures` - 灯具库状态。
/// * `query` - 查询条件（忽略分页）。
///
/// # Returns
///
/// 灯具标识。
///
/// # Errors
///
/// 还没有打开过包时返回 `catalog_missing`。
#[tauri::command]
pub fn ofl_catalog_keys(
    state: State<'_, OflCatalogState>,
    fixtures: State<'_, FixtureState>,
    query: CatalogQuery,
) -> Result<Vec<String>, String> {
    let catalog = state.current().ok_or_else(|| ERR_CATALOG_MISSING.to_owned())?;
    let status = status_lookup(fixtures.with(|lib| lib.list()));
    Ok(catalog.matching_keys(&query, &status))
}

/// 从目录导入勾选的灯具，合并进灯具库（同编号覆盖）。
///
/// # Arguments
///
/// * `app` - 应用句柄（推送进度事件）。
/// * `state` - 目录状态。
/// * `fixtures` - 灯具库状态。
/// * `keys` - 灯具标识；重定向项导入它指向的灯具。
///
/// # Returns
///
/// 合并统计、解析警告与失败的灯具。
///
/// # Errors
///
/// 没有目录（`catalog_missing`）、包已变化（`catalog_stale`）或无法重新打开（`bundle_*`）、写库失败（`io`）。
#[tauri::command]
pub async fn ofl_catalog_import(
    app: AppHandle,
    state: State<'_, OflCatalogState>,
    fixtures: State<'_, FixtureState>,
    keys: Vec<String>,
) -> Result<ImportOutcome, String> {
    let catalog = state.current().ok_or_else(|| ERR_CATALOG_MISSING.to_owned())?;
    let emit = progress_emitter(app, IMPORT_EVENT);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut emit = emit;
        let mut bundle = OflBundle::open(Path::new(&catalog.source)).map_err(|e| e.code().to_owned())?;
        if bundle.fingerprint() != catalog.fingerprint {
            return Err("catalog_stale".to_owned());
        }
        Ok(import_from_bundle(&mut bundle, &catalog, &keys, &mut emit))
    })
    .await
    .map_err(|_| "io".to_owned())??;
    let merge = fixtures.with(|lib| lib.merge_import(result.report.models)).map_err(|e| e.code())?;
    Ok(ImportOutcome {
        merge,
        warnings: result.report.warnings,
        failed: result.failed.into_iter().map(|(key, code)| ImportFailure { key, code }).collect(),
    })
}
