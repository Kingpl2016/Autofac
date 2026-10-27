//! ArtRec 录制核心（纯逻辑，无 Tauri / 网络依赖）。
//!
//! 数据流：`DmxFrame` → [`RecordFilter`] 过滤 → 录制专用 `SignalEngine` 合并
//! → 变更检测与差分/全量选择（[`FrameEncoder`]）→ `artrec_core::ArtRecWriter`。
//!
//! - [`filter`]：按来源 IP、Universe 范围、协议过滤。
//! - [`encoder`]：变更触发、差分/全量自适应、关键帧间隔、收尾帧。
//! - [`session`]：把以上组合成可测试的录制会话。
//! - [`sidecar`]：节目元数据 sidecar（`.artrec.json`）与概览缓存（`.artrec.ovw`）的路径与读写。
//! - [`bake`]：把"按时间取帧"的数据源烘焙成 `.artrec`（节目编辑器保存时使用）。
//! - [`library`]：节目库列举（带进程级缓存）、重命名与删除。
//!
//! 时间戳均为"相对录制起点的微秒"，由宿主层在 socket 接收点用单调时钟取得，
//! 因此录制期间系统时间被调整不会影响时间轴。

pub mod bake;
pub mod disk;
pub mod encoder;
pub mod filter;
pub mod library;
pub mod session;
pub mod show_store;
pub mod sidecar;
pub mod store;
#[cfg(test)]
mod testutil;

pub use bake::{bake_file, BakeError, BakeReport, BakeSpec};
pub use disk::{
    can_start, classify, DiskGuard, DiskLevel, CRITICAL_FREE_BYTES, MIN_START_FREE_BYTES,
    WARN_FREE_BYTES,
};
pub use encoder::{
    Encoded, EncoderConfig, FrameEncoder, FrameKind, DEFAULT_DIFF_RATIO_DIV,
    DEFAULT_KEYFRAME_INTERVAL_US,
};
pub use filter::{RecordFilter, UniverseRange};
pub use library::{
    delete_recording, delete_recording_with, list_library, list_library_uncached, rename_recording,
    resolve_entry, resolve_in_dir, trash_paths, LibraryCache, LibraryEntry, LibraryError, TrashFn,
};
pub use session::{
    plan_universes, RecorderSession, SessionConfig, SessionStats, UniversePlan, DMX_LEN,
    MAX_UNIVERSES_PER_FILE,
};
pub use sidecar::{
    overview_cache_path, purge_legacy_overview, read_overview_cache, read_sidecar,
    show_project_path, sidecar_path, write_overview_cache, write_sidecar, Sidecar,
    OVERVIEW_CACHE_SUFFIX, SHOW_SUFFIX, SIDECAR_VERSION, SOURCE_EDITOR,
};
pub use show_store::{
    read_external, read_show, save_show, write_external, SaveRequest, ShowError,
    EXTERNAL_EXTENSION, MAX_PROJECT_BYTES,
};
pub use store::{
    list_artrec_files, recover_orphans, sanitize_file_stem, FileRecorder, Finished,
    RecoveryOutcome, StartParams, StoreError,
};
