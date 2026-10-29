//! 灯具物模型：模型定义、内置模型、Excel / OFL 导入与模型库。
//!
//! Excel 导入依赖 `calamine`，由 `xlsx` 特性开启；OFL 整库读取依赖 `zip`，由 `ofl-bundle` 特性开启
//! （WASM 构建两者都关闭）。

mod builtin;
mod import;
mod model;
mod ofl;
#[cfg(feature = "ofl-bundle")]
mod ofl_bundle;
mod store;
#[cfg(feature = "xlsx")]
mod xlsx;

pub use builtin::builtin_models;
pub use import::{ImportError, ImportReport, ImportWarning, ImportWarningKind};
pub use model::{
    find_overlap, footprint, reassign_sequential, validate_layout, AttributeGroup, Capability,
    CapabilityTag, ChannelFunction, Emitter, FixtureError, FixtureMode, FixtureModel, FixtureProperty,
    MatrixLayout, ModelSource, Physical, Precedence, DMX_CHANNELS, MAX_CAPABILITIES, MAX_HEADS, MAX_ID_LEN,
    MAX_MODES, MAX_PROPERTIES,
};
pub use ofl::{import_ofl, import_ofl_as, ofl_model_id, OFL_RECOGNIZER_VERSION};
#[cfg(feature = "ofl-bundle")]
pub use ofl_bundle::{
    build_catalog, entry_model_id, import_from_bundle, BundleError, BundleImport, Catalog, CatalogEntry, CatalogItem,
    CatalogManufacturer, CatalogMode, CatalogPage, CatalogQuery, CatalogStatus, CatalogSummary, OflBundle,
    CATALOG_VERSION, MAX_BUNDLE_BYTES, MAX_BUNDLE_FIXTURES, MAX_FIXTURE_BYTES,
};
pub use store::{FixtureLibrary, LibraryError, MergeOutcome};
#[cfg(feature = "xlsx")]
pub use xlsx::import_xlsx;
