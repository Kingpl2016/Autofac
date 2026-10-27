import { isEmitter } from "./functions";
import {
  CHANNEL_FUNCTIONS,
  type Capability,
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
    case "focus":
      return width === 2 ? 32768 : 128;
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
    properties: structuredClone(source.properties),
    modes: source.modes ? structuredClone(source.modes) : undefined,
    emitters: source.emitters ? structuredClone(source.emitters) : undefined,
  };
}

/** 属性是否属于“混色引擎直接驱动”的功能（发光体 / 亮度 / 开关）。 */
export function isDrivenFunction(fn: ChannelFunction): boolean {
  return fn === "switch" || fn === "dimmer" || isEmitter(fn);
}

/**
 * 按起始通道排序（不修改入参）。
 *
 * @param props 属性列表。
 */
export function sortByChannel(props: readonly FixtureProperty[]): FixtureProperty[] {
  return [...props].sort((a, b) => a.channel - b.channel || endChannel(a) - endChannel(b));
}

/** 默认模式在编辑器里的键（附加模式用自己的 `id`）。 */
export const DEFAULT_MODE_KEY = "";

/**
 * 取编辑器当前模式的通道布局。
 *
 * @param model 模型草稿。
 * @param key 模式键：`DEFAULT_MODE_KEY` 为默认模式，否则为附加模式编号。
 * @returns 通道布局；模式不存在时为空数组。
 */
export function layoutForKey(model: FixtureModel, key: string): FixtureProperty[] {
  if (key === DEFAULT_MODE_KEY) return model.properties;
  return model.modes?.find((m) => m.id === key)?.properties ?? [];
}

/**
 * 替换某个模式的通道布局（不修改入参）。
 *
 * @param model 模型草稿。
 * @param key 模式键。
 * @param properties 新布局。
 * @returns 新的模型草稿。
 */
export function withLayout(model: FixtureModel, key: string, properties: FixtureProperty[]): FixtureModel {
  if (key === DEFAULT_MODE_KEY) return { ...model, properties };
  return {
    ...model,
    modes: (model.modes ?? []).map((m) => (m.id === key ? { ...m, properties } : m)),
  };
}

/**
 * 以某个模式为底稿新增一个附加模式（不修改入参）。
 *
 * @param model 模型草稿。
 * @param fromKey 作为底稿的模式键。
 * @param name 新模式的显示名。
 * @returns 新草稿与新模式的编号。
 */
export function addMode(model: FixtureModel, fromKey: string, name: string): { model: FixtureModel; key: string } {
  const taken = new Set((model.modes ?? []).map((m) => m.id));
  let n = (model.modes?.length ?? 0) + 1;
  while (taken.has(`mode${n}`)) n += 1;
  const key = `mode${n}`;
  const properties = structuredClone(layoutForKey(model, fromKey));
  return { model: { ...model, modes: [...(model.modes ?? []), { id: key, name, properties }] }, key };
}

/**
 * 删除一个附加模式（默认模式不能删除）。
 *
 * @param model 模型草稿。
 * @param key 要删除的模式编号。
 * @returns 新的模型草稿；最后一个附加模式被删除时去掉 `modes` 字段。
 */
export function removeMode(model: FixtureModel, key: string): FixtureModel {
  const modes = (model.modes ?? []).filter((m) => m.id !== key);
  const { modes: _old, ...rest } = model;
  void _old;
  return modes.length > 0 ? { ...rest, modes } : rest;
}

/**
 * 新增一个能力区间：从上一个区间结束处之后开始，一直到位宽上限。
 *
 * @param caps 现有区间（升序）。
 * @param width 通道位宽。
 * @returns 新区间；已经铺满时为 `null`。
 */
export function nextCapability(caps: readonly Capability[], width: 1 | 2): Capability | null {
  const max = width === 2 ? 65535 : 255;
  const start = caps.length === 0 ? 0 : caps[caps.length - 1].range[1] + 1;
  if (start > max) return null;
  return { range: [start, max], label: "" };
}

/**
 * 把整个取值范围均分成 `count` 段阶梯区间（例如 8 个图案位）。
 *
 * @param count 段数，至少 1。
 * @param width 通道位宽。
 * @param label 每段的显示名生成函数（参数为 1 起的段号）。
 * @returns 升序、互不重叠且铺满整个范围的区间。
 */
export function splitCapabilities(count: number, width: 1 | 2, label: (n: number) => string): Capability[] {
  const max = width === 2 ? 65535 : 255;
  const total = max + 1;
  const n = Math.max(1, Math.min(Math.floor(count), total));
  return Array.from({ length: n }, (_, i) => {
    const lo = Math.floor((i * total) / n);
    const hi = Math.floor(((i + 1) * total) / n) - 1;
    return { range: [lo, hi] as [number, number], label: label(i + 1) };
  });
}

/**
 * 模型里出现过的加色发光体（所有模式合并、去重，按功能列表顺序）。
 *
 * @param model 模型草稿。
 * @returns 发光体功能列表。
 */
export function emitterFunctions(model: FixtureModel): ChannelFunction[] {
  const seen = new Set<ChannelFunction>();
  for (const props of [model.properties, ...(model.modes ?? []).map((m) => m.properties)]) {
    for (const p of props) if (isEmitter(p.function)) seen.add(p.function);
  }
  return CHANNEL_FUNCTIONS.filter((f) => seen.has(f));
}
