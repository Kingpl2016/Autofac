import { clamp01 } from "@/shared/lib/math";
import { MAX_SAFE_STROBE_HZ, periodMs } from "./effects";
import type { ColorValue, EffectCue, Keyframe, Look, Rgb, Spread, Tempo, ValueCurve } from "./project";

/**
 * 属性特效（新引擎）：用数值曲线 + 多灯分布生成外观片段，驱动任意属性——
 * 位置画圆 / 8 字 / 扫动，强度波浪 / 追逐 / 频闪，颜色彩虹。
 *
 * 与旧的 RGB 特效不同，它们是普通的外观片段：可以和别的层叠加（例如画圆 + 颜色），
 * 在属性面板里改曲线和分布，按拍同步。求值完全由引擎完成。
 */

/** 属性特效。 */
export type AttrEffectId =
  | "circle"
  | "figure8"
  | "panSweep"
  | "tiltSweep"
  | "intensityWave"
  | "intensityChase"
  | "strobe"
  | "rainbow";

/** 素材库里的顺序。 */
export const ATTR_EFFECTS: readonly AttrEffectId[] = [
  "circle",
  "figure8",
  "panSweep",
  "tiltSweep",
  "intensityWave",
  "intensityChase",
  "strobe",
  "rainbow",
];

/** 属性特效的参数。 */
export interface AttrEffectParams {
  /** 一个周期：毫秒，或按 BPM 的拍数 */
  period: EffectCue["period"];
  /** 幅度（位置类：0~0.5 的 DMX 分数半径；强度类：0~100%） */
  size: number;
  /** 片段长度（毫秒） */
  lengthMs: number;
  /** 轨道成员数（分组轨道上按成员错开相位；1 台时不分布） */
  members: number;
}

/** 生成结果。 */
export interface AttrEffectLook {
  look: Look;
  spread?: Spread;
}

/** 各特效的默认参数（不含长度与成员数）。 */
export const ATTR_EFFECT_DEFAULTS: Record<AttrEffectId, Pick<AttrEffectParams, "period" | "size">> = {
  circle: { period: { kind: "beats", beats: 4 }, size: 0.15 },
  figure8: { period: { kind: "beats", beats: 8 }, size: 0.15 },
  panSweep: { period: { kind: "beats", beats: 4 }, size: 0.25 },
  tiltSweep: { period: { kind: "beats", beats: 4 }, size: 0.2 },
  intensityWave: { period: { kind: "beats", beats: 2 }, size: 100 },
  intensityChase: { period: { kind: "beats", beats: 1 }, size: 100 },
  strobe: { period: { kind: "ms", ms: 125 }, size: 100 },
  rainbow: { period: { kind: "beats", beats: 8 }, size: 100 },
};

/** 片段内的循环次数（引擎要求不少于 1）。 */
function cyclesFor(lengthMs: number, period: EffectCue["period"], tempo: Tempo | null): number {
  return Math.max(1, Math.round((lengthMs / periodMs(period, tempo)) * 100) / 100);
}

const curve = (c: ValueCurve) => ({ kind: "curve" as const, curve: c });

/** 彩虹的关键帧：沿色相走一圈（R → Y → G → C → B → M → R），每个周期一圈。 */
function rainbowKeys(lengthMs: number, cycles: number): Keyframe<ColorValue>[] {
  const hues: Rgb[] = [
    [255, 0, 0],
    [255, 255, 0],
    [0, 255, 0],
    [0, 255, 255],
    [0, 0, 255],
    [255, 0, 255],
  ];
  const keys: Keyframe<ColorValue>[] = [];
  const period = lengthMs / cycles;
  // 关键帧太多没有意义：最多 60 圈
  const loops = Math.min(60, Math.ceil(cycles));
  for (let c = 0; c < loops; c += 1) {
    hues.forEach((rgb, i) => {
      const t = Math.round(c * period + (i * period) / hues.length);
      if (t <= lengthMs) keys.push({ tMs: t, value: { kind: "rgb", rgb }, curve: "linear" });
    });
  }
  keys.push({ tMs: Math.round(Math.min(lengthMs, loops * period)), value: { kind: "rgb", rgb: [255, 0, 0] }, curve: "linear" });
  return keys;
}

/**
 * 生成属性特效的外观。
 *
 * @param id 特效。
 * @param params 参数。
 * @param tempo 工程节拍（按拍的周期用）。
 * @returns 外观与分布（分组轨道上按成员错开相位：画圆成扇形、强度成波浪 / 追逐）。
 */
