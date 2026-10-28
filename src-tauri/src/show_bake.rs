//! 节目编辑器保存时的烘焙：把工程渲染成核心板可回放的 `.artrec`。
//!
//! 流程：`show_project_save` 先把工程写进节目库（这一步成功就算保存成功），然后调用 [`schedule`]
//! 在后台线程烘焙，进度和结果经 `show:bake` 事件推给前端。烘焙失败不影响保存，工程仍然可编辑，
//! 只是 `.artrec` 不是最新（或不存在）。
//!
//! - 所有烘焙串行执行（共用一把锁），同一节目连续保存时，较早的烘焙被取消，只保留最新的；
//! - 该节目正被回放打开时跳过（Windows 上无法替换被打开的文件），事件里说明原因；
//! - 帧由 `show-engine` 以 30 FPS 渲染，写入沿用录制的编码器（见 `recorder::bake`）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use host_core::ArtnetCoreExt;
use parking_lot::{Mutex, MutexGuard};
use recorder::{bake_file, BakeError, BakeReport, BakeSpec};
use serde::Serialize;
use show_engine::{compile, ShowProject, OUTPUT_FPS};
use tauri::{AppHandle, Emitter, Manager};

/// 错误码：工程没有可烘焙的内容（没有灯具或时长为 0）。
pub const ERR_NOTHING_TO_BAKE: &str = "nothing_to_bake";
/// 错误码：工程文件无法解析。
pub const ERR_INVALID_PROJECT: &str = "invalid_project";

/// 进度事件的最小间隔。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// `show:bake` 事件载荷。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BakeEvent {
    /// 节目的 `.artrec` 路径。
    pub path: String,
    /// 状态：`running` / `done` / `failed` / `skipped`。
    pub status: &'static str,
    /// 进度，`0.0..=1.0`。
    pub progress: f32,
    /// 完成时的帧数。
    pub frames: Option<u64>,
    /// 完成时的文件字节数。
    pub bytes: Option<u64>,
    /// 失败 / 跳过的原因（错误码或描述）。
    pub reason: Option<String>,
}

impl BakeEvent {
    fn new(path: &Path, status: &'static str) -> Self {
        Self {
            path: path.to_string_lossy().into_owned(),
            status,
            progress: 0.0,
            frames: None,
            bytes: None,
            reason: None,
        }
    }
}

/// 烘焙调度状态（由应用壳托管）。
#[derive(Default)]
pub struct ShowBakeState {
    /// 串行化所有烘焙。
    gate: Arc<Mutex<()>>,
    /// 每个节目最新一次烘焙的取消标志。
    latest: Mutex<HashMap<PathBuf, Arc<AtomicBool>>>,
}

impl ShowBakeState {
    /// 是否有烘焙在排队或进行。
    ///
    /// # Returns
    ///
    /// 有尚未结束的烘焙时为 `true`。
    #[must_use]
    pub fn is_busy(&self) -> bool {
        !lock(&self.latest).is_empty()
    }

