import { smoothNoise } from "./random";

/** 一个 Universe 的通道数。 */
export const CHANNELS = 512;

/** 图案名称。 */
export type PatternName =
  | "off"
  | "static"
  | "rainbow"
  | "chase"
  | "sine"
  | "pulse"
  | "strobe"
  | "noise"
  | "ramp";

/** 一个图案的参数（来自数据文件，全部可省略）。 */
export interface PatternSpec {
  pattern: PatternName;
  /** 起始通道（1 起，含）；默认 1 */
  from?: number;
  /** 结束通道（1 起，含）；默认 512 */
  to?: number;
  /** 每个灯具占用的通道数（RGB = 3，RGBW = 4）；默认 1 */
  fixture?: number;
  /** 速度，单位为“周期 / 秒”；默认 0.25 */
  speed?: number;
  /** 峰值电平 0~255；默认 255 */
  level?: number;
  /** 相位偏移 0~1；默认 0 */
  phase?: number;
  /** 噪声种子；默认 1 */
  seed?: number;
}

/** 节目里的一段：在 `[startSec, endSec)` 内使用某个图案，段内时间从 0 重新计。 */
export interface Segment extends PatternSpec {
  startSec?: number;
  endSec?: number;
}

/** 数据文件里的一个 Universe：直接内联一个图案，或给出分段列表。 */
export interface UniverseProgram extends Partial<PatternSpec> {
  universe: number;
  segments?: Segment[];
}

const TWO_PI = Math.PI * 2;

/** 取小数部分，结果在 `[0, 1)`。 */
function fract(x: number): number {
  return x - Math.floor(x);
}

/** 色相转换的复用缓冲：渲染是同步的，复用它可以避免每个灯具分配一个数组。 */
const RGB_SCRATCH: [number, number, number] = [0, 0, 0];

/**
 * 色相 `[0,1)` 转 RGB（饱和度与明度均为 1），各分量 `[0,1]`。
 *
 * 结果写进共享缓冲 {@link RGB_SCRATCH} 并返回它，调用方必须在下一次调用前用完。
 */
function hueToRgb(h: number): [number, number, number] {
  const h6 = h * 6;
  const i = Math.floor(h6);
  const f = h6 - i;
  const out = RGB_SCRATCH;
  switch (((i % 6) + 6) % 6) {
    case 0:
      out[0] = 1; out[1] = f; out[2] = 0;
      break;
    case 1:
      out[0] = 1 - f; out[1] = 1; out[2] = 0;
      break;
    case 2:
      out[0] = 0; out[1] = 1; out[2] = f;
      break;
    case 3:
      out[0] = 0; out[1] = 1 - f; out[2] = 1;
      break;
    case 4:
      out[0] = f; out[1] = 0; out[2] = 1;
      break;
    default:
      out[0] = 1; out[1] = 0; out[2] = 1 - f;
  }
  return out;
}

/**
 * 渲染某一时刻某个图案的 512 通道数据。
 *
 * 纯函数：同样的 `(spec, tSec)` 永远得到同样的结果，所以实时信号、回放通道、
 * 时间线概览与通道曲线可以共用同一个渲染器，彼此一致。
 *
 * # Arguments
 *
 * * `spec` - 图案参数。
 * * `tSec` - 图案内时间（秒）。
 *
 * # Returns
 *
 * 长度为 512 的整数数组（0~255）。
 */
export function renderPattern(spec: PatternSpec, tSec: number): number[] {
  const out = new Array<number>(CHANNELS).fill(0);
  if (spec.pattern === "off") return out;

  const from = Math.max(1, spec.from ?? 1);
  const to = Math.min(CHANNELS, spec.to ?? CHANNELS);
  if (to < from) return out;

  const fixture = Math.max(1, spec.fixture ?? 1);
  const speed = spec.speed ?? 0.25;
  const level = Math.max(0, Math.min(255, spec.level ?? 255));
  const phase = spec.phase ?? 0;
  const seed = spec.seed ?? 1;
  const fixtures = Math.ceil((to - from + 1) / fixture);
  const scale = level / 255;

  for (let fx = 0; fx < fixtures; fx += 1) {
    const first = from - 1 + fx * fixture;
    const along = fx / fixtures;
    // 该灯具的单一强度（0~1）；彩虹需要三色，单独处理
    let amount = 0;
    let rgb: [number, number, number] | null = null;

    switch (spec.pattern) {
      case "static":
        amount = 1;
        break;
      case "rainbow":
        rgb = hueToRgb(fract(phase + speed * tSec + along));
        break;
      case "chase": {
        const pos = fract(phase + speed * tSec) * fixtures;
        const raw = Math.abs(fx - pos);
        const dist = Math.min(raw, fixtures - raw);
        amount = Math.max(0, 1 - dist / 3);
        break;
      }
      case "sine":
        amount = 0.5 + 0.5 * Math.sin(TWO_PI * (speed * tSec + phase + fx * 0.07));
        break;
      case "pulse": {
        const s = 0.5 + 0.5 * Math.sin(TWO_PI * (speed * tSec + phase));
        amount = s * s;
        break;
      }
      case "strobe":
        amount = fract(speed * tSec + phase) < 0.5 ? 1 : 0;
        break;
      case "noise":
        amount = smoothNoise(fx * 0.35 + speed * tSec * 3, seed * 7919);
        break;
      case "ramp":
        amount = fract(speed * tSec + phase + along);
        break;
    }

    for (let sub = 0; sub < fixture; sub += 1) {
      const ch = first + sub;
      if (ch >= to) break;
      let v: number;
      if (rgb) {
        if (sub < 3) v = rgb[sub];
        // 第四通道当白光：取三色最小值，让 RGBW 灯具看起来合理
        else if (sub === 3) v = Math.min(rgb[0], rgb[1], rgb[2]);
        else v = 0;
      } else {
        v = amount;
      }
      out[ch] = Math.round(Math.max(0, Math.min(255, v * scale * 255)));
    }
  }
  return out;
}

/**
 * 把数据文件里的 Universe 条目规整为分段列表。
 *
 * # Arguments
 *
 * * `u` - 数据文件里的 Universe 条目。
 *
 * # Returns
 *
 * 分段列表；条目内联了图案时视为一整段。
 */
export function toSegments(u: UniverseProgram): Segment[] {
  if (u.segments && u.segments.length > 0) return u.segments;
  const { universe: _universe, segments: _segments, pattern, ...rest } = u;
  return [{ pattern: pattern ?? "off", ...rest }];
}

/**
 * 渲染节目里某个 Universe 在某一时刻的数据。
 *
 * # Arguments
 *
 * * `segments` - 该 Universe 的分段（见 {@link toSegments}）。
 * * `tSec` - 节目时间（秒）。
 *
 * # Returns
 *
 * 512 通道数据；不在任何分段内时全 0。
 */
export function renderSegments(segments: readonly Segment[], tSec: number): number[] {
  for (const seg of segments) {
    const start = seg.startSec ?? 0;
    const end = seg.endSec ?? Number.POSITIVE_INFINITY;
    if (tSec >= start && tSec < end) return renderPattern(seg, tSec - start);
  }
  return new Array<number>(CHANNELS).fill(0);
}
