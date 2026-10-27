/**
 * 灯具素材库（物模型）类型，与 Rust `show_engine::fixture` 的 DTO（camelCase）一一对应。
 */

/** 通道属性的功能；编辑器按功能把“颜色 + 亮度”映射到通道。 */
export const CHANNEL_FUNCTIONS = [
  "switch",
  "dimmer",
  "red",
  "green",
  "blue",
  "white",
  "coolWhite",
  "warmWhite",
  "pan",
  "tilt",
  "speed",
  "shutter",
  "colorWheel",
  "gobo",
  "prism",
  "prismRotate",
  "frost",
  "focus",
  "goboShake",
  "macro",
  "reset",
  "other",
] as const;

/** 通道属性功能。 */
export type ChannelFunction = (typeof CHANNEL_FUNCTIONS)[number];

/** 灯具的一个通道属性。 */
export interface FixtureProperty {
  /** 中文显示名，例如“红光” */
  name: string;
  /** 英文代码，例如 `Red` */
  code: string;
  function: ChannelFunction;
  /** 起始通道，1~512 */
  channel: number;
  /** 占用的连续通道数：1 为 8 位，2 为 16 位 */
  width: 1 | 2;
  /** 多通道属性的字节序，`true` 为大端 */
  bigEndian: boolean;
  /** 默认值（8 位 0~255，16 位 0~65535） */
  defaultValue: number;
  /** DMX 数值说明 */
  valueDesc: string;
  /** 字段描述 */
  description: string;
}

/** 灯具物模型（一类灯具的模板）。 */
export interface FixtureModel {
  /** 模型编号，格式 `[表号].[序号].[系统].[类型]` */
  id: string;
  name: string;
  system: string;
  productType: string;
  /** 内置模型只读 */
  builtin: boolean;
  properties: FixtureProperty[];
}

/** Excel 导入警告类别。 */
export type ImportWarningKind =
  | "channelsReassigned"
  | "duplicateModel"
  | "invalidRow"
  | "invalidModel"
  | "unknownFunction";

/** 一条导入警告。 */
export interface ImportWarning {
  kind: ImportWarningKind;
  sheet: string;
  /** 表格中的行号（从 1 开始） */
  row: number | null;
  modelId: string | null;
  /** 补充信息：属性英文代码或校验错误码 */
  detail: string | null;
}

/** Excel 导入结果。 */
export interface ImportOutcome {
  /** 新增的模型编号 */
  added: string[];
  /** 覆盖了已有自定义模型的编号 */
  updated: string[];
  /** 因与内置模型编号冲突而被忽略的编号 */
  skipped: string[];
  warnings: ImportWarning[];
}

/** DMX 单个 Universe 的通道数。 */
export const DMX_CHANNELS = 512;
