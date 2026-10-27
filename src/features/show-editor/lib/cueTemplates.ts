import type { EffectCue, Rgb } from "./project";

/**
 * Cue 模板：一组预设的“颜色场景”，从素材库拖到轨道（或点击）就能得到对应外观的静态 Cue。
 * 名称在语言包 `editor.templates.<id>`。
 */
export interface CueTemplate {
  id: string;
  rgb: Rgb;
  brightness: number;
  fadeInMs: number;
  fadeOutMs: number;
}

/** 内置模板：常用的舞台颜色，外加两个带淡入淡出的白光。 */
export const CUE_TEMPLATES: readonly CueTemplate[] = [
  { id: "white", rgb: [255, 255, 255], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "warmWhite", rgb: [255, 200, 120], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "red", rgb: [255, 0, 0], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "orange", rgb: [255, 128, 0], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "yellow", rgb: [255, 220, 0], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "green", rgb: [0, 255, 0], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "cyan", rgb: [0, 255, 255], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "blue", rgb: [0, 0, 255], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "purple", rgb: [128, 0, 255], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "magenta", rgb: [255, 0, 255], brightness: 100, fadeInMs: 0, fadeOutMs: 0 },
  { id: "fadeWhite", rgb: [255, 255, 255], brightness: 100, fadeInMs: 500, fadeOutMs: 500 },
  { id: "softWhite", rgb: [255, 200, 120], brightness: 60, fadeInMs: 1000, fadeOutMs: 1000 },
];

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

/**
 * 特效 Cue 在时间线上的填充：用它的颜色拼成横向渐变（单色为纯色，彩虹为全色带）。
 *
 * @param cue 特效 Cue（只用到特效类型和颜色列表）。
 * @returns 可直接用作 CSS `background` 的值。
 */
export function effectBackground(cue: Pick<EffectCue, "effect" | "colors">): string {
  const colors = cue.effect === "rainbow" ? RAINBOW_STOPS : cue.colors;
  if (colors.length === 0) return "var(--primary)";
  if (colors.length === 1) return cssColor(colors[0]);
  return `linear-gradient(90deg, ${colors.map(cssColor).join(", ")})`;
}