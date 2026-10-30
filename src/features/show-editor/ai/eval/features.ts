import { rgbToHsv } from "../../lib/colorMath";
import { colorValueRgb, paramHead } from "../../lib/looks";
import type { ColorValue, Cue, ShowProject } from "../../lib/project";

/**
 * 一致性评测的特征：把 AI 生成的结果（工程）概括成每个段落的少数几个离散特征，
 * 在特征层面比较“不同模型 / 同一模型多次”的结果是否一致。
 *
 * 直接比较操作列表太严格（同一个意思可以有多种写法），比较 DMX 帧又太细（相位差一点就不同）；
 * 特征只保留编排上有意义的选择：用了哪类特效、主色调、强度档位、有没有动作。
 */

/** 一个段落的特征。 */
export interface SpanFeatures {
  /** 主要特效的类别：`intensity` / `color` / `position` / `beam` / `static`（固定外观）/ `none`（没有片段） */
  kind: string;
  /** 主色调：8 个色相区（`h0`…`h7`，每区 45°）、`white`（低饱和）或 `none` */
  hue: string;
  /** 平均亮度档位：`low` < 40% ≤ `mid` < 75% ≤ `high` */
  level: "low" | "mid" | "high" | "none";
  /** 有没有位置动作（摇头灯在动） */
  moves: boolean;
}

/** 特征的字段（比较时逐项计分）。 */
export const FEATURE_FIELDS = ["kind", "hue", "level", "moves"] as const satisfies readonly (keyof SpanFeatures)[];

/** 片段的颜色（代表色）。 */
function cueColor(cue: Cue): ColorValue | undefined {
  if (cue.kind === "static") return { kind: "rgb", rgb: cue.rgb };
  if (cue.kind === "effect") return { kind: "rgb", rgb: cue.colors[0] };
  if (cue.kind === "look") {
    const params = cue.fx?.params.values;
    const fromParams = params ? Object.values(params).find((v) => Array.isArray(v)) : undefined;
    if (Array.isArray(fromParams) && fromParams.length > 0) {
      const first = (Array.isArray(fromParams[0]) ? fromParams[0] : fromParams) as [number, number, number];
      return { kind: "rgb", rgb: first };
    }
    return paramHead(cue.look.color) as ColorValue | undefined;
  }
  return undefined;
}

/** 片段的特效类别。 */
function cueKind(cue: Cue): string {
  if (cue.kind === "look" && cue.fx) return cue.fx.def.group;
  if (cue.kind === "look") {
    const curves = [cue.look.intensity, cue.look.color, ...Object.values(cue.look.attrs ?? {})].some((p) => p && p.kind !== "value");
    return curves ? "custom" : "static";
  }
  return cue.kind === "effect" ? "legacy" : "static";
}

/** 片段的代表亮度（%）。 */
function cueLevel(cue: Cue): number {
  if (cue.kind !== "look") return cue.brightness;
  const p = cue.look.intensity;
  const v = p?.kind === "value" ? p.value : p?.kind === "curve" ? (p.curve.from + p.curve.to) / 2 : p?.kind === "keys" ? p.keys[0]?.value ?? 100 : 100;
  return (v * cue.brightness) / 100;
}

/**
 * 计算每个段落的特征。
 *
 * @param project 生成后的工程。
 * @param spans 段落（`[起点, 终点)`，毫秒）。
 * @returns 每段的特征。
 */
export function extractFeatures(project: ShowProject, spans: readonly { startMs: number; endMs: number }[]): SpanFeatures[] {
  return spans.map(({ startMs, endMs }) => {
    const inside = project.cues.filter((c) => !c.disabled && c.startMs < endMs && startMs < c.endMs);
    const overlap = (c: Cue) => Math.min(c.endMs, endMs) - Math.max(c.startMs, startMs);
    // 主要片段：覆盖时间最长的非位置片段
    const lights = inside.filter((c) => cueKind(c) !== "position").sort((a, b) => overlap(b) - overlap(a));
    const main = lights[0];
    const moves = inside.some((c) => cueKind(c) === "position" || (c.kind === "look" && (c.look.attrs?.pan?.kind ?? "value") !== "value"));
    if (!main) return { kind: inside.length > 0 ? "position" : "none", hue: "none", level: "none", moves };
    const color = cueColor(main);
    let hue = "none";
    if (color) {
      const hsv = rgbToHsv(colorValueRgb(color));
      hue = color.kind === "kelvin" || hsv.s < 0.25 ? "white" : `h${Math.floor(((hsv.h + 22.5) % 360) / 45)}`;
    }
    const lv = cueLevel(main);
    return { kind: cueKind(main), hue, level: lv < 40 ? "low" : lv < 75 ? "mid" : "high", moves };
  });
}

/**
 * 两份结果的一致度：逐段逐项比较，相同的比例（0~1）。
 *
 * @param a 一份结果的特征。
 * @param b 另一份。
 * @returns 一致度；段数不同时按较短的比较，缺的段算不一致。
 */
export function agreement(a: readonly SpanFeatures[], b: readonly SpanFeatures[]): number {
  const n = Math.max(a.length, b.length);
  if (n === 0) return 1;
  let same = 0;
  for (let i = 0; i < n; i += 1) {
    for (const f of FEATURE_FIELDS) if (a[i] && b[i] && a[i][f] === b[i][f]) same += 1;
  }
  return same / (n * FEATURE_FIELDS.length);
}

/**
 * 一组结果两两一致度的平均值（同一模型多次运行的“自身一致度”，或多个模型之间的“跨模型一致度”）。
 *
 * @param runs 每次运行的特征。
 * @returns 平均一致度；少于 2 份时为 1。
 */
export function meanAgreement(runs: readonly (readonly SpanFeatures[])[]): number {
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      sum += agreement(runs[i], runs[j]);
      pairs += 1;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}

/** 对一份结果的期望（评测用例里写）。 */
export interface Expectation {
  /** 第几段（从 0 起） */
  span: number;
  field: (typeof FEATURE_FIELDS)[number];
  /** 允许的取值 */
  oneOf: readonly (string | boolean)[];
}

/**
 * 期望的满足比例。
 *
 * @param features 结果的特征。
 * @param expectations 期望。
 * @returns 0~1；没有期望时为 1。
 */
export function expectationScore(features: readonly SpanFeatures[], expectations: readonly Expectation[]): number {
  if (expectations.length === 0) return 1;
  const ok = expectations.filter((e) => features[e.span] && e.oneOf.includes(features[e.span][e.field])).length;
  return ok / expectations.length;
}
