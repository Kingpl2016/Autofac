import { clamp, clamp01 } from "@/shared/lib/math";
import builtinFile from "./builtinEffects.json";
import { addLookCue } from "./cueOps";
import {
  EFFECT_FILE_VERSION,
  effectParamsSchema,
  effectSchema,
  MAX_BLOCKS,
  MAX_WINGS,
  type EffectColorLayer,
  type EffectDef,
  type EffectLayer,
  type EffectParamDecl,
  type EffectParams,
  type ParamValue,
} from "./effectDefSchema";
import { periodMs } from "./effects";
import type { FixtureCapability } from "./fixtureProfile";
import { trackFixtureIds } from "./ops";
import type {
  AttrKey,
  ColorBlend,
  ColorParam,
  EffectCue,
  Look,
  LookClip,
  Param,
  Period,
  Rgb,
  ShowProject,
  Spread,
  Tempo,
  ValueCurve,
  WaveShape,
} from "./project";

export { MAX_WINGS } from "./effectDefSchema";
export type { EffectDef, EffectParamDecl, EffectParams, ParamValue } from "./effectDefSchema";

/**
 * 特效库：声明式的属性特效定义（纯数据，没有脚本），由配置文件加载。
 *
 * 内置特效随软件发布（`builtinEffects.json`），用户特效在数据目录的 `effects.json`（可手改、导入导出，
 * 也可在软件里复制 / 删除）。两者合并，同 `id` 时用户的覆盖内置的。插入时按参数（速度、大小、相位扩散、
 * 分翼、方向、顺序、成块 / 分组 / 打乱、按拍对齐，以及特效自己声明的可调参数）生成一个外观片段
 * （数值曲线 / 颜色序列 + 多灯分布），可与别的层叠加、按拍同步。
 *
 * 片段里保存一份特效快照（`LookClip.fx`：定义 + 参数），插入后仍可在 Cue 属性里改参数（重新生成外观）。
 * 周期按时间计（毫秒或拍），拉长片段不会改变速度。
 *
 * 文件格式（版本 2；版本 1 的文件照常读取）：
 *
 * ```json
 * { "version": 2, "effects": [
 *   { "id": "sparkle", "group": "intensity", "name": { "zh": "闪烁", "en": "Sparkle" }, "scale": "percent",
 *     "period": { "kind": "ms", "ms": 120 }, "size": 100, "spread": 0, "spreadBy": "none",
 *     "params": [{ "id": "density", "type": "percent", "default": 0.3, "label": { "zh": "密度" } },
 *                { "id": "color", "type": "color", "default": [255, 255, 255] }],
 *     "look": { "intensity": { "shape": "random", "lo": 0, "hi": 1, "duty": "$density", "seed": true },
 *               "color": { "rgb": "$color" } } }
 * ] }
 * ```
 *
 * 层的写法：
 * - `{ "value": v }`：固定值。强度层 `v` 为 0~1（乘以 100%，`scale` 为 `percent` 时再乘以大小）；属性层为 0~1 的 DMX 分数。
 * - `{ "shape": ..., "center": c, "amp": a }`：在 `c ± a × 大小` 之间变化（属性层用；大小为 0~0.5 的分数）。
 * - `{ "shape": ..., "lo": l, "hi": h }`：在 `l` 与 `h` 之间变化（强度层按上面的倍率换算，属性层为分数）。
 * - 曲线可选 `cycles`（相对周期的倍数）、`phase`（0~1）、`duty`（方波占空比 / 随机的点亮密度，`"members"` 为 1/成员数）、
 *   `once`（整段只走一次）、`transition`、`ease`、`steps`（步进波形的每一步）、`seed`（随机每台灯不同）。
 * - 颜色层：`{ "rgb": [r, g, b] }` 固定色，或 `{ "colors": [[r, g, b], ...], "blend": "smooth" | "step" | "hue" }` 每个周期走一遍。
 * - 数值、形状、颜色都可以写成 `"$参数名"`，引用 `params` 里声明的可调参数。
 * - `spreadBy`：多灯分布方式——`phase`（相位错开，颜色序列也错开）、`hue`（色相错开）、`delay`（时间级联）或 `none`。
 * - `fan`：把某个属性在成员之间展开成扇形（`{ "attr": "pan", "amp": 1 }`）。
 */

export { EFFECT_FILE_VERSION };

/** 内置分组（显示顺序；用户可以用任意分组名）。 */
export const EFFECT_GROUPS = ["position", "intensity", "color", "beam", "custom"] as const;

