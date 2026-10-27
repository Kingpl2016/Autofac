import type { EffectCue, EffectId, Rgb, Tempo } from "./project";

/**
 * 特效求值的前端镜像（只用于预览色块）。
 *
 * 公式与后端 `show-engine/src/effects.rs` 逐一对应：只用加减乘除、取整与比较，
 * 不用 `sin` / `cos` / `exp`，所以两边在 IEEE 754 下逐位一致，并共用
 * `__tests__/golden/show-eval.json` 黄金向量。
 */

/** 周期下限（毫秒）：低于一个输出帧没有意义。 */
export const MIN_PERIOD_MS = 33;

/** 没有节拍设置时按拍数换算所用的 BPM。 */
export const FALLBACK_BPM = 120;

/** 频闪的最高建议频率（Hz）：超过会让人不适，界面据此给出提醒。 */
export const MAX_SAFE_STROBE_HZ = 10;

/** 闪烁特效里每个时间步某台灯具被点亮的概率。 */
const SPARKLE_DENSITY = 0.3;

/** 频闪的占空比（亮的比例）。 */
const STROBE_DUTY = 0.5;

/** 一次采样结果：颜色（各分量 0~1）与强度调制（0 取亮度范围下限，1 取上限）。 */
export interface EffectSample {
  rgb: [number, number, number];
  modulation: number;
}

const fract = (x: number): number => x - Math.floor(x);

const smooth = (x: number): number => {
  const v = Math.min(1, Math.max(0, x));
  return v * v * (3 - 2 * v);
};

/**
 * 特效周期换算成毫秒。
 *
 * @param period Cue 里的周期设置。
 * @param tempo 工程的节拍设置；按拍数时使用，缺省按 120 BPM。
 * @returns 毫秒周期，不小于 {@link MIN_PERIOD_MS}。
 */
export function periodMs(period: EffectCue["period"], tempo: Tempo | null): number {
  let ms: number;
  if (period.kind === "ms") {
    ms = period.ms;
  } else {
    const bpm = tempo && Number.isFinite(tempo.bpm) && tempo.bpm > 0 ? tempo.bpm : FALLBACK_BPM;
    ms = (period.beats * 60_000) / bpm;
  }
  return Number.isFinite(ms) ? Math.max(MIN_PERIOD_MS, ms) : MIN_PERIOD_MS;
}

/**
 * 确定性的 32 位整数哈希（闪烁特效的随机源），与后端 `hash32` 相同。
 *
 * @param seed Cue 的随机种子。
 * @param index 灯具序号。
 * @param step 时间步序号。
 * @returns 无符号 32 位整数。
 */
export function hash32(seed: number, index: number, step: number): number {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(step + 1, 0x85ebca6b)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

function hueToRgb(h: number): [number, number, number] {
  const h6 = fract(h) * 6;
  const i = Math.floor(h6);
  const f = h6 - i;
  switch (i) {
    case 0:
      return [1, f, 0];
    case 1:
      return [1 - f, 1, 0];
    case 2:
      return [0, 1, f];
    case 3:
      return [0, 1 - f, 1];
    case 4:
      return [f, 0, 1];
    default:
      return [1, 0, 1 - f];
  }
}

const toFraction = (c: Rgb): [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255];

function cycleColor(colors: Rgb[], pos: number): [number, number, number] {
  const n = colors.length;
  if (n === 1) return toFraction(colors[0]);
  const s = fract(pos) * n;
  const i = Math.floor(s);
  const f = s - i;
  const a = toFraction(colors[i % n]);
  const b = toFraction(colors[(i + 1) % n]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * 渲染特效在某台灯具上的瞬时结果。
 *
 * @param cue 特效 Cue。
 * @param tempo 工程的节拍设置。
 * @param elapsedMs 距 Cue 起点的毫秒数。
 * @param index 灯具在轨道成员（分组顺序）里的序号，从 0 起。
 * @param count 轨道成员总数。
 * @returns 颜色与强度调制。
 */
export function sampleEffect(
  cue: Pick<EffectCue, "effect" | "colors" | "period" | "phaseSpread" | "direction" | "seed">,
  tempo: Tempo | null,
  elapsedMs: number,
  index: number,
  count: number,
): EffectSample {
  const colors: Rgb[] = cue.colors.length > 0 ? cue.colors : [[255, 255, 255]];
  const total = Math.max(1, count);
  const clamped = Math.min(Math.max(0, index), total - 1);
  const p = cue.direction < 0 ? total - 1 - clamped : clamped;
  const period = periodMs(cue.period, tempo);
  const cycles = Math.max(0, elapsedMs) / period;
  const spread = Math.min(1, Math.max(0, cue.phaseSpread));
  const c = fract(cycles + spread * (p / total));
  const first = toFraction(colors[0]);
  return renderEffect(cue.effect, { colors, first, p, n: total, cycles, c, spread, seed: cue.seed });
}

interface EffectInputs {
  colors: Rgb[];
  first: [number, number, number];
  p: number;
  n: number;
  cycles: number;
  c: number;
  spread: number;
  seed: number;
}

function renderEffect(effect: EffectId, e: EffectInputs): EffectSample {
  switch (effect) {
    case "breathe":
      return { rgb: e.first, modulation: smooth(1 - Math.abs(2 * e.c - 1)) };
    case "rainbow":
      return { rgb: hueToRgb(e.c), modulation: 1 };
    case "chase": {
      const head = fract(e.cycles) * e.n;
      const diff = Math.abs(e.p - head);
      const dist = Math.min(diff, e.n - diff);
      const tail = 1 + e.spread * (e.n - 1);
      return { rgb: e.first, modulation: Math.min(1, Math.max(0, 1 - dist / tail)) };
    }
    case "wipe": {
      if ((e.p + 0.5) / e.n <= fract(e.cycles)) return { rgb: e.first, modulation: 1 };
      if (e.colors.length > 1) return { rgb: toFraction(e.colors[1]), modulation: 1 };
      return { rgb: e.first, modulation: 0 };
    }
    case "gradient":
      return { rgb: cycleColor(e.colors, (e.p / e.n) * e.spread + e.cycles), modulation: 1 };
    case "pulse": {
      const k = 1 - e.c;
      return { rgb: e.first, modulation: k * k * k };
    }
    case "sparkle": {
      const step = Math.max(0, Math.floor(e.cycles));
      const h = hash32(e.seed, e.p, step);
      if (h / 4_294_967_296 < SPARKLE_DENSITY) {
        const pick = e.colors[(h >>> 8) % e.colors.length];
        return { rgb: toFraction(pick), modulation: 1 - fract(e.cycles) };
      }
      return { rgb: e.first, modulation: 0 };
    }
    case "strobe":
      return { rgb: e.first, modulation: e.c < STROBE_DUTY ? 1 : 0 };
  }
}

/**
 * 特效的闪烁频率（Hz）。频闪、闪烁和脉冲类特效超过 {@link MAX_SAFE_STROBE_HZ} 时界面会提醒。
 *
 * @param period 周期设置。
 * @param tempo 节拍设置。
 * @returns 每秒周期数。
 */
export function effectRateHz(period: EffectCue["period"], tempo: Tempo | null): number {
  return 1000 / periodMs(period, tempo);
}
