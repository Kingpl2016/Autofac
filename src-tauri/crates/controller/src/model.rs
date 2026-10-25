//! 核心板文件条目模型。

use serde::{Deserialize, Serialize};

/// SD 卡上的一个文件条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// 文件名。
    pub name: String,
    /// 字节大小。
    #[serde(default)]
    pub size: u64,
    /// 是否为目录。
    #[serde(default)]
    pub is_dir: bool,
}
