//! 灯具物模型：模型定义、内置模型、Excel 导入与模型库。

mod builtin;
mod model;
mod store;
mod xlsx;

pub use builtin::builtin_models;
pub use model::{
    find_overlap, reassign_sequential, ChannelFunction, FixtureError, FixtureModel, FixtureProperty,
    DMX_CHANNELS, MAX_ID_LEN, MAX_PROPERTIES,
};
pub use store::{FixtureLibrary, LibraryError, MergeOutcome};
pub use xlsx::{import_xlsx, ImportError, ImportReport, ImportWarning, ImportWarningKind};
