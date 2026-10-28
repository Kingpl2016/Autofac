import { z } from "zod";

import builtinFile from "./builtinEffects.json";
import { addLookCue } from "./cueOps";
import { periodMs } from "./effects";
import type { FixtureCapability } from "./fixtureProfile";
import { trackFixtureIds } from "./ops";
import type { AttrKey, ColorValue, EffectCue, Keyframe, Look, Param, Rgb, ShowProject, Spread, Tempo, WaveShape } from "./project";

/**
 * 特效库：声明式的属性特效定义（纯数据，没有脚本），由配置文件加载。
 *
 * 内置特效随软件发布（`builtinEffects.json`），用户特效在数据目录的 `effects.json`（可手改、导入导出，
 * 也可在软件里复制 / 删除）。两者合并，同 `id` 时用户的覆盖内置的。插入时按参数（速度、大小、相位扩散、
 * 分翼、方向、顺序）生成一个外观片段（数值曲线 + 多灯分布），可与别的层叠加、按拍同步。
 *
 * 文件格式（版本 1）：
 *
 * ```json
 * { "version": 1, "effects": [
 *   { "id": "circle", "group": "position", "name": { "zh": "画圆", "en": "Circle" }, "icon": "orbit",
 *     "scale": "fraction", "period": { "kind": "beats", "beats": 4 }, "size": 0.15, "spreadBy": "phase",
 *     "look": { "intensity": { "value": 1 },
 *               "attrs": { "pan": { "shape": "sine", "center": 0.5, "amp": 1 },
 *                          "tilt": { "shape": "sine", "center": 0.5, "amp": 1, "phase": 0.25 } } } }
 * ] }
 * ```
 *
 * 层的写法：
 * - `{ "value": v }`：固定值。强度层 `v` 为 0~1（乘以 100%，`scale` 为 `percent` 时再乘以大小）；属性层为 0~1 的 DMX 分数。
 * - `{ "shape": ..., "center": c, "amp": a }`：在 `c ± a × 大小` 之间变化（属性层用；大小为 0~0.5 的分数）。
 * - `{ "shape": ..., "lo": l, "hi": h }`：在 `l` 与 `h` 之间变化（强度层按上面的倍率换算，属性层为分数）。
 * - 曲线可选 `cycles`（相对周期的倍数）、`phase`（0~1）、`duty`（方波占空比，`"members"` 为 1/成员数）、`once`（整段只走一次）。
 * - 颜色层：`{ "rgb": [r, g, b] }` 固定色，或 `{ "colors": [[r, g, b], ...], "blend": "smooth" | "step" }` 每个周期走一遍。
 * - `spreadBy`：多灯分布方式——`phase`（曲线相位错开）、`hue`（色相错开）、`delay`（时间级联）或 `none`。
 * - `fan`：把某个属性在成员之间展开成扇形（`{ "attr": "pan", "amp": 1 }`）。
 */

/** 文件格式版本。 */
export const EFFECT_FILE_VERSION = 1;

/** 内置分组（显示顺序；用户可以用任意分组名）。 */
export const EFFECT_GROUPS = ["position", "intensity", "color", "beam", "custom"] as const;

/** 新建的用户特效默认放进的分组。 */
export const CUSTOM_EFFECT_GROUP = "custom";

/** 可选图标（界面映射到 lucide 图标；未知名称用默认图标）。 */
export const EFFECT_ICONS = [
  "orbit",
  "infinity",
  "diamond",
  "square",
  "moveHorizontal",
  "moveVertical",
  "fan",
  "shuffle",
  "waves",
  "moveRight",
  "activity",
  "sparkles",
  "sunrise",
  "sunset",
  "zap",
  "rainbow",
  "repeat",
  "palette",
  "blend",
  "zoomIn",
  "aperture",
  "rotateCw",
] as const;

/** 图标名。 */
export type EffectIcon = (typeof EFFECT_ICONS)[number];

/** 数值层。 */
export type EffectLayer =
  | { value: number }
  | {
      shape: WaveShape;
      lo?: number;
      hi?: number;
      center?: number;
      amp?: number;
      cycles?: number;
      phase?: number;
      duty?: number | "members";
      once?: boolean;
    };

