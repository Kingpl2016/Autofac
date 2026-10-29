/**
 * 灯具素材库（物模型）类型：由 Rust `show_engine::fixture` 的 DTO 经 ts-rs 生成（`npm run gen:types`）。
 *
 * - `properties` 是默认模式的通道布局；其它通道模式在 `modes` 里，各自有完整布局。
 * - 多头 / 像素灯在 `matrix` 里声明排布，通道对象经 `head` 指明所属像素（0 为整灯）。
 * - 可选字段在后端序列化时会省略默认值，因此前端读到的对象里它们可能不存在。
 */

import type { AttributeGroup } from "@/bindings/AttributeGroup";
import type { ChannelFunction } from "@/bindings/ChannelFunction";

export type { AttributeGroup, ChannelFunction };
/** 合成规则：HTP 取最大值，LTP 后来者优先。 */
export type { Precedence } from "@/bindings/Precedence";
/** 能力区间：通道取值落在 `range` 内时灯具的行为。 */
export type { Capability } from "@/bindings/Capability";
/** 灯具的一个通道对象。 */
export type { FixtureProperty } from "@/bindings/FixtureProperty";
/** 发光体校准。 */
export type { Emitter } from "@/bindings/Emitter";
/** 物理参数。 */
export type { Physical } from "@/bindings/Physical";
/** 灯具物模型（一类灯具的模板）。 */
export type { FixtureModel } from "@/bindings/FixtureModel";
/** 一条导入警告。 */
export type { ImportWarning } from "@/bindings/ImportWarning";
/** 导入结果（Excel / OFL 单文件 / OFL 整库）。 */
export type { ImportOutcome } from "@/bindings/ImportOutcome";
/** OFL 整库目录：概况、查询条件、一页结果、一项与状态。 */
export type { CatalogSummary } from "@/bindings/CatalogSummary";
export type { CatalogQuery } from "@/bindings/CatalogQuery";
export type { CatalogPage } from "@/bindings/CatalogPage";
export type { CatalogItem } from "@/bindings/CatalogItem";
export type { CatalogStatus } from "@/bindings/CatalogStatus";

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
  "indigo",
  "cyan",
  "magenta",
  "yellow",
  "colorTemp",
  "pan",
  "tilt",
  "speed",
  "shutter",
  "colorWheel",
  "colorWheelRotate",
  "gobo",
  "goboRotate",
  "prism",
  "prismRotate",
  "frost",
  "focus",
  "zoom",
  "iris",
  "blade",
  "bladeRotate",
  "rotation",
  "goboShake",
  "macro",
  "reset",
  "fog",
  "effectSpeed",
  "maintenance",
  "other",
] as const satisfies readonly ChannelFunction[];

/** 属性功能组（检查器按组分区，预设按组分类）。 */
export const ATTRIBUTE_GROUPS = [
  "intensity",
  "color",
  "position",
  "beam",
  "focus",
  "control",
] as const satisfies readonly AttributeGroup[];

/** DMX 单个 Universe 的通道数。 */
export const DMX_CHANNELS = 512;
