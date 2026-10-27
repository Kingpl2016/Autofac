//! 物模型导入（Excel / OFL）共用的结果、警告与错误类型。

use serde::Serialize;
use thiserror::Error;

use super::model::FixtureModel;

/// 导入过程中的警告类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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
    /// OFL：用到了暂不支持的特性（例如按像素组重复的矩阵通道），相关通道已跳过。
    UnsupportedFeature,
}

/// 一条导入警告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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
}