    /// 取消所有烘焙并等它们收尾（退出应用前调用，保证不留下 `.bake` 临时文件）。
    pub fn cancel_all_and_wait(&self) {
        for cancel in lock(&self.latest).values() {
            cancel.store(true, Ordering::Relaxed);
        }
        // 烘焙线程持有这把锁直到收尾；取消后每帧检查，很快会释放
        drop(lock(&self.gate));
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock()
}

/// 烘焙失败原因（强类型；[`BakeFailure::code`] 给出与前端约定一致的错误码 / 描述）。
#[derive(Debug)]
enum BakeFailure {
    /// 工程没有可烘焙内容（没有灯具或时长为 0）。
    NothingToBake,
    /// 工程文件读不到或无法解析。
    InvalidProject,
    /// 被更新的保存取消。
    Cancelled,
    /// 编码或文件系统错误（已带前缀的描述）。
    Failed(String),
}

impl BakeFailure {
    /// 前端错误码 / 描述。
    ///
    /// # Returns
    ///
    /// 与历史一致的字符串：`nothing_to_bake` / `invalid_project` / `cancelled`，
    /// 或 `encode_failed: …` / IO 错误描述。
    fn code(&self) -> String {
        match self {
            BakeFailure::NothingToBake => ERR_NOTHING_TO_BAKE.to_owned(),
            BakeFailure::InvalidProject => ERR_INVALID_PROJECT.to_owned(),
            BakeFailure::Cancelled => "cancelled".to_owned(),
            BakeFailure::Failed(msg) => msg.clone(),
        }
    }
}

impl From<BakeError> for BakeFailure {
    fn from(e: BakeError) -> Self {
        match e {
            BakeError::Empty => BakeFailure::NothingToBake,
            BakeError::Cancelled => BakeFailure::Cancelled,
            BakeError::Encode(inner) => BakeFailure::Failed(format!("encode_failed: {inner}")),
            BakeError::Io(inner) => BakeFailure::Failed(inner.to_string()),
        }
    }
}

/// 读取节目库里的工程文件并烘焙成 `.artrec`。
///
/// # Arguments
///
/// * `artrec` - 节目的 `.artrec` 路径；同目录下的 `.artrec.show` 是工程来源。
/// * `cancel` - 取消标志。
/// * `progress` - 进度回调（`0.0..=1.0`）。
///
/// # Returns
///
/// 烘焙报告。
///
/// # Errors
///
/// 工程文件读不到 / 无法解析（`invalid_project`）、没有可烘焙内容（`nothing_to_bake`）、
/// 被取消（`cancelled`），或编码 / 文件系统错误描述。
fn bake_project(
    artrec: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<BakeReport, BakeFailure> {
    let text = std::fs::read_to_string(recorder::show_project_path(artrec))
        .map_err(|e| BakeFailure::Failed(e.to_string()))?;
    let project: ShowProject =
        serde_json::from_str(&text).map_err(|_| BakeFailure::InvalidProject)?;
    let compiled = compile(&project);
    let universes = compiled.universes().to_vec();
    let mut frames = compiled.new_frames();
    let spec = BakeSpec {
        universes: &universes,
        duration_us: u64::try_from(compiled.duration_ms()).unwrap_or(0) * 1000,
        fps: OUTPUT_FPS,
        looping: project.output.looping,
    };
    bake_file(artrec, spec, cancel, progress, |time_us, buffers| {
        // 与实时输出一致：位置按整毫秒求值
        compiled.evaluate_into(i64::try_from((time_us + 500) / 1000).unwrap_or(i64::MAX), &mut frames);
        for (buffer, frame) in buffers.iter_mut().zip(frames.frames()) {
            buffer.copy_from_slice(&frame.data);
        }
    })
    .map_err(BakeFailure::from)
}

/// 该节目是否正被回放打开（节目库替换节目前也用它检查，Windows 上无法替换被打开的文件）。
///
/// # Arguments
///
/// * `app` - 应用句柄。
/// * `artrec` - 节目的 `.artrec` 路径。
///
/// # Returns
///
/// 播放器已打开该节目（按规范化路径比较）时为 `true`。
pub(crate) fn is_open_in_player(app: &AppHandle, artrec: &Path) -> bool {
    let status = app.artnet_core().playback().status();
    if !status.loaded {
        return false;
    }
    let open = PathBuf::from(&status.path);
    open == artrec
        || matches!(
            (std::fs::canonicalize(&open), std::fs::canonicalize(artrec)),
            (Ok(a), Ok(b)) if a == b
        )
}

/// 在后台烘焙一个刚保存的节目；立即返回。
///
/// # Arguments
///
/// * `app` - 应用句柄（取状态、发事件）。
/// * `artrec` - 节目的 `.artrec` 路径（工程已写入同目录）。
pub fn schedule(app: &AppHandle, artrec: PathBuf) {
    let state = app.state::<ShowBakeState>();
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(older) = lock(&state.latest).insert(artrec.clone(), cancel.clone()) {
        older.store(true, Ordering::Relaxed);
    }
    let gate = state.gate.clone();
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("artrec-bake".into())
        .spawn(move || {
            let _turn = lock(&gate);
            run_one(&app, &artrec, &cancel);
            let state = app.state::<ShowBakeState>();
            let mut latest = lock(&state.latest);
            if latest.get(&artrec).is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
                latest.remove(&artrec);
            }
        });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "无法创建烘焙线程");
    }
}

