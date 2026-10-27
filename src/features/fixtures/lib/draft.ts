import {
  CHANNEL_FUNCTIONS,
  type ChannelFunction,
  type FixtureModel,
  type FixtureProperty,
} from "./types";
import { channelCount, endChannel } from "./validate";

/**
 * 给自定义模型建议一个编号：表号 2（自定义），序号取现有自定义模型的最大序号加 1，
 * 系统 / 类型段沿用调光灯 `1.2` 的约定（`2.<序号>.1.2`）。
 *
 * @param models 现有全部模型。
 * @returns 未被占用的模型编号。
 */
export function nextCustomId(models: readonly FixtureModel[]): string {
  const taken = new Set(models.map((m) => m.id));
  let max = 0;
  for (const m of models) {
    const parts = m.id.split(".");
    if (parts[0] === "2") {
      const seq = Number(parts[1]);
      if (Number.isInteger(seq)) max = Math.max(max, seq);
    }
  }
  let seq = max + 1;
  while (taken.has(`2.${seq}.1.2`)) seq += 1;
  return `2.${seq}.1.2`;
}

/**
 * 功能对应的默认值（与后端 `ChannelFunction::default_value` 一致）。
 *
 * @param fn 功能。
 * @param width 通道数。
 */
export function defaultValueFor(fn: ChannelFunction, width: 1 | 2): number {
  switch (fn) {
    case "pan":
    case "tilt":
      return width === 2 ? 32768 : 128;
    case "focus":
      return 128;
    case "shutter":
      return 105;
    default:
      return 0;
  }
}

/**
 * 在模型末尾追加一个新属性，起始通道接在现有通道之后。
 *
 * @param model 模型。
 * @returns 新属性（尚未加入模型）。
 */
export function blankProperty(model: Pick<FixtureModel, "properties">): FixtureProperty {
  return {
    name: "",
    code: "",
    function: "other",
    channel: channelCount(model) + 1,
    width: 1,
    bigEndian: false,
    defaultValue: 0,
    valueDesc: "",
    description: "",
  };
}

/**
 * 空白的自定义模型。
 *
 * @param id 建议的模型编号。
 */
export function blankModel(id: string): FixtureModel {
  return {
    id,
    name: "",
    system: "",
    productType: "",
    builtin: false,
    properties: [],
  };
}

/**
 * 以现有模型为底稿复制出一个自定义模型（用于“复制为自定义”）。
 *
 * @param source 源模型。
 * @param id 新模型编号。
 * @param suffix 追加到名称后的后缀，例如“（副本）”。
 */
export function cloneAsCustom(source: FixtureModel, id: string, suffix: string): FixtureModel {
  return {
    ...source,
    id,
    name: `${source.name}${suffix}`,
    builtin: false,
    properties: source.properties.map((p) => ({ ...p })),
  };
}

/** 属性是否属于“灯光求值器直接驱动”的功能（颜色 / 亮度 / 开关）。 */
export function isDrivenFunction(fn: ChannelFunction): boolean {
  return CHANNEL_FUNCTIONS.indexOf(fn) <= CHANNEL_FUNCTIONS.indexOf("warmWhite");
}

/**
 * 按起始通道排序（不修改入参）。
 *
 * @param props 属性列表。
 */
export function sortByChannel(props: readonly FixtureProperty[]): FixtureProperty[] {
  return [...props].sort((a, b) => a.channel - b.channel || endChannel(a) - endChannel(b));
}
