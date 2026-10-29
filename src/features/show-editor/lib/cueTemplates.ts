import { z } from "zod";

import builtinFile from "./builtinCueTemplates.json";
import { clipFxSchema, type EffectDef, type EffectParams } from "./effectDefSchema";
import { periodMs } from "./effects";
import { colorValueRgb } from "./looks";
import type { ColorValue, EffectCue, Easing, Look, Period, Rgb, Spread, Tempo } from "./project";
import { colorValueSchema, lookSchema, spreadSchema } from "./schema";

/**
 * Cue 模板：一组预设的“颜色场景”，从素材库拖到轨道（或点击）就能得到对应外观的片段。
 *
 * 模板从配置文件加载：内置模板随软件发布（`builtinCueTemplates.json`），用户模板在数据目录的
 * `cue-templates.json`（可手改、导入导出，也可在软件里新建 / 改名 / 改分组 / 删除）。两者合并，
 * 同 `id` 时用户的覆盖内置的。
 *
 * 文件格式（版本 2；版本 1 只有颜色模板，照常读取）。颜色模板：
 *
 * ```json
 * { "version": 1, "templates": [
 *   { "id": "lee-106", "group": "stage", "name": { "zh": "LEE 106 原红", "en": "LEE 106 Primary Red" },
 *     "color": { "kind": "rgb", "rgb": [240, 0, 0] }, "brightness": 100, "fadeInMs": 0, "fadeOutMs": 0,
 *     "note": "LEE 106 Primary Red" },
 *   { "id": "k3200", "group": "white", "name": "钨丝灯 3200K", "color": { "kind": "kelvin", "kelvin": 3200 } }
 * ] }
 * ```
 *
 * 版本 2 起每条可再带 `kind`（`look` 时带 `look` / `spread`，`effect` 时带 `fx`）、`easing`、`length`、`tags`；
 * 字段与工程文件里片段的同名字段一致。
 *
 * 色纸编号只是参考：LED 混不出色纸的光谱，RGB 为近似值。
 */

/** 文件格式版本：2 起支持外观模板、特效预设模板与高级设置（版本 1 的文件照常读取）。 */
export const TEMPLATE_FILE_VERSION = 2;

/** 内置的分组（显示顺序；用户可以用任意分组名）。 */
export const BUILTIN_GROUPS = ["basic", "stage", "white", "rosco", "concert", "mood", "fxPresets", "custom"] as const;

/** 新建的用户模板默认放进的分组。 */
export const CUSTOM_GROUP = "custom";

/** 模板的颜色：RGB 意图色（可带白光策略）、色温，或按发光体直给。 */
export type TemplateColor = ColorValue;

/**
 * 模板种类：
 * - `color`：一种颜色（可带沿成员铺开的多色分布）；
 * - `look`：外观（强度 / 颜色 / 属性层，固定值、曲线、关键帧、颜色序列都可以）+ 分布；
 * - `effect`：特效预设（特效快照 + 参数，插入后仍可改参数）。
 */
export type TemplateKind = "color" | "look" | "effect";

/** 一个 Cue 模板。 */
export interface CueTemplate {
  id: string;
  /** 显示名：一个字符串，或按语言给出（`zh` / `en`，缺的语言用另一个） */
  name: string | { zh?: string; en?: string };
  /** 分组 */
  group: string;
  /** 种类；省略为 `color` */
  kind?: TemplateKind;
  /** 颜色模板的颜色；外观 / 特效模板为代表色（素材库色块显示用） */
  color: TemplateColor;
  /** 亮度 0~100 */
  brightness: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** 淡入淡出的缓动；省略为线性 */
  easing?: Easing;
  /** 片段长度（毫秒或拍）；省略为默认长度 */
  length?: Period;
  /** 外观模板的外观 */
  look?: Look;
  /** 多灯分布（外观模板，或颜色模板的多色分布） */
  spread?: Spread;
  /** 特效预设模板：特效快照与参数 */
  fx?: { def: EffectDef; params: EffectParams };
  /** 标签（搜索用） */
  tags?: string[];
  /** 说明（例如参考的色纸编号） */
  note?: string;
  /** 内置模板（只读；运行时标记，不写进用户文件） */
  builtin?: boolean;
}

