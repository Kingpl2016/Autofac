import { groupOf, layoutOf, type AttributeGroup, type Capability, type ChannelFunction, type FixtureModel } from "@/features/fixtures";
import type { AttrKey, Look, Spread, SpreadKey } from "./project";

/**
 * 分层属性（剪映的“属性面板”在灯光里的对应）：外观按属性组（强度 / 颜色 / 位置 / 光束 / 聚焦 / 控制）分区，
 * 每个属性是一层，可以单独加、删、打关键帧，也可以有选择地复制粘贴到别的片段。
 */

/** 外观里可以作为属性层的键（与 `AttrKey` 一致，按功能表顺序）。 */
export const ATTR_KEYS: readonly AttrKey[] = [
  "pan",
  "tilt",
  "speed",
  "shutter",
  "colorWheel",
  "colorWheelRotate",
  "cyan",
  "magenta",
  "yellow",
  "colorTemp",
  "gobo",
  "goboRotate",
  "goboShake",
  "prism",
  "prismRotate",
  "frost",
  "focus",
  "zoom",
  "iris",
  "blade",
  "bladeRotate",
  "rotation",
  "macro",
  "reset",
  "fog",
  "effectSpeed",
  "maintenance",
];

/**
 * 属性层所属的属性组。
 *
 * @param key 属性。
 * @returns 属性组。
 */
export function attrGroup(key: AttrKey): AttributeGroup {
  return groupOf(key as ChannelFunction);
}

/** 一个可编辑的属性层（模型里有这个功能）。 */
export interface AttrInfo {
  key: AttrKey;
  group: AttributeGroup;
  /** 通道对象名 */
  name: string;
  /** 能力区间（颜色轮槽位、图案…），没有时为空 */
  capabilities: readonly Capability[];
  /** 通道满值（255 或 65535），把能力区间换算成 0~1 */
  max: number;
}

/**
 * 灯具模型（某个模式）里能作为属性层编辑的功能。
 *
 * @param model 模型。
 * @param modeId 模式。
 * @returns 按功能表顺序的属性（同一功能只列一次，整灯优先）。
 */
export function availableAttrs(model: FixtureModel | undefined, modeId?: string): AttrInfo[] {
  if (!model) return [];
  const layout = [...(layoutOf(model, modeId) ?? [])].sort((a, b) => (a.head ?? 0) - (b.head ?? 0));
  const out: AttrInfo[] = [];
  for (const key of ATTR_KEYS) {
    const p = layout.find((x) => x.function === key);
    if (!p) continue;
    out.push({
      key,
      group: attrGroup(key),
      name: p.name,
      capabilities: p.capabilities ?? [],
      max: p.width === 2 ? 65535 : 255,
    });
  }
  return out;
}

/**
 * 能力区间的中点（选中一个槽位 / 图案时写入的值）。
 *
 * @param cap 能力区间。
 * @param max 通道满值。
 * @returns 0~1。
 */
export function capabilityValue(cap: Capability, max: number): number {
  return (cap.range[0] + cap.range[1]) / 2 / max;
}

/**
 * 取值落在哪个能力区间里。
 *
 * @param caps 能力区间。
 * @param fraction 0~1。
 * @param max 通道满值。
 * @returns 下标；不在任何区间时为 `-1`。
 */
export function capabilityAt(caps: readonly Capability[], fraction: number, max: number): number {
  const dmx = Math.round(fraction * max);
  return caps.findIndex((c) => dmx >= c.range[0] && dmx <= c.range[1]);
}

/** 可选择性复制的层组：强度、颜色，以及各属性组。 */
export type LayerGroup = AttributeGroup;

/**
 * 外观里出现了哪些层组。
 *
 * @param look 外观。
 * @returns 层组（按属性组顺序）。
 */
export function layerGroupsOf(look: Look): LayerGroup[] {
  const groups = new Set<LayerGroup>();
  if (look.intensity) groups.add("intensity");
  if (look.color) groups.add("color");
  for (const key of Object.keys(look.attrs ?? {}) as AttrKey[]) groups.add(attrGroup(key));
  const order: LayerGroup[] = ["intensity", "color", "position", "beam", "focus", "control"];
  return order.filter((g) => groups.has(g));
}

/**
 * 从外观里挑出若干层组（选择性复制）。
 *
 * 注意：强度组只取强度层（快门 / 频闪属性按其功能所属组计入）；颜色组包含颜色层和颜色类属性（颜色轮、CMY、色温通道）。
 *
 * @param look 外观。
 * @param groups 要的层组。
 * @returns 新外观（深拷贝，不含预设引用）。
 */
export function pickLayers(look: Look, groups: ReadonlySet<LayerGroup>): Look {
  const out: Look = {};
  if (groups.has("intensity") && look.intensity) out.intensity = structuredClone(look.intensity);
  if (groups.has("color") && look.color) out.color = structuredClone(look.color);
  const attrs: NonNullable<Look["attrs"]> = {};
  for (const [key, p] of Object.entries(look.attrs ?? {}) as [AttrKey, NonNullable<Look["attrs"]>[AttrKey]][]) {
    if (p && groups.has(attrGroup(key))) attrs[key] = structuredClone(p);
  }
  if (Object.keys(attrs).length > 0) out.attrs = attrs;
  return out;
}

/**
 * 把 `source` 的层叠到 `target` 上（同名层被覆盖，其它层保留）。在草稿上原地修改。
 *
 * @param target 目标外观（草稿）。
 * @param source 来源外观。
 */
export function mergeLayers(target: Look, source: Look): void {
  if (source.intensity) target.intensity = structuredClone(source.intensity);
  if (source.color) target.color = structuredClone(source.color);
  if (source.attrs && Object.keys(source.attrs).length > 0) {
    target.attrs = { ...target.attrs, ...structuredClone(source.attrs) };
  }
}

/**
 * 分布里“值”的可选键：强度、色相偏移、相位偏移（外观里有数值曲线时），以及外观里的属性。
 *
 * @param look 外观。
 * @returns 可选键。
 */
export function spreadKeysOf(look: Look): SpreadKey[] {
  const hasCurve = look.intensity?.kind === "curve" || Object.values(look.attrs ?? {}).some((p) => p?.kind === "curve");
  return ["intensity", "hue", ...(hasCurve ? (["phase"] as const) : []), ...(Object.keys(look.attrs ?? {}) as AttrKey[])];
}

/**
 * 规整分布设置：去掉空的部分（全空时为 `undefined`，即不分布）。
 *
 * @param spread 分布。
 * @returns 规整后的分布。
 */
export function normalizeSpread(spread: Spread | undefined): Spread | undefined {
  if (!spread) return undefined;
  const out: Spread = {};
  if (spread.order && spread.order !== "members") out.order = spread.order;
  if (spread.wings && spread.wings > 1) out.wings = Math.min(64, Math.round(spread.wings));
  const values = Object.fromEntries(Object.entries(spread.values ?? {}).filter(([, v]) => v !== undefined));
  if (Object.keys(values).length > 0) out.values = values;
  if (spread.delay && (spread.delay.fromMs !== 0 || spread.delay.toMs !== 0)) out.delay = spread.delay;
  return Object.keys(out).length > 0 ? out : undefined;
}
