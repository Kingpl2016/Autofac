import { cssColor, effectBackground, templateKind, type CueTemplate, type EffectFillContext } from "./cueTemplates";
import type { EffectDef } from "./effectLibrary";
import { colorValueRgb, paramHead, resolveLook } from "./looks";
import { DEFAULT_CUE_MS } from "./cueOps";
import { periodMs } from "./effects";
import {
  DEFAULT_GAMMA,
  type ColorCycle,
  type ColorParam,
  type ColorValue,
  type Cue,
  type Keyframe,
  type Look,
  type Param,
  type Preset,
  type Rgb,
  type Tempo,
} from "./project";

/**
 * 时间线片段的“长相”：类别（决定顶部色条与图标）、主体填充（设定的颜色随时间的变化）、显示名。
 *
 * 只按片段数据推断，不求值引擎；底部的实际输出色带另由引擎采样（`colorLanes.ts`）。
 */

/** 片段类别：颜色（静态色 / 固定外观）、特效（经典特效或会变化的外观）、预设引用、场景。 */
export type ClipCategory = "color" | "effect" | "preset" | "scene";

/** 片段主体的填充。 */
export interface ClipFill {
  /** CSS `background` 值；`neutral` 时为 `null` */
  background: string | null;
  /** 没有颜色层：用中性底色 + 斜纹表示“这个片段不改颜色” */
  neutral: boolean;
}

/** 画填充需要的上下文。 */
export interface ClipFillContext extends EffectFillContext {
  /** 工程 Gamma（手动覆盖颜色的合成用） */
  gamma: number;
}

/**
 * 参数是否随时间变化（关键帧或曲线）。
 *
 * @param p 参数。
 * @returns 是否变化。
 */
function animated(p: Param<number> | ColorParam | undefined): boolean {
  return p !== undefined && p.kind !== "value";
}

/**
 * 外观是否“会动”：任何一层是关键帧 / 曲线。
 *
 * @param look 外观（已合并预设）。
 * @returns 是否会动。
 */
function lookAnimated(look: Look): boolean {
  return animated(look.intensity) || animated(look.color) || Object.values(look.attrs ?? {}).some((p) => animated(p));
}

/**
 * 片段类别。
 *
 * - 场景片段 → 场景；引用预设的外观片段 → 预设；
 * - 经典特效、带分布或任一层是关键帧 / 曲线的外观片段（属性特效）→ 特效；
 * - 其余（静态色、固定的外观，例如 Cue 模板）→ 颜色。
 *
 * @param cue 片段。
 * @param presets 预设库。
 * @returns 类别。
 */
export function clipCategory(cue: Cue, presets: readonly Preset[]): ClipCategory {
  switch (cue.kind) {
    case "scene":
      return "scene";
    case "effect":
      return "effect";
    case "static":
      return "color";
    case "look": {
      if (cue.look.presetId && presets.some((p) => p.id === cue.look.presetId)) return "preset";
      return cue.spread || lookAnimated(resolveLook(cue.look, presets)) ? "effect" : "color";
    }
  }
}

/**
 * 百分比数字（最多 3 位小数）。
 *
 * @param v 数值。
 * @returns 文本。
 */
function pct(v: number): string {
  return `${Math.round(v * 1000) / 1000}%`;
}

/**
 * 颜色关键帧 → 横向渐变：每帧的时刻换算成片段宽度的百分比；“保持”过渡画硬边，其余按线性过渡；
 * 第一帧之前取第一帧、最后一帧之后取最后一帧（与引擎一致）。
 *
 * @param keys 关键帧（按时刻升序）。
 * @param lengthMs 片段长度。
 * @param gamma 工程 Gamma。
 * @returns CSS 渐变；只有一帧时为纯色。
 */