/** 新建的用户特效默认放进的分组。 */
export const CUSTOM_EFFECT_GROUP = "custom";

/** 解析出的一处问题（第几条、哪里不对）。 */
export interface EffectIssue {
  /** 第几条（从 1 起）；整份文件的问题为 `null` */
  index: number | null;
  message: string;
}

/** 解析结果。 */
export interface EffectParse {
  effects: EffectDef[];
  issues: EffectIssue[];
}

/**
 * 把校验通过的数据整理成特效定义（去掉空的可选字段；幅度类的大小夹到 0.5）。
 *
 * @param d 校验通过的数据。
 * @returns 特效定义。
 */
function toDef(d: ReturnType<typeof effectSchema.parse>): EffectDef {
  return {
    id: d.id,
    name: d.name,
    group: d.group,
    scale: d.scale,
    period: d.period,
    size: d.scale === "fraction" ? Math.min(0.5, d.size) : d.size,
    spread: d.spread,
    spreadBy: d.spreadBy,
    look: d.look as EffectDef["look"],
    ...(d.hint ? { hint: d.hint } : {}),
    ...(d.icon ? { icon: d.icon } : {}),
    ...(d.fan ? { fan: d.fan } : {}),
    ...(d.params && d.params.length > 0 ? { params: d.params as EffectParamDecl[] } : {}),
  };
}

/**
 * 解析特效文件：整份结构不对时没有特效；单条不对时跳过那一条并记下原因；`id` 重复时后一条覆盖前一条。
 *
 * @param data 已 `JSON.parse` 的文件内容。
 * @returns 合法的特效与问题列表。
 */
export function parseEffects(data: unknown): EffectParse {
  if (typeof data !== "object" || data === null || !Array.isArray((data as { effects?: unknown }).effects)) {
    return { effects: [], issues: [{ index: null, message: "effects" }] };
  }
  const root = data as { version?: unknown; effects: unknown[] };
  const issues: EffectIssue[] = [];
  if (typeof root.version === "number" && root.version > EFFECT_FILE_VERSION) {
    issues.push({ index: null, message: `version ${root.version}` });
  }
  const byId = new Map<string, EffectDef>();
  root.effects.forEach((raw, i) => {
    const r = effectSchema.safeParse(raw);
    if (!r.success) {
      const first = r.error.issues[0];
      issues.push({ index: i + 1, message: `${first?.path.join(".") || "?"}: ${first?.message ?? ""}`.trim() });
      return;
    }
    const def = toDef(r.data);
    byId.set(def.id, def);
  });
  return { effects: [...byId.values()], issues };
}

/**
 * 解析文件文本。
 *
 * @param text 文件内容。
 * @returns 解析结果；不是 JSON 时没有特效并记一条问题。
 */
export function parseEffectText(text: string): EffectParse {
  try {
    return parseEffects(JSON.parse(text));
  } catch {
    return { effects: [], issues: [{ index: null, message: "json" }] };
  }
}

/**
 * 去掉运行时标记（`builtin`）。
 *
 * @param def 特效。
 * @returns 新对象（深拷贝）。
 */
function stripBuiltin(def: EffectDef): EffectDef {
  const { builtin: _b, ...rest } = structuredClone(def);
  void _b;
  return rest;
}

/**
 * 序列化成文件内容（去掉运行时标记，缩进两格）。
 *
 * @param effects 特效。
 * @returns JSON 文本。
 */
export function serializeEffects(effects: readonly EffectDef[]): string {
  return `${JSON.stringify({ version: EFFECT_FILE_VERSION, effects: effects.map(stripBuiltin) }, null, 2)}\n`;
}

/** 内置特效（随软件发布，只读）。 */
export const BUILTIN_EFFECTS: readonly EffectDef[] = parseEffects(builtinFile).effects.map((e) => ({ ...e, builtin: true }));

/**
 * 内置 + 用户特效合并：同 `id` 时用户的覆盖内置的（位置保持在内置的位置），其余用户特效接在后面。
 *
 * @param builtin 内置特效。
 * @param user 用户特效。
 * @returns 合并后的列表。
 */
export function mergeEffects(builtin: readonly EffectDef[], user: readonly EffectDef[]): EffectDef[] {
  const userById = new Map(user.map((e) => [e.id, e]));
  const ids = new Set(builtin.map((e) => e.id));
  return [...builtin.map((e) => userById.get(e.id) ?? e), ...user.filter((e) => !ids.has(e.id))];
}

