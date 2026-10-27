import type { EffectCue, EffectId, Rgb } from "./project";

/**
 * 特效的参数集合（新建特效 Cue 时的初值，也是属性面板里编辑的内容）。
 * 与 {@link EffectCue} 中和时间无关的字段一一对应。
 */
export type EffectParams = Pick<
  EffectCue,
  "effect" | "colors" | "period" | "phaseSpread" | "direction" | "range" | "seed"
>;

/** 特效预设：素材库里的一个条目，名称在语言包 `editor.effects.<effect>`。 */
export interface EffectPreset {
  effect: EffectId;
  /** 新建时的默认长度（毫秒） */
  lengthMs: number;
  params: EffectParams;
}

const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const WARM: Rgb = [255, 200, 120];
const WHITE: Rgb = [255, 255, 255];

/** 各预设共同的起点参数（每次调用返回新对象，避免预设之间共用同一个数组）。 */
function base() {
  return { phaseSpread: 0, direction: 1 as const, range: [0, 100] as [number, number], seed: 1 };
}

/** 全部内置特效的预设，顺序即素材库里的显示顺序。 */
export const EFFECT_PRESETS: readonly EffectPreset[] = [
  {
    effect: "breathe",
    lengthMs: 8000,
    params: { ...base(), range: [10, 100], effect: "breathe", colors: [WARM], period: { kind: "ms", ms: 4000 }, phaseSpread: 0.3 },
  },
  {
    effect: "rainbow",
    lengthMs: 8000,
    params: { ...base(), effect: "rainbow", colors: [RED], period: { kind: "ms", ms: 6000 }, phaseSpread: 1 },
  },
  {
    effect: "chase",
    lengthMs: 8000,
    params: { ...base(), effect: "chase", colors: [WHITE], period: { kind: "beats", beats: 4 }, phaseSpread: 0.25 },
  },
  {
    effect: "wipe",
    lengthMs: 8000,
    params: { ...base(), effect: "wipe", colors: [RED, BLUE], period: { kind: "beats", beats: 8 } },
  },
  {
    effect: "gradient",
    lengthMs: 8000,
    params: { ...base(), effect: "gradient", colors: [RED, BLUE], period: { kind: "ms", ms: 8000 }, phaseSpread: 1 },
  },
  {
    effect: "pulse",
    lengthMs: 4000,
    params: { ...base(), effect: "pulse", colors: [WHITE], period: { kind: "beats", beats: 1 } },
  },
  {
    effect: "sparkle",
    lengthMs: 6000,
    params: { ...base(), effect: "sparkle", colors: [WHITE], period: { kind: "ms", ms: 250 } },
  },
  {
    effect: "strobe",
    lengthMs: 2000,
    params: { ...base(), effect: "strobe", colors: [WHITE], period: { kind: "ms", ms: 200 } },
  },
];

/**
 * 取某个特效的预设。
 *
 * @param effect 特效类型。
 * @returns 对应的预设；总是存在（预设表覆盖全部特效）。
 */
export function presetOf(effect: EffectId): EffectPreset {
  return EFFECT_PRESETS.find((p) => p.effect === effect) ?? EFFECT_PRESETS[0];
}

/**
 * 复制一份预设参数，避免多个 Cue 共用同一个数组 / 对象。
 *
 * @param params 预设里的参数。
 * @returns 深拷贝。
 */
export function cloneParams(params: EffectParams): EffectParams {
  return structuredClone(params) as EffectParams;
}

/** 颜色数量的上下限。 */
export const MIN_EFFECT_COLORS = 1;
export const MAX_EFFECT_COLORS = 4;

/** 周期的合法范围：毫秒（下限见 `effects.ts` 的 `MIN_PERIOD_MS`）/ 拍数。 */
export const MAX_PERIOD_MS = 600_000;
export const MIN_PERIOD_BEATS = 0.25;
export const MAX_PERIOD_BEATS = 128;