export function colorKeysGradient(keys: readonly Keyframe<ColorValue>[], lengthMs: number, gamma: number): string {
  const sorted = [...keys].sort((a, b) => a.tMs - b.tMs);
  if (sorted.length === 0) return "transparent";
  const css = (k: Keyframe<ColorValue>) => cssColor(colorValueRgb(k.value, gamma));
  if (sorted.length === 1) return css(sorted[0]);
  const length = Math.max(1, lengthMs);
  const at = (k: Keyframe<ColorValue>) => (k.tMs / length) * 100;
  const stops: string[] = [];
  if (at(sorted[0]) > 0) stops.push(`${css(sorted[0])} 0%`);
  sorted.forEach((k, i) => {
    stops.push(`${css(k)} ${pct(at(k))}`);
    const next = sorted[i + 1];
    // 保持：本帧的颜色一直到下一帧（同一位置两个色标 = 硬边）
    if (next && k.curve === "hold") stops.push(`${css(k)} ${pct(at(next))}`);
  });
  const last = sorted[sorted.length - 1];
  if (at(last) < 100) stops.push(`${css(last)} 100%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/**
 * 颜色序列 → 按周期重复的横向渐变（第一台灯、相位从片段起点算起；按节拍对齐的序列只是近似）。
 *
 * @param cycle 颜色序列。
 * @param lengthMs 片段长度。
 * @param tempo 工程节拍（按拍的周期用）。
 * @param gamma 工程 Gamma。
 * @returns CSS 渐变；只有一种颜色时为纯色。
 */
export function colorCycleGradient(cycle: ColorCycle, lengthMs: number, tempo: Tempo | null, gamma: number): string {
  const colors = cycle.colors;
  if (colors.length === 0) return "transparent";
  const css = (c: ColorValue) => cssColor(colorValueRgb(c, gamma));
  if (colors.length === 1) return css(colors[0]);
  const length = Math.max(1, lengthMs);
  const period = cycle.period ? periodMs(cycle.period, tempo) : length / Math.max(1, cycle.cycles);
  const width = (period / length) * 100;
  const n = colors.length;
  const shift = Math.min(1, Math.max(0, cycle.phase)) * width;
  const at = (k: number) => pct((k / n) * width - shift);
  const stops: string[] = [];
  for (let k = 0; k <= n; k += 1) {
    const c = colors[k % n];
    if (cycle.blend === "step") {
      if (k < n) stops.push(`${css(c)} ${at(k)}`, `${css(c)} ${at(k + 1)}`);
    } else {
      stops.push(`${css(c)} ${at(k)}`);
    }
  }
  return `repeating-linear-gradient(90deg, ${stops.join(", ")})`;
}

/**
 * 片段主体的填充：设定的颜色随时间的变化（第一台灯，未计亮度）。
 *
 * - 静态片段：纯色；经典特效：`effectBackground`（彩虹 / 渐变按周期重复）；
 * - 外观片段（含预设）：颜色层固定为纯色、关键帧为渐变（属性特效的彩虹、双色交替等随周期重复）；
 *   曲线不会出现在颜色层上；没有颜色层时为中性（斜纹）；
 * - 场景片段：第一个带颜色的条目，没有时为中性。
 *
 * @param cue 片段。
 * @param presets 预设库。
 * @param ctx 节拍、轨道成员数、Gamma。
 * @returns 填充。
 */
export function clipFill(cue: Cue, presets: readonly Preset[], ctx: ClipFillContext): ClipFill {
  const gamma = Number.isFinite(ctx.gamma) && ctx.gamma > 0 ? ctx.gamma : DEFAULT_GAMMA;
  const length = cue.endMs - cue.startMs;
  const ofParam = (p: ColorParam | undefined): ClipFill => {
    if (!p) return { background: null, neutral: true };
    if (p.kind === "keys") return { background: colorKeysGradient(p.keys, length, gamma), neutral: false };
    if (p.kind === "cycle") return { background: colorCycleGradient(p.cycle, length, ctx.tempo, gamma), neutral: false };
    const head = paramHead(p);
    return head ? { background: cssColor(colorValueRgb(head, gamma)), neutral: false } : { background: null, neutral: true };
  };
  switch (cue.kind) {
    case "static":
      return { background: cssColor(cue.rgb), neutral: false };
    case "effect":
      return { background: effectBackground(cue, ctx), neutral: false };
    case "look":
      return ofParam(resolveLook(cue.look, presets).color);
    case "scene": {
      const first = cue.entries.map((e) => resolveLook(e.look, presets).color).find((c) => c !== undefined);
      return ofParam(first);
    }
  }
}

/**
 * 属性特效在素材库卡片 / 拖动浮层上的色块：与放到时间线后的片段主体同一画法——
 * 固定颜色为纯色，颜色列表按顺序排开（“跳变”为硬边、“平滑”为渐变），没有颜色层为中性斜纹。
 *
 * 引用可调参数的颜色取参数当前值（`values`）或声明里的默认值。
 *
 * @param def 特效定义。
 * @param values 可调参数的值（插入面板里的当前参数）；省略时用默认值。
 * @returns 填充。
 */
export function effectDefSwatch(def: Pick<EffectDef, "look" | "params">, values?: Readonly<Record<string, unknown>>): ClipFill {
  const c = def.look.color;
  if (!c) return { background: null, neutral: true };
  const resolve = (v: unknown): unknown => {
    if (typeof v !== "string" || !v.startsWith("$")) return v;
    const id = v.slice(1);
    return values?.[id] ?? def.params?.find((p) => p.id === id)?.default;
  };
  const isRgb = (v: unknown): v is Rgb => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number");
  if ("rgb" in c) {
    const rgb = resolve(c.rgb);
    return isRgb(rgb) ? { background: cssColor(rgb), neutral: false } : { background: null, neutral: true };
  }
  const raw = resolve(c.colors);
  const colors = Array.isArray(raw) ? raw.filter(isRgb) : [];
  if (colors.length === 0) return { background: null, neutral: true };
  if (colors.length === 1) return { background: cssColor(colors[0]), neutral: false };
  const n = colors.length;
  const stops =
    resolve(c.blend) === "step"
      ? colors.flatMap((rgb, i) => [`${cssColor(rgb)} ${pct((i / n) * 100)}`, `${cssColor(rgb)} ${pct(((i + 1) / n) * 100)}`])
      : colors.map((rgb, i) => `${cssColor(rgb)} ${pct((i / (n - 1)) * 100)}`);
  return { background: `linear-gradient(90deg, ${stops.join(", ")})`, neutral: false };
}

/**
 * Cue 模板在素材库卡片上的色块：与插入后的片段主体同一画法。
 *
 * - 颜色模板：纯色；带多色分布时按成员顺序排开（“跳变”为硬边，其余为渐变）；
 * - 外观模板：颜色层固定为纯色、关键帧 / 颜色序列为渐变（按模板长度，节拍按 120 BPM），没有颜色层为中性斜纹；
 * - 特效预设模板：与特效库卡片相同（参数取模板里保存的值）。
 *
 * @param template 模板。
 * @param gamma 工程 Gamma（手动覆盖颜色的合成用）。
 * @returns 填充。
 */
export function templateSwatch(
  template: Pick<CueTemplate, "kind" | "color" | "look" | "spread" | "fx" | "length">,
  gamma: number = DEFAULT_GAMMA,
): ClipFill {
  const kind = templateKind(template);
  if (kind === "effect" && template.fx) return effectDefSwatch(template.fx.def, template.fx.params.values);
  const spread = template.spread?.colors;
  if (spread && spread.colors.length > 1) {
    const colors = spread.colors.map((c) => colorValueRgb(c, gamma));
    const n = colors.length;
    const stops =
      spread.blend === "step"
        ? colors.flatMap((rgb, i) => [`${cssColor(rgb)} ${pct((i / n) * 100)}`, `${cssColor(rgb)} ${pct(((i + 1) / n) * 100)}`])
        : colors.map((rgb, i) => `${cssColor(rgb)} ${pct((i / (n - 1)) * 100)}`);
    return { background: `linear-gradient(90deg, ${stops.join(", ")})`, neutral: false };
  }
  if (kind === "look" && template.look) {
    const p = template.look.color;
    if (!p) return { background: null, neutral: true };
    const length = template.length ? Math.max(100, periodMs(template.length, null)) : DEFAULT_CUE_MS;
    if (p.kind === "keys") return { background: colorKeysGradient(p.keys, length, gamma), neutral: false };
    if (p.kind === "cycle") return { background: colorCycleGradient(p.cycle, length, null, gamma), neutral: false };
    const head = paramHead(p);
    if (head) return { background: cssColor(colorValueRgb(head, gamma)), neutral: false };
  }
  return { background: cssColor(colorValueRgb(template.color, gamma)), neutral: false };
}
/**
 * 片段的显示名：片段自己的名称（`label`）→ 引用的预设名 → 经典特效名；都没有时为空串。
 *
 * @param cue 片段。
 * @param presets 预设库。
 * @param effectName 经典特效的显示名（按界面语言）。
 * @returns 名称。
 */
export function clipName(cue: Cue, presets: readonly Preset[], effectName: (effect: string) => string): string {
  if ((cue.kind === "look" || cue.kind === "scene") && cue.label?.trim()) return cue.label.trim();
  if (cue.kind === "look" && cue.look.presetId) return presets.find((p) => p.id === cue.look.presetId)?.name ?? "";
  if (cue.kind === "effect") return effectName(cue.effect);
  return "";
}