/**
 * 按分组排列：内置分组在前，用户自建的分组按出现顺序接在后面，“我的”放最后。
 *
 * @param effects 特效。
 * @returns 分组与组内特效（空分组不出现）。
 */
export function groupEffects(effects: readonly EffectDef[]): { group: string; effects: EffectDef[] }[] {
  const order: string[] = EFFECT_GROUPS.filter((g) => g !== CUSTOM_EFFECT_GROUP);
  for (const e of effects) if (!order.includes(e.group) && e.group !== CUSTOM_EFFECT_GROUP) order.push(e.group);
  order.push(CUSTOM_EFFECT_GROUP);
  return order.map((group) => ({ group, effects: effects.filter((e) => e.group === group) })).filter((g) => g.effects.length > 0);
}

/**
 * 按界面语言取文字。
 *
 * @param value 一个字符串或按语言给出的文字。
 * @param lang 界面语言（`zh` / `en`，其它按 `en`）。
 * @returns 文字；都缺时为空串。
 */
export function localizedText(value: string | { zh?: string; en?: string } | undefined, lang: string): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return (lang.startsWith("zh") ? (value.zh ?? value.en) : (value.en ?? value.zh)) ?? "";
}

/**
 * 特效的显示名。
 *
 * @param def 特效。
 * @param lang 界面语言。
 * @returns 名称；缺失时为 `id`。
 */
export function effectName(def: Pick<EffectDef, "name" | "id">, lang: string): string {
  return localizedText(def.name, lang) || def.id;
}

/** 位置属性（需要 Pan / Tilt）。 */
const POSITION_ATTRS: ReadonlySet<AttrKey> = new Set<AttrKey>(["pan", "tilt"]);
/** 聚焦类属性。 */
const FOCUS_ATTRS: ReadonlySet<AttrKey> = new Set<AttrKey>(["focus", "zoom"]);

/**
 * 特效需要的能力（取最“挑灯”的一层：位置 > 混色 > 聚焦 > 光束 > 强度）。
 *
 * @param def 特效。
 * @returns 能力。
 */
