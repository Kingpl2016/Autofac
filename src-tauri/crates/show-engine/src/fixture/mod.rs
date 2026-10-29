//! 灯具物模型：模型定义、内置模型、Excel / OFL 导入与模型库。
//!
//! Excel 导入依赖 `calamine`，由 `xlsx` 特性开启（WASM 构建关闭它）。

mod builtin;
mod import;
mod model;
mod ofl;
mod store;
#[cfg(feature = "xlsx")]
mod xlsx;

pub use builtin::builtin_models;
pub use import::{ImportError, ImportReport, ImportWarning, ImportWarningKind};
pub use model::{
    find_overlap, footprint, reassign_sequential, validate_layout, AttributeGroup, Capability,
    CapabilityTag, ChannelFunction, Emitter, FixtureError, FixtureMode, FixtureModel, FixtureProperty,
    MatrixLayout, Physical, Precedence, DMX_CHANNELS, MAX_CAPABILITIES, MAX_HEADS, MAX_ID_LEN,
    MAX_MODES, MAX_PROPERTIES,
};
pub use ofl::{import_ofl, import_ofl_as, OFL_RECOGNIZER_VERSION};
pub use store::{FixtureLibrary, LibraryError, MergeOutcome};
#[cfg(feature = "xlsx")]
pub use xlsx::import_xlsx;