/** 颜色层。 */
export type EffectColorLayer = { rgb: Rgb } | { colors: Rgb[]; blend?: "smooth" | "step" };

/** 多灯分布方式。 */
export type SpreadBy = "phase" | "hue" | "delay" | "none";

/** 一个特效定义。 */
export interface EffectDef {
  id: string;
  /** 显示名：一个字符串，或按语言给出 */
  name: string | { zh?: string; en?: string };
  /** 说明 */
  hint?: string | { zh?: string; en?: string };
  group: string;
  icon?: string;
  /** 大小的含义：`fraction` 为 0~0.5 的幅度（位置 / 光束），`percent` 为 0~100% 的亮度 */
  scale: "fraction" | "percent";
  /** 默认周期 */
  period: EffectCue["period"];
  /** 默认大小 */
  size: number;
  /** 默认相位扩散（成员之间错开的周期数，1 为整整错开一圈） */
  spread: number;
  spreadBy: SpreadBy;
  look: {
    intensity?: EffectLayer;
    color?: EffectColorLayer;
    attrs?: Partial<Record<AttrKey, EffectLayer>>;
  };
  /** 静态扇形展开 */
  fan?: { attr: AttrKey; amp: number };
  /** 内置特效（只读；运行时标记，不写进用户文件） */
  builtin?: boolean;
}

const ATTR_KEY_LIST = [
  "pan",
  "tilt",
  "speed",
  "shutter",
  "colorWheel",
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
  "macro",
  "reset",
] as const satisfies readonly AttrKey[];

const byte = z.number().int().min(0).max(255);
const rgb = z.tuple([byte, byte, byte]);
const text = z.string().trim().min(1).max(80);
const localized = z.union([text, z.object({ zh: text.optional(), en: text.optional() }).refine((n) => n.zh || n.en)]);
const longText = z.string().trim().min(1).max(200);
const localizedLong = z.union([longText, z.object({ zh: longText.optional(), en: longText.optional() }).refine((n) => n.zh || n.en)]);
const unit = z.number().min(0).max(1);

const layerSchema = z.union([
  z.object({ value: unit }).strict(),
  z
    .object({
      shape: z.enum(["sine", "triangle", "saw", "square", "ramp", "random"]),
      lo: unit.optional(),
      hi: unit.optional(),
      center: unit.optional(),
      amp: z.number().min(0).max(2).optional(),
      cycles: z.number().min(0.125).max(16).optional(),
      phase: unit.optional(),
      duty: z.union([z.number().min(0.01).max(1), z.literal("members")]).optional(),
      once: z.boolean().optional(),
    })
    .strict(),
]);

const effectSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[\w.-]+$/),
  name: localized,
  hint: localizedLong.optional(),
  group: z.string().trim().min(1).max(32).default(CUSTOM_EFFECT_GROUP),
  icon: z.string().max(32).optional(),
  scale: z.enum(["fraction", "percent"]).default("percent"),
  period: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("beats"), beats: z.number().min(0.125).max(64) }),
    z.object({ kind: z.literal("ms"), ms: z.number().int().min(20).max(600_000) }),
  ]),
  size: z.number().min(0).max(100),
  spread: z.number().min(0).max(4).default(1),
  spreadBy: z.enum(["phase", "hue", "delay", "none"]).default("phase"),
  look: z
    .object({
      intensity: layerSchema.optional(),
      color: z.union([z.object({ rgb }).strict(), z.object({ colors: z.array(rgb).min(1).max(16), blend: z.enum(["smooth", "step"]).optional() }).strict()]).optional(),
      attrs: z.partialRecord(z.enum(ATTR_KEY_LIST), layerSchema).optional(),
    })
    .refine((l) => l.intensity || l.color || (l.attrs && Object.keys(l.attrs).length > 0), "empty look"),
  fan: z.object({ attr: z.enum(ATTR_KEY_LIST), amp: z.number().min(0).max(2) }).optional(),
});

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
 * 解析特效文件：整份结构不对时没有特效；单条不对时跳过那一条并记下原因；`id` 重复时后一条覆盖前一条。
 *
 * @param data 已 `JSON.parse` 的文件内容。
 * @returns 合法的特效与问题列表。
 */