export function effectDefNeeds(def: Pick<EffectDef, "look" | "fan">): FixtureCapability {
  const attrs = [...Object.keys(def.look.attrs ?? {}), ...(def.fan ? [def.fan.attr] : [])] as AttrKey[];
  if (attrs.some((a) => POSITION_ATTRS.has(a))) return "position";
  if (def.look.color) return "mixing";
  if (attrs.some((a) => FOCUS_ATTRS.has(a))) return "focus";
  if (attrs.length > 0) return "beam";
  return "intensity";
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/**
 * 特效的默认参数。
 *
 * @param def 特效。
 * @returns 参数（可调参数取声明里的默认值，不写进 `values`）。
 */
export function defaultEffectParams(def: EffectDef): EffectParams {
  return { period: def.period, size: def.size, spread: def.spread, wings: 1, direction: 1, order: "members" };
}

/**
 * 规整参数：不合法的字段回到特效的默认值，数值夹在允许范围内，可调参数只保留声明过且类型对的值。
 *
 * @param def 特效。
 * @param raw 参数（可能来自旧版本的偏好或文件）。
 * @returns 合法的参数。
 */
export function sanitizeEffectParams(def: EffectDef, raw: unknown): EffectParams {
  const base = defaultEffectParams(def);
  const parsed = effectParamsSchema.safeParse(raw);
  if (!parsed.success) return base;
  const p = parsed.data as EffectParams;
  const values: Record<string, ParamValue> = {};
  for (const d of def.params ?? []) {
    const v = p.values?.[d.id];
    if (v !== undefined && valueFits(d, v)) values[d.id] = structuredClone(v);
  }
  const out: EffectParams = { ...p, size: def.scale === "fraction" ? Math.min(0.5, p.size) : p.size };
  if (Object.keys(values).length > 0) out.values = values;
  else delete out.values;
  return out;
}

/**
 * 合并参数修改：`values` 与已有的可调参数值合并，值为 `undefined` 的可选字段删除，结果再规整。
 *
 * @param def 特效。
 * @param params 当前参数。
 * @param patch 修改。
 * @returns 新参数。
 */
export function mergeEffectParams(def: EffectDef, params: EffectParams, patch: Partial<EffectParams>): EffectParams {
  const merged: Partial<EffectParams> = { ...params, ...patch, values: { ...params.values, ...patch.values } };
  for (const k of Object.keys(merged) as (keyof EffectParams)[]) if (merged[k] === undefined) delete merged[k];
  return sanitizeEffectParams(def, merged);
}

/** 值是否符合参数声明的类型与范围。 */
function valueFits(d: EffectParamDecl, v: ParamValue): boolean {
  const isRgb = (x: unknown): x is Rgb => Array.isArray(x) && x.length === 3 && x.every((c) => typeof c === "number" && c >= 0 && c <= 255);
  switch (d.type) {
    case "number":
      return typeof v === "number" && v >= d.min && v <= d.max;
    case "percent":
      return typeof v === "number" && v >= 0 && v <= 1;
    case "color":
      return isRgb(v);
    case "colors":
      return Array.isArray(v) && v.length >= (d.min ?? 1) && v.length <= (d.max ?? 16) && (v as unknown[]).every(isRgb);
    case "choice":
      return typeof v === "string" && d.options.some((o) => o.value === v);
    case "boolean":
      return typeof v === "boolean";
  }
}

/**
 * 一个可调参数的当前值（参数里没有时取声明里的默认值）。
 *
 * @param def 特效。
 * @param params 参数。
 * @param id 参数 `id`。
 * @returns 值；没有这个参数时为 `undefined`。
 */
export function effectParamValue(def: EffectDef, params: EffectParams, id: string): ParamValue | undefined {
  const d = def.params?.find((x) => x.id === id);
  if (!d) return undefined;
  const v = params.values?.[id];
  return v !== undefined && valueFits(d, v) ? v : d.default;
}

/** 特效里是否有每台灯不同的随机层（插入面板显示“换一组”）。 */
export function effectHasSeed(def: Pick<EffectDef, "look">): boolean {
  const layers: EffectLayer[] = [...(def.look.intensity ? [def.look.intensity] : []), ...Object.values(def.look.attrs ?? {})];
  return layers.some((l) => "shape" in l && l.seed === true);
}

/**
 * 稳定的 32 位种子（FNV-1a）：同一特效的同一层每次插入相同，与“换一组”的变化量混合。
 *
 * @param key 特效 `id` 与层名。
 * @param extra 变化量。
 * @returns 种子。
 */
function seedFor(key: string, extra = 0): number {
  let h = 0x811c_9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x0100_0193);
  }
  return (h ^ Math.imul(extra >>> 0, 0x9e37_79b1)) >>> 0;
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000 + 0;

/** 周期按倍数加速（倍数 2 = 周期减半），夹在允许范围内。 */
function scalePeriod(period: Period, mult: number): Period {
  const m = mult > 0 && Number.isFinite(mult) ? mult : 1;
  return period.kind === "ms"
    ? { kind: "ms", ms: clamp(Math.round(period.ms / m), 20, 600_000) }
    : { kind: "beats", beats: clamp(round4(period.beats / m), 0.0625, 128) };
}

/**
 * 按参数生成特效的外观与多灯分布。
 *
 * @param def 特效。
 * @param params 参数。
 * @param ctx 轨道成员数、工程节拍（按拍的时间级联用）；`lengthMs` 不再影响结果（周期按时间计），保留兼容。
 * @returns 外观与分布（成员不足 2 台时没有相位 / 色相 / 延迟分布）。
 */
