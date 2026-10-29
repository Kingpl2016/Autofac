import { isEmitter, layoutOf } from "./functions";
import type { ChannelFunction, FixtureModel } from "./types";

/**
 * 灯具能力画像：由模型（某个模式）的通道功能推断这台灯“能做什么”。
 * 灯具库、节目编辑器（时间线、检查器、左侧灯具列表）共用。
 */

/** 一项能力。 */
export type FixtureCapability =
  /** 能调亮度（有调光、开关或任何发光体） */
  | "intensity"
  /** 能连续混色（RGB 发光体或 CMY） */
  | "mixing"
  /** 能调色温（色温通道、冷暖白，或可混色近似） */
  | "colorTemp"
  /** 有颜色轮 */
  | "colorWheel"
  /** 能动（Pan / Tilt） */
  | "position"
  /** 有光束类功能（图案、棱镜、雾化、光圈） */
  | "beam"
  /** 有聚焦 / 变焦 */
  | "focus"
  /** 有频闪（快门） */
  | "strobe";

/** 全部能力（显示顺序）。 */
export const FIXTURE_CAPABILITIES: readonly FixtureCapability[] = [
  "intensity",
  "mixing",
  "colorTemp",
  "colorWheel",
  "position",
  "beam",
  "focus",
  "strobe",
];

/** 灯具类型（图标、筛选、默认外观用）。 */
export type FixtureType = "dimmer" | "white" | "mixing" | "mover" | "other";

/** 全部灯具类型（筛选条的显示顺序）。 */
export const FIXTURE_TYPES: readonly FixtureType[] = ["mover", "mixing", "white", "dimmer", "other"];

/** 一台灯具的能力画像。 */
export interface FixtureProfile {
  type: FixtureType;
  caps: ReadonlySet<FixtureCapability>;
}

const BEAM: ReadonlySet<ChannelFunction> = new Set<ChannelFunction>([
  "gobo",
  "goboRotate",
  "goboShake",
  "prism",
  "prismRotate",
  "frost",
  "iris",
  "blade",
  "bladeRotate",
  "rotation",
]);

/**
 * 推断一台灯具（模型的某个模式）的能力。
 *
 * @param model 模型；缺失时视为没有能力。
 * @param modeId 模式；省略时取默认模式。
 * @param head 只看某个像素的通道（像素引用）；省略时看整灯的全部通道。
 *   像素自己没有调光、但整灯有总调光时，像素也算能调亮度（亮度由总调光代管）。
 * @returns 类型与能力。
 */
export function modelProfile(model: FixtureModel | undefined, modeId?: string, head?: number): FixtureProfile {
  const layout = model ? (layoutOf(model, modeId) ?? []) : [];
  const own = head === undefined ? layout : layout.filter((p) => (p.head ?? 0) === head);
  const fns = new Set<ChannelFunction>(own.map((p) => p.function));
  const caps = new Set<FixtureCapability>();
  const has = (...list: ChannelFunction[]) => list.some((f) => fns.has(f));
  const anyEmitter = [...fns].some(isEmitter);
  const masterDimmer = head !== undefined && layout.some((p) => (p.head ?? 0) === 0 && p.function === "dimmer");
  if (anyEmitter || has("dimmer", "switch") || masterDimmer) caps.add("intensity");
  const mixing = has("red", "green", "blue") || has("cyan", "magenta", "yellow");
  if (mixing) caps.add("mixing");
  if (mixing || has("colorTemp") || (has("coolWhite") && has("warmWhite"))) caps.add("colorTemp");
  if (has("colorWheel")) caps.add("colorWheel");
  if (has("pan", "tilt")) caps.add("position");
  if ([...fns].some((f) => BEAM.has(f))) caps.add("beam");
  if (has("focus", "zoom")) caps.add("focus");
  if (has("shutter")) caps.add("strobe");

  let type: FixtureType = "other";
  if (caps.has("position")) type = "mover";
  else if (mixing || caps.has("colorWheel")) type = "mixing";
  else if (caps.has("colorTemp")) type = "white";
  else if (caps.has("intensity")) type = "dimmer";
  return { type, caps };
}

/**
 * 模型的类型：取各模式里能力最强的一个（摇头 > 混色 > 白光 > 调光 > 其它），
 * 避免“基础模式只有调光通道”的摇头灯被归为调光灯。
 *
 * @param model 模型。
 * @returns 类型。
 */
export function modelType(model: FixtureModel): FixtureType {
  const rank: Record<FixtureType, number> = { mover: 4, mixing: 3, white: 2, dimmer: 1, other: 0 };
  // 默认模式（undefined）+ 附加模式
  const modes: (string | undefined)[] = [undefined, ...(model.modes ?? []).map((m) => m.id)];
  let best: FixtureType = "other";
  for (const id of modes) {
    const t = modelProfile(model, id).type;
    if (rank[t] > rank[best]) best = t;
  }
  return best;
}
