import { clamp, clamp01 } from "@/shared/lib/math";
import { hsvToRgb, rgbToHsv } from "../lib/colorMath";
import type { ColorValue, Period, Rgb, Tempo } from "../lib/project";

/**
 * AI 中间语言（AiOps）的受控词汇表：命名色、调色板、周期 / 大小 / 速度 / 淡入淡出档位，以及量化规则。
 *
 * 模型只在这些档位里选择，具体数值由这里确定；不同模型给出“同一个意思”时落到同一个值上，
 * 这是减小模型间差异的主要手段。档位改了要同时改提示词（`prompt.ts`）并递增 `PROMPT_VERSION`。
 */

/** 命名色。白光用色温表示（调色温灯也能还原）。 */
export const NAMED_COLORS = {
  red: { kind: "rgb", rgb: [255, 0, 0] },
  rose: { kind: "rgb", rgb: [255, 40, 90] },
  orange: { kind: "rgb", rgb: [255, 96, 0] },
  amber: { kind: "rgb", rgb: [255, 150, 0] },
  yellow: { kind: "rgb", rgb: [255, 220, 0] },
  lime: { kind: "rgb", rgb: [160, 255, 0] },
  green: { kind: "rgb", rgb: [0, 255, 0] },
  teal: { kind: "rgb", rgb: [0, 200, 140] },
  cyan: { kind: "rgb", rgb: [0, 255, 255] },
  sky: { kind: "rgb", rgb: [80, 170, 255] },
  blue: { kind: "rgb", rgb: [0, 0, 255] },
  indigo: { kind: "rgb", rgb: [70, 0, 255] },
  violet: { kind: "rgb", rgb: [140, 0, 255] },
  purple: { kind: "rgb", rgb: [180, 0, 200] },
  magenta: { kind: "rgb", rgb: [255, 0, 255] },
  pink: { kind: "rgb", rgb: [255, 80, 160] },
  white: { kind: "rgb", rgb: [255, 255, 255] },
  warmWhite: { kind: "kelvin", kelvin: 3000 },
  neutralWhite: { kind: "kelvin", kelvin: 4500 },
  coolWhite: { kind: "kelvin", kelvin: 6500 },
} as const satisfies Record<string, ColorValue>;

/** 命名色的名字。 */
export type ColorName = keyof typeof NAMED_COLORS;

/** 命名色列表（提示词与 schema 用）。 */
export const COLOR_NAMES = Object.keys(NAMED_COLORS) as ColorName[];

/** 调色板：一组命名色（草稿按段落依次取色）。 */
export const PALETTES = {
  warm: ["orange", "rose", "amber", "magenta"],
  cool: ["blue", "cyan", "violet", "sky"],
  neon: ["magenta", "lime", "violet", "yellow"],
  sunset: ["orange", "pink", "purple", "amber"],
  ocean: ["blue", "teal", "cyan", "indigo"],
  forest: ["green", "lime", "teal", "amber"],
  fire: ["red", "orange", "amber", "yellow"],
  ice: ["coolWhite", "sky", "cyan", "blue"],
  party: ["red", "green", "blue", "magenta", "yellow", "cyan"],
  romance: ["pink", "rose", "purple", "warmWhite"],
  mono: ["white"],
} as const satisfies Record<string, readonly ColorName[]>;

/** 调色板的名字。 */
export type PaletteName = keyof typeof PALETTES;

/** 调色板列表。 */
export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];

/** 周期档位（拍）。没有节拍时按 120 BPM 换算（与引擎一致）。 */
export const PERIODS = ["1/4", "1/2", "1", "2", "4", "8", "16", "32"] as const;

/** 周期档位。 */
export type PeriodStep = (typeof PERIODS)[number];

/**
 * 周期档位 → 工程里的周期。
 *
 * @param step 档位。
 * @returns 按拍的周期。
 */
export function periodOf(step: PeriodStep): Period {
  const [a, b] = step.split("/").map(Number);
  return { kind: "beats", beats: b ? a / b : a };
}

/** 大小档位。 */
export const SIZES = ["small", "medium", "large"] as const;

/** 大小档位。 */
export type SizeStep = (typeof SIZES)[number];

/**
 * 大小档位 → 特效参数的 `size`。
 *
 * @param step 档位。
 * @param scale 特效的大小含义：`fraction` 为位置 / 光束幅度（0~0.5），`percent` 为强度（0~100）。
 * @returns `size`。
 */
export function sizeOf(step: SizeStep, scale: "fraction" | "percent"): number {
  const table = scale === "fraction" ? { small: 0.08, medium: 0.15, large: 0.3 } : { small: 40, medium: 70, large: 100 };
  return table[step];
}