export function buildEffectLook(
  def: EffectDef,
  params: EffectParams,
  ctx: { lengthMs?: number; members: number; tempo: Tempo | null },
): { look: Look; spread?: Spread } {
  const n = Math.max(1, Math.floor(ctx.members));
  const percent = def.scale === "percent";
  const size = percent ? Math.min(100, Math.max(0, params.size)) : Math.min(0.5, Math.max(0, params.size));
  // 强度层的倍率（%）与属性层“center ± amp × 大小”里的大小（分数）
  const intensityScale = percent ? size : 100;
  const unit = percent ? size / 200 : size;
  const value = (id: string) => effectParamValue(def, params, id);
  const num = (v: number | string | undefined): number | undefined => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.startsWith("$")) {
      const x = value(v.slice(1));
      return typeof x === "number" ? x : undefined;
    }
    return undefined;
  };
  const pick = <T extends string>(v: T | string | undefined): T | undefined => {
    if (typeof v !== "string") return undefined;
    if (!v.startsWith("$")) return v as T;
    const x = value(v.slice(1));
    return typeof x === "string" ? (x as T) : undefined;
  };
  const sync = params.sync ? { sync: "beat" as const } : {};

  const layer = (spec: EffectLayer, key: string, kind: "intensity" | "attr"): Param<number> => {
    const scaleValue = (v: number) => (kind === "intensity" ? round4(clamp01(v) * intensityScale) : round4(clamp01(v)));
    if ("value" in spec) return { kind: "value", value: scaleValue(num(spec.value) ?? 0) };
    let from: number;
    let to: number;
    const center = num(spec.center);
    if (center !== undefined) {
      const amp = num(spec.amp) ?? 1;
      const lo = clamp01(center - amp * unit);
      const hi = clamp01(center + amp * unit);
      [from, to] = kind === "intensity" ? [round4(lo * 100), round4(hi * 100)] : [round4(lo), round4(hi)];
    } else {
      from = scaleValue(num(spec.lo) ?? 0);
      to = scaleValue(num(spec.hi) ?? 1);
    }
    const duty = spec.duty === "members" ? round4(1 / n) : num(spec.duty);
    const transition = num(spec.transition);
    const curve: ValueCurve = { shape: pick<WaveShape>(spec.shape) ?? "sine", from, to, cycles: 1, phase: clamp01(num(spec.phase) ?? 0) };
    if (!spec.once) Object.assign(curve, { period: scalePeriod(params.period, num(spec.cycles) ?? 1), ...sync });
    if (duty !== undefined) curve.duty = clamp01(duty);
    if (transition !== undefined && transition < 1) curve.transition = clamp01(transition);
    if (spec.ease) curve.ease = spec.ease;
    if (spec.steps) curve.steps = spec.steps.map(clamp01);
    if (spec.seed) curve.seed = seedFor(`${def.id}:${key}`, params.seed ?? 0);
    return { kind: "curve", curve };
  };

  const colorLayer = (c: EffectColorLayer): ColorParam | undefined => {
    const rgbOf = (v: unknown): Rgb | undefined => (Array.isArray(v) && v.length === 3 ? ([...v] as Rgb) : undefined);
    if ("rgb" in c) {
      const rgb = typeof c.rgb === "string" ? rgbOf(value(c.rgb.slice(1))) : rgbOf(c.rgb);
      return rgb ? { kind: "value", value: { kind: "rgb", rgb } } : undefined;
    }
    const list = typeof c.colors === "string" ? value(c.colors.slice(1)) : c.colors;
    const colors = (Array.isArray(list) ? list : []).map(rgbOf).filter((x) => x !== undefined);
    if (colors.length === 0) return undefined;
    if (colors.length === 1) return { kind: "value", value: { kind: "rgb", rgb: colors[0] } };
    const transition = num(c.transition);
    return {
      kind: "cycle",
      cycle: {
        colors: colors.map((rgb) => ({ kind: "rgb", rgb })),
        blend: pick<ColorBlend>(c.blend) ?? "smooth",
        cycles: 1,
        phase: 0,
        period: params.period,
        ...sync,
        ...(transition !== undefined && transition < 1 ? { transition: clamp01(transition) } : {}),
        ...(c.ease ? { ease: c.ease } : {}),
      },
    };
  };

  const look: Look = {};
  if (def.look.intensity) look.intensity = layer(def.look.intensity, "intensity", "intensity");
  if (def.look.color) {
    const color = colorLayer(def.look.color);
    if (color) look.color = color;
  }
  for (const [key, spec] of Object.entries(def.look.attrs ?? {}) as [AttrKey, EffectLayer][]) {
    look.attrs = { ...look.attrs, [key]: layer(spec, key, "attr") };
  }

  const spread: Spread = {};
  const dir = params.direction;
  if (n >= 2) {
    const span = (params.spread * (n - 1)) / n;
    if (span > 0 && def.spreadBy === "phase") spread.values = { phase: { from: 0, to: round4(-span * dir) } };
    if (span > 0 && def.spreadBy === "hue") spread.values = { hue: { from: 0, to: round4(360 * span * dir) } };
    if (span > 0 && def.spreadBy === "delay") {
      spread.delay = { fromMs: 0, toMs: Math.round(periodMs(params.period, ctx.tempo) * span) };
      if (dir < 0 && params.order === "members") spread.order = "reverse";
    }
    if (def.fan) {
      const a = def.fan.amp * unit;
      const [lo, hi] = [round4(clamp01(0.5 - a)), round4(clamp01(0.5 + a))];
      spread.values = { ...spread.values, [def.fan.attr]: dir > 0 ? { from: lo, to: hi } : { from: hi, to: lo } };
    }
    const wings = Math.min(MAX_WINGS, Math.max(1, Math.floor(params.wings)));
    if (wings > 1) spread.wings = wings;
    if (params.order !== "members") spread.order = params.order;
    const blocks = Math.min(MAX_BLOCKS, Math.max(1, Math.floor(params.blocks ?? 1)));
    if (blocks > 1) spread.blocks = blocks;
    const groups = Math.min(MAX_BLOCKS, Math.max(1, Math.floor(params.groups ?? 1)));
    if (groups > 1) spread.groups = groups;
    if (params.shuffle !== undefined) spread.shuffle = params.shuffle >>> 0;
  }
  return Object.keys(spread).length > 0 ? { look, spread } : { look };
}