/// 执行一次烘焙并发事件。
fn run_one(app: &AppHandle, artrec: &Path, cancel: &Arc<AtomicBool>) {
    // 排队期间已被更新的保存取代：什么也不做
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    if is_open_in_player(app, artrec) {
        let mut ev = BakeEvent::new(artrec, "skipped");
        ev.reason = Some("in_use".into());
        let _ = app.emit("show:bake", &ev);
        return;
    }
    let _ = app.emit("show:bake", BakeEvent::new(artrec, "running"));
    let mut last_emit = Instant::now();
    let mut on_progress = |p: f32| {
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            let mut ev = BakeEvent::new(artrec, "running");
            ev.progress = p;
            let _ = app.emit("show:bake", &ev);
        }
    };
    match bake_project(artrec, cancel, &mut on_progress) {
        Ok(report) => {
            let mut ev = BakeEvent::new(artrec, "done");
            ev.progress = 1.0;
            ev.frames = Some(report.frames);
            ev.bytes = Some(report.bytes);
            let _ = app.emit("show:bake", &ev);
        }
        // 被更新的保存取消：新的烘焙会接着汇报
        Err(BakeFailure::Cancelled) => {}
        Err(e) => {
            let status = if matches!(e, BakeFailure::NothingToBake) { "skipped" } else { "failed" };
            let mut ev = BakeEvent::new(artrec, status);
            ev.reason = Some(e.code());
            let _ = app.emit("show:bake", &ev);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use recorder::{list_library_uncached, save_show, SaveRequest};

    /// 一台 RGB 灯 + 一个 1 秒红色 Cue 的最小工程（总长 2 秒）。
    fn project_json(cue: bool) -> String {
        let properties: Vec<serde_json::Value> = ["red", "green", "blue"]
            .iter()
            .enumerate()
            .map(|(i, f)| {
                serde_json::json!({
                    "name": f, "code": f, "function": f, "channel": i + 1, "width": 1,
                    "bigEndian": true, "defaultValue": 0
                })
            })
            .collect();
        let model = serde_json::json!({ "id": "m", "name": "m", "properties": properties });
        let cues = if cue {
            vec![serde_json::json!({
                "kind": "static", "id": "c", "trackId": "t", "startMs": 500, "endMs": 1500,
                "brightness": 100, "fadeInMs": 0, "fadeOutMs": 0, "easing": "linear", "rgb": [255, 0, 0]
            })]
        } else {
            vec![]
        };
        serde_json::json!({
            "durationMs": 2000,
            "fixtureModels": [model],
            "fixtures": [{"id": "f", "name": "F", "modelId": "m", "universe": 2, "address": 10}],
            "tracks": [{"id": "t", "target": {"kind": "fixture", "id": "f"}}],
            "cues": cues,
            "output": {"loop": true, "gamma": 1.0}
        })
        .to_string()
    }

    fn saved(dir: &Path, json: &str) -> PathBuf {
        save_show(dir, SaveRequest { path: None, name: "秀", notes: "", file_stem: "秀", json }).unwrap()
    }

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("ans-bake-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn 烘焙结果与时间线一致() {
        let tmp = Tmp::new("ok");
        let artrec = saved(&tmp.0, &project_json(true));
        let mut last = 0.0;
        let report = bake_project(&artrec, &AtomicBool::new(false), &mut |p| last = p).unwrap();
        assert_eq!(report.universes, vec![2]);
        assert_eq!(report.duration_us, 2_000_000);
        assert!((last - 1.0).abs() < f32::EPSILON);

        let reader = artrec_core::ArtRecReader::open_file(&artrec).unwrap();
        assert!(reader.header().loop_play(), "output.loop 写入文件头");
        let channels = |t_us: u64| reader.frame_at(t_us).unwrap().unwrap()[0][9..12].to_vec();
        assert_eq!(channels(100_000), vec![0, 0, 0], "Cue 之前黑场");
        assert_eq!(channels(1_000_000), vec![255, 0, 0], "Cue 内红色（地址 10 → 偏移 9）");
        assert_eq!(channels(1_900_000), vec![0, 0, 0], "Cue 之后黑场");
        // 静止段不写帧：黑 → 红 → 黑 + 收尾帧
        assert_eq!(report.frames, 4);

        let entries = list_library_uncached(&tmp.0);
        assert!(entries[0].editable && entries[0].exported && entries[0].valid);
    }

    #[test]
    fn 没有灯具时没有可烘焙内容_不产生文件() {
        let tmp = Tmp::new("empty");
        let artrec = saved(&tmp.0, r#"{"durationMs":2000}"#);
        let err = bake_project(&artrec, &AtomicBool::new(false), &mut |_| {}).unwrap_err();
        assert_eq!(err.code(), ERR_NOTHING_TO_BAKE);
        assert!(!artrec.exists());
    }

    #[test]
    fn 工程损坏或缺失时报错() {
        let tmp = Tmp::new("bad");
        let artrec = saved(&tmp.0, "{}");
        // 合法 JSON 但缺少必需字段
        assert_eq!(
            bake_project(&artrec, &AtomicBool::new(false), &mut |_| {}).unwrap_err().code(),
            ERR_INVALID_PROJECT
        );
        let ghost = tmp.0.join("ghost.artrec");
        assert!(bake_project(&ghost, &AtomicBool::new(false), &mut |_| {}).is_err());
    }

    #[test]
    fn 取消的烘焙返回_cancelled_且保留旧文件() {
        let tmp = Tmp::new("cancel");
        let artrec = saved(&tmp.0, &project_json(true));
        bake_project(&artrec, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let before = std::fs::read(&artrec).unwrap();
        let err = bake_project(&artrec, &AtomicBool::new(true), &mut |_| {}).unwrap_err();
        assert_eq!(err.code(), "cancelled");
        assert_eq!(std::fs::read(&artrec).unwrap(), before);
    }

    #[test]
    fn 忙碌状态与取消() {
        let state = ShowBakeState::default();
        assert!(!state.is_busy());
        let flag = Arc::new(AtomicBool::new(false));
        lock(&state.latest).insert(PathBuf::from("a.artrec"), flag.clone());
        assert!(state.is_busy());
        state.cancel_all_and_wait();
        assert!(flag.load(Ordering::Relaxed), "应置位取消标志");
    }

    #[test]
    fn 事件载荷使用驼峰字段() {
        let mut ev = BakeEvent::new(Path::new("a.artrec"), "done");
        ev.frames = Some(3);
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["status"], "done");
        assert_eq!(v["frames"], 3);
        assert!(v["reason"].is_null());
    }
}