export function parseEffects(data: unknown): EffectParse {
  const root = z.object({ version: z.number().int().optional(), effects: z.array(z.unknown()) }).safeParse(data);
  if (!root.success) return { effects: [], issues: [{ index: null, message: "effects" }] };
  const issues: EffectIssue[] = [];
  if (root.data.version !== undefined && root.data.version > EFFECT_FILE_VERSION) {
    issues.push({ index: null, message: `version ${root.data.version}` });
  }
  const byId = new Map<string, EffectDef>();
  root.data.effects.forEach((raw, i) => {
    const r = effectSchema.safeParse(raw);
    if (!r.success) {
      const first = r.error.issues[0];
      issues.push({ index: i + 1, message: `${first?.path.join(".") || "?"}: ${first?.message ?? ""}`.trim() });
      return;
    }
    const d = r.data;
    const def: EffectDef = {
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
    };
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
 * 序列化成文件内容（去掉运行时标记，缩进两格）。
 *
 * @param effects 特效。
 * @returns JSON 文本。
 */
export function serializeEffects(effects: readonly EffectDef[]): string {
  const clean = effects.map(({ builtin: _b, ...e }) => {
    void _b;
    return e;
  });
  return `${JSON.stringify({ version: EFFECT_FILE_VERSION, effects: clean }, null, 2)}\n`;
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

/** 插入特效的参数（参数面板）。 */
export interface EffectParams {
  /** 一个周期：毫秒，或按 BPM 的拍数 */
  period: EffectCue["period"];
  /** 大小（`fraction`：0~0.5；`percent`：0~100） */
  size: number;
  /** 相位扩散（成员之间错开的周期数） */
  spread: number;
  /** 分翼数（1 为不分翼） */
  wings: number;
  /** 方向：1 正向、-1 反向 */
  direction: 1 | -1;
  /** 成员顺序来源 */
  order: "members" | "stageX" | "stageY";
}

/** 分翼数上限。 */
export const MAX_WINGS = 4;

/**
 * 特效的默认参数。
 *
 * @param def 特效。
 * @returns 参数。
 */
export function defaultEffectParams(def: EffectDef): EffectParams {
  return { period: def.period, size: def.size, spread: def.spread, wings: 1, direction: 1, order: "members" };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000 + 0;

/** 片段内的循环次数（引擎要求不少于 1）。 */
function cyclesFor(lengthMs: number, period: EffectCue["period"], tempo: Tempo | null): number {
  return Math.max(1, Math.round((lengthMs / periodMs(period, tempo)) * 100) / 100);
}

/** 颜色层 → 关键帧（每个周期走一遍；关键帧最多 60 圈）。 */
function colorKeys(colors: readonly Rgb[], smooth: boolean, lengthMs: number, cycles: number): Keyframe<ColorValue>[] {
  const keys: Keyframe<ColorValue>[] = [];
  const period = lengthMs / cycles;
  const loops = Math.min(60, Math.ceil(cycles));
  const curve = smooth ? "linear" : "hold";
  for (let c = 0; c < loops; c += 1) {
    colors.forEach((rgb, i) => {
      const t = Math.round(c * period + (i * period) / colors.length);
      if (t <= lengthMs && !keys.some((k) => k.tMs === t)) keys.push({ tMs: t, value: { kind: "rgb", rgb: [...rgb] }, curve });
    });
  }
  const end = Math.round(Math.min(lengthMs, loops * period));
  if (smooth && !keys.some((k) => k.tMs === end)) keys.push({ tMs: end, value: { kind: "rgb", rgb: [...colors[0]] }, curve });
  return keys;
}

/**
 * 按参数生成特效的外观与多灯分布。
 *
 * @param def 特效。
 * @param params 参数。
 * @param ctx 片段长度（毫秒）、轨道成员数、工程节拍（按拍的周期用）。
 * @returns 外观与分布（成员不足 2 台时没有分布）。
 */
export function buildEffectLook(
  def: EffectDef,
  params: EffectParams,
  ctx: { lengthMs: number; members: number; tempo: Tempo | null },
): { look: Look; spread?: Spread } {
  const cycles = cyclesFor(ctx.lengthMs, params.period, ctx.tempo);
  const n = Math.max(1, Math.floor(ctx.members));
  const percent = def.scale === "percent";
  const size = percent ? Math.min(100, Math.max(0, params.size)) : Math.min(0.5, Math.max(0, params.size));
  // 强度层的倍率（%）与属性层“center ± amp × 大小”里的大小（分数）
  const intensityScale = percent ? size : 100;
  const unit = percent ? size / 200 : size;

  const layer = (spec: EffectLayer, kind: "intensity" | "attr"): Param<number> => {
    const scaleValue = (v: number) => (kind === "intensity" ? round4(v * intensityScale) : round4(clamp01(v)));
    if ("value" in spec) return { kind: "value", value: scaleValue(spec.value) };
    let from: number;
    let to: number;
    if (spec.center !== undefined) {
      const amp = spec.amp ?? 1;
      const lo = clamp01(spec.center - amp * unit);
      const hi = clamp01(spec.center + amp * unit);
      [from, to] = kind === "intensity" ? [round4(lo * 100), round4(hi * 100)] : [round4(lo), round4(hi)];
    } else {
      from = scaleValue(spec.lo ?? 0);
      to = scaleValue(spec.hi ?? 1);
    }
    const duty = spec.duty === "members" ? round4(1 / n) : spec.duty;
    return {
      kind: "curve",
      curve: {
        shape: spec.shape,
        from,
        to,
        cycles: spec.once ? 1 : Math.min(1000, round4(cycles * (spec.cycles ?? 1))),
        phase: spec.phase ?? 0,
        ...(duty !== undefined ? { duty } : {}),
      },
    };
  };

  const look: Look = {};
  if (def.look.intensity) look.intensity = layer(def.look.intensity, "intensity");
  if (def.look.color) {
    const c = def.look.color;
    look.color =
      "rgb" in c
        ? { kind: "value", value: { kind: "rgb", rgb: [...c.rgb] } }
        : { kind: "keys", keys: colorKeys(c.colors, c.blend !== "step", ctx.lengthMs, cycles) };
  }
  for (const [key, spec] of Object.entries(def.look.attrs ?? {}) as [AttrKey, EffectLayer][]) {
    look.attrs = { ...look.attrs, [key]: layer(spec, "attr") };
  }

  if (n < 2) return { look };
  const span = (params.spread * (n - 1)) / n;
  const dir = params.direction;
  const spread: Spread = {};
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
  return Object.keys(spread).length > 0 ? { look, spread } : { look };
}

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
  const { builtin: _b, ...rest } = structuredClone(source);
  void _b;
  const created: EffectDef = { ...rest, id: uniqueEffectId([...all, ...user]), name, group: CUSTOM_EFFECT_GROUP };
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
    const { builtin: _b, ...rest } = e;
    void _b;
    byId.set(e.id, rest);
  }
  return { next: [...byId.values()], added, replaced };
}

/** 新建属性特效片段的默认长度（毫秒）。 */
export const EFFECT_CLIP_MS = 8000;

/**
 * 在轨道上新建一个属性特效片段：按参数生成外观，按轨道成员数展开分布。
 *
 * @param draft 工程草稿。
 * @param trackId 轨道。
 * @param timeMs 片段起点（毫秒）。
 * @param def 特效。
 * @param params 参数（参数面板里的当前值）。
 * @returns 新片段 id；轨道不存在或放不下时为 `null`。
 */
export function addEffectDefCue(draft: ShowProject, trackId: string, timeMs: number, def: EffectDef, params: EffectParams): string | null {
  const track = draft.tracks.find((tr) => tr.id === trackId);
  if (!track) return null;
  const { look, spread } = buildEffectLook(def, params, {
    lengthMs: EFFECT_CLIP_MS,
    members: trackFixtureIds(draft, track).length,
    tempo: draft.tempo,
  });
  return addLookCue(draft, trackId, timeMs, look, EFFECT_CLIP_MS, spread);
}