/**
 * 模板的种类（省略时为颜色模板）。
 *
 * @param template 模板。
 * @returns 种类。
 */
export function templateKind(template: Pick<CueTemplate, "kind">): TemplateKind {
  return template.kind ?? "color";
}

const nonEmpty = z.string().trim().min(1).max(80);

/** 色温上限：与工程校验一致（旧文件里超过的按上限读入）。 */
const MAX_KELVIN = 20_000;

/** 单个模板的校验（缺省的亮度为 100、淡入淡出为 0、分组为“我的”）。 */
const templateSchema = z
  .object({
    id: z.string().trim().min(1).max(64).regex(/^[\w.-]+$/),
    name: z.union([nonEmpty, z.object({ zh: nonEmpty.optional(), en: nonEmpty.optional() }).refine((n) => n.zh || n.en)]),
    group: z.string().trim().min(1).max(32).default(CUSTOM_GROUP),
    kind: z.enum(["color", "look", "effect"]).optional(),
    color: z.union([
      // 旧版本允许到 40000K：读入时夹到工程的上限
      z.object({ kind: z.literal("kelvin"), kelvin: z.number().min(1000).max(40_000).transform((k) => Math.min(k, MAX_KELVIN)) }),
      colorValueSchema,
    ]),
    brightness: z.number().min(0).max(100).default(100),
    fadeInMs: z.number().int().min(0).max(600_000).default(0),
    fadeOutMs: z.number().int().min(0).max(600_000).default(0),
    easing: z.enum(["linear", "easeInOut", "sCurve"]).optional(),
    length: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("ms"), ms: z.number().int().min(100).max(3_600_000) }),
        z.object({ kind: z.literal("beats"), beats: z.number().min(0.25).max(1024) }),
      ])
      .optional(),
    look: lookSchema.optional(),
    spread: spreadSchema.optional(),
    fx: clipFxSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(24)).max(8).optional(),
    note: z.string().max(200).optional(),
  })
  .refine((t) => (t.kind === "look" ? t.look !== undefined : t.kind === "effect" ? t.fx !== undefined : true), "kind");

/** 解析出的一处问题（第几条、哪里不对）。 */
export interface TemplateIssue {
  /** 第几条（从 1 起）；整份文件的问题为 `null` */
  index: number | null;
  /** 问题说明（字段路径 + 原因） */
  message: string;
}

/** 解析结果：合法的模板 + 被跳过的条目说明。 */
export interface TemplateParse {
  templates: CueTemplate[];
  issues: TemplateIssue[];
}

/**
 * 解析模板文件：整份结构不对时没有模板；单条不对时跳过那一条并记下原因；`id` 重复时后一条覆盖前一条。
 *
 * @param data 已 `JSON.parse` 的文件内容。
 * @returns 合法的模板与问题列表。
 */
