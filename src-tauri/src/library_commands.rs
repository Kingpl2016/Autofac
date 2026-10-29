//! Tauri 命令：节目库的元数据维护、复制与编辑导出。
//!
//! 节目库列举 / 改名 / 删除在 [`crate::recording_commands`]；这里补上节目库页面需要的
//! 修改备注、创建副本，以及截取 / 拼接 / 只保留部分 Universe 的编辑导出（带进度与取消）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, MutexGuard};
use recorder::{EditError, EditOutput, EditSpec};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter as _, Manager};

use crate::recording_commands::{lib_err, resolved_dir};

/// 错误码：没有可导出的内容（片段为空、没有保留任何 Universe 或节目没有帧）。
pub const ERR_EMPTY_EDIT: &str = "empty_edit";
/// 错误码：编辑器节目不能被替换，只能另存为新节目。
pub const ERR_EDITABLE_REPLACE: &str = "editable_replace";
/// 错误码：节目正被播放器打开，不能替换。
pub const ERR_IN_USE: &str = "in_use";
/// 错误码：编辑导出被取消。
pub const ERR_CANCELLED: &str = "cancelled";

/// 编辑导出进度事件名。
const EDIT_EVENT: &str = "recordings:edit";
/// 进度事件的最小间隔。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// 正在进行的编辑导出任务的取消标志（按前端给出的任务 id 登记）。
#[derive(Default)]
pub struct EditJobs(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl EditJobs {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.0.lock()
    }
}

/// 修改节目备注（同时写入 sidecar 与编辑器工程）。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录。
/// * `path` - 节目路径，须位于录制目录内。
/// * `notes` - 新备注。
///
/// # Errors
///
/// 路径不在录制目录内（`outside_library`）、条目不存在（`not_found`）或写入失败。
#[tauri::command]
pub async fn recordings_set_notes(app: AppHandle, path: String, notes: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        recorder::set_notes(&resolved_dir(&app), Path::new(&path), &notes).map_err(lib_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 创建节目副本，返回副本路径。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄，用于解析录制目录。
/// * `path` - 源节目路径，须位于录制目录内。
/// * `new_name` - 副本显示名；文件名重名时自动追加编号。
///
/// # Returns
///
/// 副本 `.artrec` 路径字符串。
///
/// # Errors
///
/// 路径不在录制目录内（`outside_library`）、条目不存在（`not_found`）或复制失败。
#[tauri::command]
pub async fn recordings_duplicate(
    app: AppHandle,
    path: String,
    new_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        recorder::duplicate_recording(&resolved_dir(&app), Path::new(&path), &new_name)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(lib_err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保留片段（源时间轴，微秒）。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct SegmentDto {
    /// 片段开始（含）。
    pub start_us: u64,
    /// 片段结束（不含）。
    pub end_us: u64,
}

/// 结果去向。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum EditOutputDto {
    /// 另存为新节目。
    New {
        /// 新节目显示名。
        name: String,
    },
    /// 替换原节目（原文件移入回收站）。
    Replace,
}

/// 编辑导出请求。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct EditRequest {
    /// 源节目路径。
    pub path: String,
    /// 前端生成的任务 id（进度事件与取消用）。
    pub job_id: String,
    /// 要保留的片段，导出时按时间顺序首尾拼接。
    pub segments: Vec<SegmentDto>,
    /// 要保留的 Universe；`None` 表示全部保留。
    pub universes: Option<Vec<u16>>,
    /// 结果去向。
    pub output: EditOutputDto,
}

/// 编辑导出结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct EditResult {
    /// 结果节目路径。
    pub path: String,
    /// 总时长（微秒）。
    pub duration_us: u64,
    /// 帧数。
    pub frames: u64,
    /// 文件字节数。
    pub bytes: u64,
    /// 文件内的 Universe。
    pub universes: Vec<u16>,
}

/// `recordings:edit` 事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
struct EditProgress<'a> {
    /// 任务 id。
    job_id: &'a str,
    /// 进度 `0.0..=1.0`。
    progress: f32,
}