export function buildAttrEffect(id: AttrEffectId, params: AttrEffectParams, tempo: Tempo | null): AttrEffectLook {
  const cycles = cyclesFor(params.lengthMs, params.period, tempo);
  const n = Math.max(1, Math.floor(params.members));
  const r = Math.min(0.5, Math.max(0, params.size));
  const pct = Math.min(100, Math.max(0, params.size));
  // 成员相位：0 → -(n-1)/n，第一台领先、依次跟随
  const phaseSpread = (span: number): Spread | undefined =>
    n > 1 ? { values: { phase: { from: 0, to: -span * ((n - 1) / n) } } } : undefined;

  switch (id) {
    case "circle":
      return {
        look: {
          intensity: { kind: "value", value: 100 },
          attrs: {
            pan: curve({ shape: "sine", from: clamp01(0.5 - r), to: clamp01(0.5 + r), cycles, phase: 0 }),
            tilt: curve({ shape: "sine", from: clamp01(0.5 - r), to: clamp01(0.5 + r), cycles, phase: 0.25 }),
          },
        },
        spread: phaseSpread(1),
      };
    case "figure8":
      return {
        look: {
          intensity: { kind: "value", value: 100 },
          attrs: {
            pan: curve({ shape: "sine", from: clamp01(0.5 - r), to: clamp01(0.5 + r), cycles, phase: 0 }),
            tilt: curve({ shape: "sine", from: clamp01(0.5 - r / 2), to: clamp01(0.5 + r / 2), cycles: Math.min(1000, cycles * 2), phase: 0.25 }),
          },
        },
        spread: phaseSpread(1),
      };
    case "panSweep":
      return {
        look: {
          intensity: { kind: "value", value: 100 },
          attrs: { pan: curve({ shape: "triangle", from: clamp01(0.5 - r), to: clamp01(0.5 + r), cycles, phase: 0 }) },
        },
        spread: phaseSpread(0.5),
      };
    case "tiltSweep":
      return {
        look: {
          intensity: { kind: "value", value: 100 },
          attrs: { tilt: curve({ shape: "triangle", from: clamp01(0.5 - r), to: clamp01(0.5 + r), cycles, phase: 0 }) },
        },
        spread: phaseSpread(0.5),
      };
    case "intensityWave":
      return {
        look: { intensity: curve({ shape: "sine", from: 0, to: pct, cycles, phase: 0 }) },
        spread: phaseSpread(1),
      };
    case "intensityChase":
      // 每个周期每台灯亮 1/n 的时间，相位依次错开：轮流点亮
      return {
        look: { intensity: curve({ shape: "square", from: 0, to: pct, cycles, phase: 0, duty: 1 / n }) },
        spread: phaseSpread(1),
      };
    case "strobe":
      return { look: { intensity: curve({ shape: "square", from: 0, to: pct, cycles, phase: 0, duty: 0.5 }) } };
    case "rainbow":
      return {
        look: { intensity: { kind: "value", value: 100 }, color: { kind: "keys", keys: rainbowKeys(params.lengthMs, cycles) } },
        spread: n > 1 ? { values: { hue: { from: 0, to: 360 * ((n - 1) / n) } } } : undefined,
      };
  }
}

/**
 * 外观里频率最高的强度方波 / 曲线的闪烁频率（Hz），用于频闪安全提示。
 *
 * @param look 外观。
 * @param lengthMs 片段长度。
 * @returns 每秒闪烁次数；强度不是曲线时为 0。
 */
export function flashRateHz(look: Look, lengthMs: number): number {
  const p = look.intensity;
  if (p?.kind !== "curve" || lengthMs <= 0) return 0;
  if (p.curve.shape === "ramp") return 0;
  return (Math.max(1, p.curve.cycles) * 1000) / lengthMs;
}

/**
 * 是否超过频闪安全频率。
 *
 * @param look 外观。
 * @param lengthMs 片段长度。
 * @returns 超过 [`MAX_SAFE_STROBE_HZ`] 时为 `true`。
 */
export function unsafeFlash(look: Look, lengthMs: number): boolean {
  return flashRateHz(look, lengthMs) > MAX_SAFE_STROBE_HZ;
}

/** 能转换成属性特效的旧 RGB 特效。 */
export const CONVERTIBLE_EFFECTS: ReadonlySet<EffectCue["effect"]> = new Set(["breathe", "pulse", "strobe", "chase", "rainbow"]);

/**
 * 把旧 RGB 特效片段换算成等价的属性特效外观（呼吸 → 强度正弦、脉冲 → 锯齿、频闪 → 方波、追逐 → 相位追逐、彩虹 → 色相循环）。
 *
 * 颜色取特效的第一个颜色，亮度范围映射到曲线的起止值，相位扩散映射到分布的相位偏移。
 *
 * @param cue 特效片段。
 * @param members 轨道成员数。
 * @param tempo 工程节拍。
 * @returns 外观与分布；不能转换的特效（擦除、渐变、闪烁）为 `null`。
 */
export function lookFromLegacyEffect(cue: EffectCue, members: number, tempo: Tempo | null): AttrEffectLook | null {
  if (!CONVERTIBLE_EFFECTS.has(cue.effect)) return null;
  const lengthMs = cue.endMs - cue.startMs;
  const cycles = cyclesFor(lengthMs, cue.period, tempo);
  const [lo, hi] = [Math.min(...cue.range), Math.max(...cue.range)];
  const color = { kind: "value" as const, value: { kind: "rgb", rgb: [...(cue.colors[0] ?? [255, 255, 255])] } as ColorValue };
  const n = Math.max(1, members);
  const phase = n > 1 && cue.phaseSpread > 0 ? { phase: { from: 0, to: -cue.phaseSpread * cue.direction } } : undefined;
  switch (cue.effect) {
    case "breathe":
      return { look: { color, intensity: curve({ shape: "sine", from: lo, to: hi, cycles, phase: 0 }) }, spread: phase && { values: phase } };
    case "pulse":
      return { look: { color, intensity: curve({ shape: "saw", from: hi, to: lo, cycles, phase: 0 }) }, spread: phase && { values: phase } };
    case "strobe":
      return { look: { color, intensity: curve({ shape: "square", from: lo, to: hi, cycles, phase: 0, duty: 0.5 }) } };
    case "chase":
      return {
        look: { color, intensity: curve({ shape: "square", from: lo, to: hi, cycles, phase: 0, duty: 1 / n }) },
        spread: n > 1 ? { values: { phase: { from: 0, to: (-(n - 1) / n) * cue.direction } } } : undefined,
      };
    case "rainbow":
      return {
        look: { intensity: { kind: "value", value: hi }, color: { kind: "keys", keys: rainbowKeys(lengthMs, cycles) } },
        spread: n > 1 && cue.phaseSpread > 0 ? { values: { hue: { from: 0, to: 360 * cue.phaseSpread * cue.direction } } } : undefined,
      };
    default:
      return null;
  }
}