export function parseTemplates(data: unknown): TemplateParse {
  const root = z.object({ version: z.number().int().optional(), templates: z.array(z.unknown()) }).safeParse(data);
  if (!root.success) return { templates: [], issues: [{ index: null, message: "templates" }] };
  const issues: TemplateIssue[] = [];
  if (root.data.version !== undefined && root.data.version > TEMPLATE_FILE_VERSION) {
    issues.push({ index: null, message: `version ${root.data.version}` });
  }
  const byId = new Map<string, CueTemplate>();
  root.data.templates.forEach((raw, i) => {
    const r = templateSchema.safeParse(raw);
    if (!r.success) {
      const first = r.error.issues[0];
      issues.push({ index: i + 1, message: `${first?.path.join(".") || "?"}: ${first?.message ?? ""}`.trim() });
      return;
    }
    const d = r.data;
    // 只保留出现的可选字段（文件里没有的不写 undefined）
    const template: CueTemplate = {
      id: d.id,
      name: d.name,
      group: d.group,
      color: d.color as TemplateColor,
      brightness: d.brightness,
      fadeInMs: d.fadeInMs,
      fadeOutMs: d.fadeOutMs,
      ...(d.kind && d.kind !== "color" ? { kind: d.kind } : {}),
      ...(d.easing ? { easing: d.easing } : {}),
      ...(d.length ? { length: d.length } : {}),
      ...(d.look && d.kind === "look" ? { look: d.look as Look } : {}),
      ...(d.spread && d.kind !== "effect" ? { spread: d.spread as Spread } : {}),
      ...(d.fx && d.kind === "effect" ? { fx: d.fx as CueTemplate["fx"] } : {}),
      ...(d.tags && d.tags.length > 0 ? { tags: [...new Set(d.tags)] } : {}),
      ...(d.note ? { note: d.note } : {}),
    };
    byId.set(template.id, template);
  });
  return { templates: [...byId.values()], issues };
}

/**
 * 解析文件文本。
 *
 * @param text 文件内容。
 * @returns 解析结果；不是 JSON 时没有模板并记一条问题。
 */
export function parseTemplateText(text: string): TemplateParse {
  try {
    return parseTemplates(JSON.parse(text));
  } catch {
    return { templates: [], issues: [{ index: null, message: "json" }] };
  }
}

/**
 * 序列化成文件内容（去掉运行时标记，缩进两格）。
 *
 * @param templates 模板。
 * @returns JSON 文本。
 */
export function serializeTemplates(templates: readonly CueTemplate[]): string {
  const clean = templates.map(({ builtin: _builtin, ...t }) => {
    void _builtin;
    return t;
  });
  return `${JSON.stringify({ version: TEMPLATE_FILE_VERSION, templates: clean }, null, 2)}\n`;
}

/** 内置模板（随软件发布，只读）。 */
export const BUILTIN_TEMPLATES: readonly CueTemplate[] = parseTemplates(builtinFile).templates.map((t) => ({ ...t, builtin: true }));

/**
 * 内置 + 用户模板合并：同 `id` 时用户的覆盖内置的（位置保持在内置的位置），其余用户模板接在后面。
 *
 * @param builtin 内置模板。
 * @param user 用户模板。
 * @returns 合并后的列表。
 */
export function mergeTemplates(builtin: readonly CueTemplate[], user: readonly CueTemplate[]): CueTemplate[] {
  const userById = new Map(user.map((t) => [t.id, t]));
  const merged = builtin.map((t) => userById.get(t.id) ?? t);
  const builtinIds = new Set(builtin.map((t) => t.id));
  return [...merged, ...user.filter((t) => !builtinIds.has(t.id))];
}

/**
 * 按分组排列：内置分组在前（`BUILTIN_GROUPS` 的顺序），用户自建的分组按出现顺序接在后面，“我的”放最后。
 *
 * @param templates 模板。
 * @returns 分组与组内模板（空分组不出现）。
 */
export function groupTemplates(templates: readonly CueTemplate[]): { group: string; templates: CueTemplate[] }[] {
  const order: string[] = BUILTIN_GROUPS.filter((g) => g !== CUSTOM_GROUP);
  for (const t of templates) if (!order.includes(t.group) && t.group !== CUSTOM_GROUP) order.push(t.group);
  order.push(CUSTOM_GROUP);
  return order
    .map((group) => ({ group, templates: templates.filter((t) => t.group === group) }))
    .filter((g) => g.templates.length > 0);
}

/**
 * 模板的显示名。
 *
 * @param template 模板。
 * @param lang 界面语言（`zh` / `en`，其它按 `en`）。
 * @returns 名称。
 */
