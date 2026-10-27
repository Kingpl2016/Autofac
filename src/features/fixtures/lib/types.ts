/**
 * 灯具素材库（物模型）类型，与 Rust `show_engine::fixture` 的 DTO（camelCase）一一对应。
 *
 * - `properties` 是默认模式的通道布局；其它通道模式在 `modes` 里，各自有完整布局。
 * - 多头 / 像素灯在 `matrix` 里声明排布，通道对象经 `head` 指明所属像素（0 为整灯）。
 * - 可选字段在后端序列化时会省略默认值，因此前端读到的对象里它们可能不存在。
 */

/** 通道属性的功能；编辑器按功能把“颜色 + 亮度”映射到通道。顺序即下拉菜单里的顺序。 */
export const CHANNEL_FUNCTIONS = [
  "switch",
  "dimmer",
  "red",
  "green",
  "blue",
  "white",
  "coolWhite",
  "warmWhite",
  "amber",
  "uv",
  "lime",
  "cyan",
  "magenta",
  "yellow",
  "colorTemp",
  "pan",
  "tilt",
  "speed",
  "shutter",
  "colorWheel",
  "gobo",
  "goboRotate",
  "prism",
  "prismRotate",
  "frost",
  "focus",
  "zoom",
  "iris",
  "goboShake",
  "macro",
  "reset",
  "other",
] as const;

/** 通道属性功能。 */
export type ChannelFunction = (typeof CHANNEL_FUNCTIONS)[number];

/** 属性功能组（检查器按组分区，预设按组分类）。 */
export const ATTRIBUTE_GROUPS = ["intensity", "color", "position", "beam", "focus", "control"] as const;

/** 属性功能组。 */
export type AttributeGroup = (typeof ATTRIBUTE_GROUPS)[number];

/** 合成规则：HTP 取最大值，LTP 后来者优先。 */
export type Precedence = "htp" | "ltp";

/** 能力区间：通道取值落在 `range` 内时灯具的行为。 */
export interface Capability {
  /** DMX 起止值（均含），按通道位宽 */
  range: [number, number];
  /** 显示名，例如“开光”“图案 3” */
  label: string;
  /** 比例区间（效果随取值线性变化） */
  proportional?: boolean;
  /** 比例区间的起止物理量 */
  physical?: [number, number];
  /** 物理量单位：deg / Hz / % / K …；无单位省略 */
  unit?: string;
  /** 代表色（颜色轮槽位等） */
  color?: [number, number, number];
}

/** 灯具的一个通道对象。 */
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
  /** 高亮值；省略为最大值 */
  highlightValue?: number;
  /** 合成规则；省略时按功能取默认 */
  precedence?: Precedence;
  /** 反向输出 */
  invert?: boolean;
  /** 所属像素头：0（或省略）为整灯，1..n 为像素 */
  head?: number;
  /** 能力区间，升序且互不重叠 */
  capabilities?: Capability[];
}

/** 附加通道模式。 */
export interface FixtureMode {
  /** 模型内唯一、非空 */
  id: string;
  name: string;
  properties: FixtureProperty[];
}

/** 像素排布（行优先编号，从 1 开始）。 */
export interface MatrixLayout {
  cols: number;
  rows: number;
}

/** 发光体校准。 */
export interface Emitter {
  function: ChannelFunction;
  /** 满亮时的显示颜色 */
  rgb?: [number, number, number];
  /** 白光类发光体的色温（K） */
  kelvin?: number;
  /** 相对亮度权重，省略为 1 */
  intensity?: number;
}

/** 物理参数。 */
export interface Physical {
  panRangeDeg?: number;
  tiltRangeDeg?: number;
  beamMinDeg?: number;
  beamMaxDeg?: number;
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
  /** 默认模式的通道布局 */
  properties: FixtureProperty[];
  manufacturer?: string;
  /** 默认模式的显示名；省略时界面显示“默认” */
  defaultModeName?: string;
  modes?: FixtureMode[];
  matrix?: MatrixLayout;
  emitters?: Emitter[];
  physical?: Physical;
}

/** Excel 导入警告类别。 */
export type ImportWarningKind =
  | "channelsReassigned"
  | "duplicateModel"
  | "invalidRow"
  | "invalidModel"
  | "unknownFunction"
  | "fineChannelSeparate"
  | "unsupportedFeature";

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
