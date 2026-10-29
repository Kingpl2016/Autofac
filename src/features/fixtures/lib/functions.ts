import type { AttributeGroup, ChannelFunction, FixtureModel, FixtureProperty, Precedence } from "./types";

/**
 * 通道功能的分类规则，与 Rust `ChannelFunction::{group, is_emitter, default_precedence, is_unique}`
 * 保持一致。
 */

/** 加色发光体（混色引擎按发光体分配颜色的通道）。 */
const EMITTERS: ReadonlySet<ChannelFunction> = new Set<ChannelFunction>([
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
]);

/** 除发光体外，同一像素头里只能出现一次的功能。 */
const UNIQUE_EXTRA: ReadonlySet<ChannelFunction> = new Set<ChannelFunction>([
  "switch",
  "dimmer",
  "cyan",
  "magenta",
  "yellow",
  "colorTemp",
]);

const GROUP: Record<ChannelFunction, AttributeGroup> = {
  switch: "intensity",
  dimmer: "intensity",
  shutter: "intensity",
  red: "color",
  green: "color",
  blue: "color",
  white: "color",
  coolWhite: "color",
  warmWhite: "color",
  amber: "color",
  uv: "color",
  lime: "color",
  indigo: "color",
  cyan: "color",
  magenta: "color",
  yellow: "color",
  colorTemp: "color",
  colorWheel: "color",
  colorWheelRotate: "color",
  pan: "position",
  tilt: "position",
  speed: "position",
  gobo: "beam",
  goboRotate: "beam",
  goboShake: "beam",
  prism: "beam",
  prismRotate: "beam",
  frost: "beam",
  iris: "beam",
  blade: "beam",
  bladeRotate: "beam",
  rotation: "beam",
  focus: "focus",
  zoom: "focus",
  macro: "control",
  reset: "control",
  fog: "control",
  effectSpeed: "control",
  maintenance: "control",
  other: "control",
};

/**
 * 功能所属的属性组。
 *
 * @param fn 功能。
 * @returns 属性组。
 */
export function groupOf(fn: ChannelFunction): AttributeGroup {
  return GROUP[fn];
}

/**
 * 是否是一路加色发光体。
 *
 * @param fn 功能。
 */
export function isEmitter(fn: ChannelFunction): boolean {
  return EMITTERS.has(fn);
}

/**
 * 同一像素头里是否只能出现一次。
 *
 * @param fn 功能。
 */
export function isUniqueFunction(fn: ChannelFunction): boolean {
  return EMITTERS.has(fn) || UNIQUE_EXTRA.has(fn);
}

/**
 * 功能默认的合成规则：调光与发光体为 HTP，其余为 LTP。
 *
 * @param fn 功能。
 */
export function defaultPrecedence(fn: ChannelFunction): Precedence {
  return fn === "dimmer" || EMITTERS.has(fn) ? "htp" : "ltp";
}

/**
 * 通道对象实际生效的合成规则。
 *
 * @param p 通道对象。
 */
export function effectivePrecedence(p: Pick<FixtureProperty, "function" | "precedence">): Precedence {
  return p.precedence ?? defaultPrecedence(p.function);
}

/**
 * 取某个模式的通道布局。
 *
 * @param model 模型。
 * @param modeId 模式编号；省略或空串为默认模式。
 * @returns 通道布局；模式不存在时为 `null`。
 */
export function layoutOf(
  model: Pick<FixtureModel, "properties" | "modes">,
  modeId?: string | null,
): FixtureProperty[] | null {
  if (!modeId) return model.properties;
  return model.modes?.find((m) => m.id === modeId)?.properties ?? null;
}

/**
 * 像素头数量（单头灯为 0）。
 *
 * @param model 模型。
 */
export function headCount(model: Pick<FixtureModel, "matrix">): number {
  return model.matrix ? model.matrix.cols * model.matrix.rows : 0;
}