/** 多灯错开档位。 */
export const SPREADS = ["none", "half", "full"] as const;

/** 多灯错开档位。 */
export type SpreadStep = (typeof SPREADS)[number];

/**
 * 错开档位 → 特效参数的 `spread`（成员之间错开的周期数）。
 *
 * @param step 档位。
 * @returns `spread`。
 */
export function spreadOf(step: SpreadStep): number {
  return { none: 0, half: 0.5, full: 1 }[step];
}

/** 速度倍率档位（修改已有片段）。 */
export const SPEEDS = ["x0.25", "x0.5", "x2", "x4"] as const;

/** 速度倍率档位。 */
export type SpeedStep = (typeof SPEEDS)[number];

/**
 * 速度档位 → 倍率（2 = 快一倍，周期减半）。
 *
 * @param step 档位。
 * @returns 倍率。
 */
export function speedOf(step: SpeedStep): number {
  return Number(step.slice(1));
}

/** 淡入淡出档位。 */
export const FADES = ["none", "short", "medium", "long"] as const;

/** 淡入淡出档位。 */
export type FadeStep = (typeof FADES)[number];

/**
 * 淡入淡出档位 → 毫秒：有节拍时为半拍 / 2 拍 / 4 拍，没有节拍时为 0.25 / 1 / 2 秒。
 *
 * @param step 档位。
 * @param tempo 工程节拍。
 * @returns 毫秒。
 */
export function fadeOf(step: FadeStep, tempo: Tempo | null): number {
  if (step === "none") return 0;
  if (!tempo) return { short: 250, medium: 1000, long: 2000 }[step];
  const beat = 60_000 / tempo.bpm;
  return Math.round({ short: 0.5, medium: 2, long: 4 }[step] * beat);
}

/** 量化：色相 5°，饱和度 / 明度 5%，色温 100 K。 */
const HUE_STEP = 5;
const SV_STEP = 0.05;
const KELVIN_STEP = 100;

/**
 * 量化 RGB：转到 HSV 后对齐网格，再转回。不同模型给出的相近颜色（`#1E90FF` 与 `#1F8FFF`）落到同一个值。
 *
 * @param rgb sRGB 0~255。
 * @returns 量化后的 sRGB。
 */
export function quantizeRgb(rgb: Rgb): Rgb {
  const { h, s, v } = rgbToHsv(rgb);
  const q = (x: number, step: number) => Math.round(x / step) * step;
  return hsvToRgb({ h: q(h, HUE_STEP) % 360, s: clamp01(q(s, SV_STEP)), v: clamp01(q(v, SV_STEP)) });
}

/**
 * 解析颜色引用并量化。
 *
 * @param ref 命名色、`#rrggbb` 或 `3200K`（大小写不敏感）。
 * @returns 颜色；不认识时为 `null`。
 */
export function resolveColor(ref: string): ColorValue | null {
  const s = ref.trim();
  const named = COLOR_NAMES.find((n) => n.toLowerCase() === s.toLowerCase());
  if (named) return structuredClone(NAMED_COLORS[named]) as ColorValue;
  if (/^#[0-9a-f]{6}$/i.test(s)) {
    const n = Number.parseInt(s.slice(1), 16);
    return { kind: "rgb", rgb: quantizeRgb([(n >> 16) & 255, (n >> 8) & 255, n & 255]) };
  }
  const k = /^(\d{4,5})K$/i.exec(s);
  if (k) return { kind: "kelvin", kelvin: clamp(Math.round(Number(k[1]) / KELVIN_STEP) * KELVIN_STEP, 1000, 20_000) };
  return null;
}

/**
 * 颜色的 RGB（特效参数只接受 RGB；色温按近似色换算）。
 *
 * @param c 颜色。
 * @returns sRGB。
 */
export function colorRgb(c: ColorValue): Rgb {
  if (c.kind === "rgb") return [...c.rgb];
  if (c.kind === "kelvin") return kelvinRgb(c.kelvin);
  return [255, 255, 255];
}

/** 色温的近似 RGB（Tanner Helland 近似，够用于给特效参数取色）。 */
function kelvinRgb(kelvin: number): Rgb {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((x) => clamp(Math.round(x), 0, 255)) as Rgb;
}

/**
 * 量化强度（%）：取 5 的倍数，夹在 0~100。
 *
 * @param v 强度。
 * @returns 量化后的强度。
 */
export function quantizePercent(v: number): number {
  return clamp(Math.round(v / 5) * 5, 0, 100);
}

/**
 * 量化 0~1 的属性值：取 0.01 的倍数。
 *
 * @param v 值。
 * @returns 量化后的值。
 */
export function quantizeFraction(v: number): number {
  return Math.round(clamp01(v) * 100) / 100;
}