export function templateName(template: Pick<CueTemplate, "name" | "id">, lang: string): string {
  const n = template.name;
  if (typeof n === "string") return n;
  const zh = lang.startsWith("zh");
  return (zh ? (n.zh ?? n.en) : (n.en ?? n.zh)) ?? template.id;
}

/**
 * 模板在界面上的显示色（色温换算成近似的 RGB）。
 *
 * @param template 模板。
 * @returns sRGB。
 */
export function templateRgb(template: Pick<CueTemplate, "color">): Rgb {
  return colorValueRgb(template.color);
}

/**
 * 生成一个不与已有模板重复的 `id`。
 *
 * @param existing 已有模板。
 * @param base 前缀。
 * @returns 新 `id`。
 */
export function uniqueTemplateId(existing: readonly Pick<CueTemplate, "id">[], base = "my"): string {
  const ids = new Set(existing.map((t) => t.id));
  for (let n = 1; ; n += 1) {
    const id = `${base}-${n}`;
    if (!ids.has(id)) return id;
  }
}

/**
 * 颜色转成 CSS 变量值 `--cue-color` 用的字符串（运行时拼接，不在源码里写死颜色）。
 *
 * @param rgb 颜色分量。
 * @returns 形如 `rgb(255 0 0)` 的 CSS 颜色。
 */
export function cssColor(rgb: Rgb): string {
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
}

/** 彩虹特效在时间线上的色带。 */
const RAINBOW_STOPS: readonly Rgb[] = [
  [255, 0, 0],
  [255, 255, 0],
  [0, 255, 0],
  [0, 255, 255],
  [0, 0, 255],
  [255, 0, 255],
];

/** 画特效填充需要的上下文：周期按拍时要节拍，相位扩散要轨道成员数。 */
export interface EffectFillContext {
  tempo: Tempo | null;
  /** 轨道上的灯具数（至少 1） */
  members: number;
}

/**
 * 特效 Cue 在时间线上的填充。
 *
 * - 彩虹、渐变：颜色随时间循环，与引擎（`show-engine/src/effects.rs` 的 `sample`）一致——
 *   每个周期走一圈、相位从片段起点算起，按片段长度重复；显示轨道第一台灯的相位（含相位扩散与方向）。
 * - 其它特效：单色为纯色，多色为横向渐变。
 *
 * @param cue 特效 Cue。
 * @param ctx 节拍与轨道成员数；省略时按 120 BPM、单台灯。
 * @returns 可直接用作 CSS `background` 的值。
 */
export function effectBackground(
  cue: Pick<EffectCue, "effect" | "colors" | "period" | "phaseSpread" | "direction" | "startMs" | "endMs">,
  ctx: EffectFillContext = { tempo: null, members: 1 },
): string {
  const cyclic = cue.effect === "rainbow" || cue.effect === "gradient";
  const colors = cue.effect === "rainbow" ? RAINBOW_STOPS : cue.colors;
  if (colors.length === 0) return "var(--primary)";
  if (colors.length === 1) return cssColor(colors[0]);
  if (!cyclic) return `linear-gradient(90deg, ${colors.map(cssColor).join(", ")})`;

  // 一个周期占片段宽度的百分比
  const length = Math.max(1, cue.endMs - cue.startMs);
  const cycle = (periodMs(cue.period, ctx.tempo) / length) * 100;
  // 第一台灯的相位偏移：位置 p（反向时为最后一个）× 扩散 / 成员数
  const n = Math.max(1, Math.floor(ctx.members));
  const p = cue.direction < 0 ? n - 1 : 0;
  const offset = (Math.min(1, Math.max(0, cue.phaseSpread)) * p) / n;
  // 色标：首尾相接（回到第一个颜色），引擎在相邻颜色之间线性插值
  const stops = [...colors, colors[0]].map((c, k) => {
    const at = (k / colors.length - offset) * cycle;
    return `${cssColor(c)} ${Math.round(at * 1000) / 1000}%`;
  });
  return `repeating-linear-gradient(90deg, ${stops.join(", ")})`;
}