// ---------------------------------------------------------------------------
// 用户特效
// ---------------------------------------------------------------------------

/**
 * 生成一个不与已有特效重复的 `id`。
 *
 * @param existing 已有特效。
 * @param base 前缀。
 * @returns 新 `id`。
 */
export function uniqueEffectId(existing: readonly Pick<EffectDef, "id">[], base = "my-effect"): string {
  const ids = new Set(existing.map((e) => e.id));
  for (let n = 1; ; n += 1) {
    const id = `${base}-${n}`;
    if (!ids.has(id)) return id;
  }
}

/**
 * 把一个特效复制为用户特效（放进“我的”分组，名字后加后缀）。
 *
 * @param user 现有用户特效。
 * @param all 全部特效（取不重复的 `id`）。
 * @param source 要复制的特效。
 * @param copySuffix 名字后缀（界面传入本地化的“ 副本”）。
 * @returns 新列表与新特效。
 */
export function copyEffectToUser(
  user: readonly EffectDef[],
  all: readonly EffectDef[],
  source: EffectDef,
  copySuffix: string,
): { next: EffectDef[]; created: EffectDef } {
  const name =
    typeof source.name === "string"
      ? `${source.name}${copySuffix}`
      : {
          ...(source.name.zh ? { zh: `${source.name.zh}${copySuffix}` } : {}),
          ...(source.name.en ? { en: `${source.name.en}${copySuffix}` } : {}),
        };
  const created: EffectDef = { ...stripBuiltin(source), id: uniqueEffectId([...all, ...user]), name, group: CUSTOM_EFFECT_GROUP };
  return { next: [...user, created], created };
}

/**
 * 删除用户特效。
 *
 * @param user 用户特效。
 * @param id 特效。
 * @returns 新列表。
 */
export function removeEffect(user: readonly EffectDef[], id: string): EffectDef[] {
  return user.filter((e) => e.id !== id);
}

/**
 * 新增或替换一个用户特效（特效编辑器保存）。
 *
 * @param user 用户特效。
 * @param def 特效（去掉运行时标记后保存）。
 * @returns 新列表：同 `id` 的原位替换，否则追加。
 */
export function upsertEffect(user: readonly EffectDef[], def: EffectDef): EffectDef[] {
  const clean = stripBuiltin(def);
  return user.some((e) => e.id === def.id) ? user.map((e) => (e.id === def.id ? clean : e)) : [...user, clean];
}

/**
 * 导入：同 `id` 的替换，其余追加。
 *
 * @param user 用户特效。
 * @param imported 文件里解析出的特效。
 * @returns 新列表与新增 / 替换的数量。
 */
export function importEffects(
  user: readonly EffectDef[],
  imported: readonly EffectDef[],
): { next: EffectDef[]; added: number; replaced: number } {
  const byId = new Map(user.map((e) => [e.id, e]));
  let added = 0;
  let replaced = 0;
  for (const e of imported) {
    if (byId.has(e.id)) replaced += 1;
    else added += 1;
    byId.set(e.id, stripBuiltin(e));
  }
  return { next: [...byId.values()], added, replaced };
}

// ---------------------------------------------------------------------------
// 片段
// ---------------------------------------------------------------------------

/** 新建属性特效片段的默认长度（毫秒）。 */
export const EFFECT_CLIP_MS = 8000;

/** 生成外观需要的上下文：轨道成员数与工程节拍。 */
function clipContext(draft: ShowProject, trackId: string): { members: number; tempo: Tempo | null } | null {
  const track = draft.tracks.find((tr) => tr.id === trackId);
  return track ? { members: trackFixtureIds(draft, track).length, tempo: draft.tempo } : null;
}

