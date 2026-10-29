//! 物模型导入（Excel / OFL）共用的结果、警告与错误类型。

use serde::Serialize;
use thiserror::Error;

use super::model::FixtureModel;

/// 导入过程中的警告类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum ImportWarningKind {
    /// 同一模型的属性通道重叠（或全部写成 1），已按行顺序重新排布。
    ChannelsReassigned,
    /// 模型编号在表格中重复出现，后出现的被忽略。
    DuplicateModel,
    /// 数据行缺少必需的列或数值非法，已跳过该行。
    InvalidRow,
    /// 模型整体不合法，已跳过（`detail` 为 [`super::FixtureError::code`]）。
    InvalidModel,
    /// 属性的英文代码无法识别，功能按“其他”处理。
    UnknownFunction,
    /// OFL：精细通道没有紧跟在粗调通道之后，无法合并为 16 位，已作为独立通道导入。
    FineChannelSeparate,
    /// OFL：用到了暂不支持的特性（`detail` 为特性名），相关模式或通道已跳过。
    UnsupportedFeature,
    /// OFL：模式里的通道键在灯具定义里找不到，该 DMX 通道留空。
    UnknownChannel,
    /// OFL：24 位等第二级以上的精细通道无法合并，已作为独立通道保留（模型最多 16 位）。
    FineChannelTruncated,
    /// OFL：同一像素里重复出现的唯一功能（例如两个调光），后出现的已降为“其他”。
    DuplicateFunctionDemoted,
    /// OFL：能力区间与前一个重叠、起止颠倒或超出数量上限，已丢弃（`detail` 为通道键）。
    CapabilityDropped,
    /// OFL：模式按像素组控制，像素编号按组出现的顺序分配（不对应网格位置）。
    PixelGroupsAsHeads,
    /// OFL：模式无法使用（`detail` 为原因），已跳过。
    ModeSkipped,
}

/// 一条导入警告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ImportWarning {
    /// 警告类别。
    pub kind: ImportWarningKind,
    /// 所在工作表名。
    pub sheet: String,
    /// 表格中的行号（从 1 开始）；与整行无关时为 `None`。
    pub row: Option<usize>,
    /// 相关模型的编号（若已知）。
    pub model_id: Option<String>,
    /// 补充信息，例如属性英文代码或校验错误码。
    pub detail: Option<String>,
}

/// 一次导入的结果：解析出的模型和过程中的警告。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 解析出的合法模型（`builtin` 恒为 `false`）。
    pub models: Vec<FixtureModel>,
    /// 导入警告。
    pub warnings: Vec<ImportWarning>,
}

/// 导入失败。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ImportError {
    /// 文件无法打开或解析（Excel 工作簿 / OFL JSON）。
    #[error("无法打开或解析文件：{0}")]
    Open(String),
    /// 工作簿里没有读到任何可用的模型。
    #[error("文件中没有找到可导入的物模型")]
    NoModels,
    /// OFL 重定向文件：灯具已改名或与另一型号相同，真正的定义在 `制造商/灯具` 里。
    #[error("这是一个重定向文件，指向 {0}")]
    Redirect(String),
}

impl ImportError {
    /// 机器可读的错误码，前端据此选择本地化文案。
    ///
    /// # Returns
    ///
    /// `import_failed:open`、`import_failed:no_models` 或 `import_failed:redirect:<目标>`。
    #[must_use]
    pub fn code(&self) -> String {
        match self {
            Self::Open(_) => "import_failed:open".to_owned(),
            Self::NoModels => "import_failed:no_models".to_owned(),
            Self::Redirect(target) => format!("import_failed:redirect:{target}"),
        }
    }
}