/// 把编辑错误转成前端错误码。
///
/// # Arguments
///
/// * `e` - 编辑错误。
///
/// # Returns
///
/// 前端可识别的错误码；编解码错误为描述文本。
fn edit_err(e: EditError) -> String {
    match e {
        EditError::Library(e) => lib_err(e),
        EditError::Empty => ERR_EMPTY_EDIT.to_string(),
        EditError::EditableReplace => ERR_EDITABLE_REPLACE.to_string(),
        EditError::Cancelled => ERR_CANCELLED.to_string(),
        EditError::Codec(e) => e.to_string(),
    }
}

/// 编辑导出节目：截取 / 拼接片段、只保留部分 Universe，另存为新节目或替换原节目。
///
/// 在阻塞线程上执行；进度经 `recordings:edit` 事件推送（约每 100 毫秒一次），
/// 可用 [`recordings_edit_cancel`] 按任务 id 取消。替换时持有会话锁，期间不能打开节目或开始录制。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `req` - 编辑请求。
///
/// # Returns
///
/// 结果节目的路径与统计。
///
/// # Errors
///
/// - `empty_edit` / `editable_replace` / `cancelled`：见各常量。
/// - `in_use`：要替换的节目正被播放器打开。
/// - `outside_library` / `not_found` / `trash_failed: …`：见 [`lib_err`]。
#[tauri::command]
pub async fn recordings_edit(app: AppHandle, req: EditRequest) -> Result<EditResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    app.state::<EditJobs>().lock().insert(req.job_id.clone(), cancel.clone());
    let job_id = req.job_id.clone();
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_edit(&handle, &req, &cancel))
        .await
        .map_err(|e| e.to_string());
    app.state::<EditJobs>().lock().remove(&job_id);
    result?
}

/// [`recordings_edit`] 的阻塞实现体。
fn run_edit(app: &AppHandle, req: &EditRequest, cancel: &AtomicBool) -> Result<EditResult, String> {
    let dir = resolved_dir(app);
    let spec = EditSpec {
        segments: req.segments.iter().map(|s| (s.start_us, s.end_us)).collect(),
        universes: req.universes.clone(),
    };
    let output = match &req.output {
        EditOutputDto::New { name } => EditOutput::New { name },
        EditOutputDto::Replace => EditOutput::Replace,
    };
    // 替换：与打开节目 / 开始录制串行，且节目不能正被播放器占用
    let _gate = (output == EditOutput::Replace).then(crate::playback_commands::session_gate);
    if output == EditOutput::Replace {
        let src = recorder::resolve_in_dir(&dir, Path::new(&req.path)).map_err(lib_err)?;
        if crate::show_bake::is_open_in_player(app, &src) {
            return Err(ERR_IN_USE.to_string());
        }
    }
    let mut last_emit = Instant::now();
    let mut on_progress = |p: f32| {
        if p >= 1.0 || last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            let _ = app.emit(EDIT_EVENT, EditProgress { job_id: &req.job_id, progress: p });
        }
    };
    let report = recorder::edit_recording(
        &dir,
        Path::new(&req.path),
        &spec,
        output,
        cancel,
        &mut on_progress,
        &recorder::trash_paths,
    )
    .map_err(edit_err)?;
    Ok(EditResult {
        path: report.path.to_string_lossy().into_owned(),
        duration_us: report.duration_us,
        frames: report.frames,
        bytes: report.bytes,
        universes: report.universes,
    })
}

/// 取消一个正在进行的编辑导出；任务不存在（已结束）时什么也不做。
///
/// # Arguments
///
/// * `app` - Tauri 应用句柄。
/// * `job_id` - [`recordings_edit`] 请求里的任务 id。
#[tauri::command]
pub fn recordings_edit_cancel(app: AppHandle, job_id: String) {
    if let Some(flag) = app.state::<EditJobs>().lock().get(&job_id) {
        flag.store(true, Ordering::Relaxed);
    }
}