/**
 * 在轨道上新建一个属性特效片段：按参数生成外观，按轨道成员数展开分布，并在片段里保存特效快照
 * （插入后仍可改参数）。
 *
 * @param draft 工程草稿。
 * @param trackId 轨道。
 * @param timeMs 片段起点（毫秒）。
 * @param def 特效。
 * @param params 参数（参数面板里的当前值）。
 * @param label 片段名称（时间线上显示，通常是界面语言下的特效名）；省略时不写。
 * @param lengthMs 片段长度；省略时为 {@link EFFECT_CLIP_MS}。
 * @returns 新片段 id；轨道不存在或放不下时为 `null`。
 */
export function addEffectDefCue(
  draft: ShowProject,
  trackId: string,
  timeMs: number,
  def: EffectDef,
  params: EffectParams,
  label?: string,
  lengthMs: number = EFFECT_CLIP_MS,
): string | null {
  const ctx = clipContext(draft, trackId);
  if (!ctx) return null;
  const clean = sanitizeEffectParams(def, params);
  const { look, spread } = buildEffectLook(def, clean, ctx);
  const id = addLookCue(draft, trackId, timeMs, look, lengthMs, spread);
  const cue = id ? draft.cues.find((c) => c.id === id) : undefined;
  if (cue?.kind !== "look") return id;
  if (label?.trim()) cue.label = label.trim();
  cue.fx = { def: stripBuiltin(def), params: clean };
  return id;
}

/**
 * 选中片段里共同的特效：都带特效快照且是同一个特效时返回它（参数取第一个片段的）。
 *
 * @param cues 片段。
 * @returns 特效与参数；没有或不一致时为 `null`。
 */
export function commonFx(cues: readonly LookClip[]): NonNullable<LookClip["fx"]> | null {
  const first = cues[0]?.fx;
  if (!first) return null;
  return cues.every((c) => c.fx?.def.id === first.def.id) ? first : null;
}

/**
 * 修改特效片段的参数并重新生成外观与分布（每个片段按自己轨道的成员数）；锁定轨道上的不动。
 *
 * @param draft 工程草稿。
 * @param ids 片段 id（不带特效快照的忽略）。
 * @param patch 要改的参数（`values` 与已有的可调参数值合并）；`"reset"` 为恢复特效的默认参数。
 * @returns 实际被修改的片段数。
 */
export function setFxParams(draft: ShowProject, ids: readonly string[], patch: Partial<EffectParams> | "reset"): number {
  const wanted = new Set(ids);
  let n = 0;
  for (const cue of draft.cues) {
    if (cue.kind !== "look" || !cue.fx || !wanted.has(cue.id)) continue;
    if (draft.tracks.find((t) => t.id === cue.trackId)?.lock) continue;
    const ctx = clipContext(draft, cue.trackId);
    if (!ctx) continue;
    const def = cue.fx.def;
    const params = patch === "reset" ? defaultEffectParams(def) : mergeEffectParams(def, cue.fx.params, patch);
    const { look, spread } = buildEffectLook(def, params, ctx);
    cue.look = look;
    if (spread) cue.spread = spread;
    else delete cue.spread;
    cue.fx = { def, params };
    n += 1;
  }
  return n;
}

/**
 * 把特效片段转为普通外观片段（保留当前外观，删除特效快照；之后可以逐层手动编辑）。
 *
 * @param draft 工程草稿。
 * @param ids 片段 id。
 * @returns 实际被修改的片段数。
 */
export function detachFx(draft: ShowProject, ids: readonly string[]): number {
  const wanted = new Set(ids);
  let n = 0;
  for (const cue of draft.cues) {
    if (cue.kind !== "look" || !cue.fx || !wanted.has(cue.id)) continue;
    if (draft.tracks.find((t) => t.id === cue.trackId)?.lock) continue;
    delete cue.fx;
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 经典颜色特效 → 可配置特效
// ---------------------------------------------------------------------------

/** 经典特效对应的内置特效。 */
const LEGACY_DEFS: Record<EffectCue["effect"], string> = {
  breathe: "breathe",
  rainbow: "rainbow",
  chase: "intensityChase",
  wipe: "wipe",
  gradient: "gradient",
  pulse: "pulse",
  sparkle: "sparkle",
  strobe: "strobe",
};

/**
 * 把经典颜色特效换算成可配置特效（片段保存特效快照，之后可以继续改参数）。
 *
 * 周期、相位扩散、方向原样带过去；亮度范围映射到强度层的起止值；颜色写进特效的颜色参数
 * （没有颜色参数的强度类特效会加上一个“颜色”参数）。相位的推进方向与经典特效的公式不完全相同，是近似。
 *
 * @param cue 经典特效片段。
 * @param defs 可用的特效（通常是内置特效）。
 * @returns 特效与参数；找不到对应的特效时为 `null`。
 */
export function legacyEffectFx(cue: EffectCue, defs: readonly EffectDef[] = BUILTIN_EFFECTS): NonNullable<LookClip["fx"]> | null {
  const source = defs.find((d) => d.id === LEGACY_DEFS[cue.effect]);
  if (!source) return null;
  const def = stripBuiltin(source);
  const [lo, hi] = [Math.min(...cue.range) / 100, Math.max(...cue.range) / 100];
  const intensity = def.look.intensity;
  if (intensity && "shape" in intensity && !intensity.center) {
    // 脉冲是从亮到暗（lo > hi），保持方向
    const falling = typeof intensity.lo === "number" && typeof intensity.hi === "number" && intensity.lo > intensity.hi;
    def.look.intensity = { ...intensity, lo: round4(falling ? hi : lo), hi: round4(falling ? lo : hi) };
  } else if (intensity && "value" in intensity) {
    def.look.intensity = { value: round4(hi) };
  }
  const values: Record<string, ParamValue> = {};
  const decls = def.params ?? [];
  const colorDecl = decls.find((d) => d.type === "color");
  const colorsDecl = decls.find((d): d is Extract<EffectParamDecl, { type: "colors" }> => d.type === "colors");
  if (colorsDecl && cue.colors.length > 0) {
    // 颜色不够参数要求的数量时补黑（例如单色的擦除：亮色扫过、其余熄灭）
    const list = cue.colors.map((c) => [...c] as Rgb);
    while (list.length < (colorsDecl.min ?? 1)) list.push([0, 0, 0]);
    values[colorsDecl.id] = list;
  } else if (colorDecl && cue.colors[0]) values[colorDecl.id] = [...cue.colors[0]] as Rgb;
  else if (!def.look.color && cue.colors[0]) {
    def.params = [...decls, { id: "color", type: "color", default: [255, 255, 255], label: { zh: "颜色", en: "Color" } }];
    def.look.color = { rgb: "$color" };
    values.color = [...cue.colors[0]] as Rgb;
  }
  const background = decls.find((d) => d.type === "color" && d.id !== colorDecl?.id);
  if (background && cue.colors[1]) values[background.id] = [...cue.colors[1]] as Rgb;
  const params: EffectParams = {
    period: cue.period,
    size: def.scale === "fraction" ? def.size : 100,
    spread: cue.phaseSpread,
    wings: 1,
    direction: cue.direction < 0 ? -1 : 1,
    order: "members",
    ...(Object.keys(values).length > 0 ? { values } : {}),
  };
  return { def, params: sanitizeEffectParams(def, params) };
}

/**
 * 把经典颜色特效片段原地换成可配置特效片段（时间、亮度、淡入淡出、禁用与标签保持不变）。
 *
 * @param draft 工程草稿。
 * @param ids 片段 id（非经典特效忽略）。
 * @param label 按特效取片段名称（界面语言）。
 * @returns 实际转换的片段数。
 */
export function convertLegacyEffects(draft: ShowProject, ids: readonly string[], label?: (def: EffectDef) => string): number {
  const wanted = new Set(ids);
  let n = 0;
  draft.cues = draft.cues.map((cue) => {
    if (cue.kind !== "effect" || !wanted.has(cue.id)) return cue;
    if (draft.tracks.find((t) => t.id === cue.trackId)?.lock) return cue;
    const fx = legacyEffectFx(cue);
    const ctx = clipContext(draft, cue.trackId);
    if (!fx || !ctx) return cue;
    const { look, spread } = buildEffectLook(fx.def, fx.params, ctx);
    const { effect: _e, colors: _c, period: _p, phaseSpread: _s, direction: _d, range: _r, seed: _seed, ...base } = cue;
    void [_e, _c, _p, _s, _d, _r, _seed];
    n += 1;
    const next: LookClip = { ...base, kind: "look", look, fx, ...(spread ? { spread } : {}) };
    const name = label?.(fx.def);
    if (name) next.label = name;
    return next;
  });
  return n;
}
