import { resolvePatterns, type Capability, type ChannelFunction, type FixtureProperty } from "@/features/fixtures";

/**
 * 光束外观（纯逻辑，不依赖 three）：从灯具表的通道值算出图案、棱镜、频闪、光圈、雾化与聚焦。
 *
 * 换算规则（预览用的近似，不追求与实灯一致）：
 * - 图案：图案通道当前值所在的能力区间 → 区间的图案（指定的或按名称自动匹配的）；开光区间没有图案。
 * - 图案 / 棱镜旋转：比例区间按物理量（rpm / Hz）或区间内的位置（最快 0.5 转 / 秒）给转速，
 *   名称带 CCW / 逆 / reverse 的反向；角度 = 转速 × 播放头时间，所以暂停、拖动播放头时画面确定。
 * - 棱镜：非开光区间即插入；面数取名称里的数字（3~16），默认 3。
 * - 频闪：频闪区间按物理量（Hz）或区间内的位置（1~20 Hz）方波闪烁，亮占 30%；关光区间不出光。
 * - 光圈：0 为全开、1 为收到 15%；雾化加宽 40% 并柔化边缘；聚焦偏离中间值时图案变模糊。
 */

/** 一台灯光束相关通道的静态信息。 */
export interface BeamStatic {
  gobo: { caps: readonly Capability[]; patterns: readonly (string | null)[] } | null;
  goboRotate: readonly Capability[] | null;
  prism: readonly Capability[] | null;
  prismRotate: readonly Capability[] | null;
  shutter: readonly Capability[] | null;
  /** 有光圈 / 雾化 / 聚焦通道 */
  iris: boolean;
  frost: boolean;
  focus: boolean;
}

/** 用到的通道功能。 */
const BEAM_FUNCTIONS: readonly ChannelFunction[] = ["gobo", "goboRotate", "prism", "prismRotate", "shutter", "iris", "frost", "focus"];

/**
 * 从通道布局取光束相关的信息。
 *
 * @param layout 当前模式的通道布局。
 * @returns 静态信息；没有任何光束通道时为 `null`。
 */
export function beamStaticOf(layout: readonly FixtureProperty[]): BeamStatic | null {
  const find = (fn: ChannelFunction) => layout.find((p) => p.function === fn);
  if (!BEAM_FUNCTIONS.some((fn) => find(fn))) return null;
  const caps = (fn: ChannelFunction) => {
    const p = find(fn);
    return p ? (p.capabilities ?? []) : null;
  };
  const goboCaps = caps("gobo");
  return {
    gobo: goboCaps ? { caps: goboCaps, patterns: resolvePatterns(goboCaps) } : null,
    goboRotate: caps("goboRotate"),
    prism: caps("prism"),
    prismRotate: caps("prismRotate"),
    shutter: caps("shutter"),
    iris: !!find("iris"),
    frost: !!find("frost"),
    focus: !!find("focus"),
  };
}

/** 一个通道在这一帧的读数。 */
export interface BeamCell {
  /** DMX 值（按通道位宽） */
  dmx: number;
  /** 属性值 0~1 */
  fraction: number;
}

/** 这一帧的光束外观。 */
export interface BeamLook {
  /** 图案引用；没有图案时为 `null` */
  gobo: string | null;
  /** 图案旋转角（弧度） */
  goboAngle: number;
  /** 棱镜面数；0 为没有插入棱镜 */
  prism: number;
  /** 棱镜旋转角（弧度） */
  prismAngle: number;
  /** 光束角的倍数（光圈、雾化） */
  angleScale: number;
  /** 边缘与图案的柔化程度（0~1，雾化、失焦） */
  soft: number;
  /** 出光的倍数（频闪、关光）：0 或 1 */
  gate: number;
}

/** 没有光束通道的灯：开光、无图案。 */
export const OPEN_BEAM: BeamLook = { gobo: null, goboAngle: 0, prism: 0, prismAngle: 0, angleScale: 1, soft: 0, gate: 1 };

/**
 * 通道值所在的能力区间。
 *
 * @param caps 能力区间。
 * @param dmx DMX 值。
 * @returns 下标与区间；不在任何区间内时为 `null`。
 */
function capAt(caps: readonly Capability[], dmx: number): { index: number; cap: Capability } | null {
  const index = caps.findIndex((c) => dmx >= c.range[0] && dmx <= c.range[1]);
  return index >= 0 ? { index, cap: caps[index] } : null;
}

/** 值在区间内的位置（0~1）。 */
function within(cap: Capability, dmx: number): number {
  const [lo, hi] = cap.range;
  return hi > lo ? (dmx - lo) / (hi - lo) : 0;
}

/** 区间的物理量（按位置插值）。 */
function physicalAt(cap: Capability, dmx: number): number | null {
  if (!cap.physical) return null;
  const [a, b] = cap.physical;
  return a + (b - a) * within(cap, dmx);
}

const REVERSE = /ccw|counter|anti|reverse|逆|反/i;
const STOP = /stop|静止|停|index|位置/i;

/**
 * 旋转通道的转速（转 / 秒，带方向）。
 *
 * @param caps 能力区间（为空时按整段线性：中间停、两侧反向）。
 * @param cell 读数。
 * @returns 转速；停止或分度时为 0。
 */
export function rotationSpeed(caps: readonly Capability[], cell: BeamCell): number {
  if (caps.length === 0) return (cell.fraction - 0.5) * 2 * 0.5;
  const hit = capAt(caps, cell.dmx);
  if (!hit || !hit.cap.proportional || STOP.test(hit.cap.label) || hit.cap.tag === "noFunction") return 0;
  const sign = REVERSE.test(hit.cap.label) ? -1 : 1;
  const phys = physicalAt(hit.cap, cell.dmx);
  const unit = hit.cap.unit?.toLowerCase() ?? "";
  if (phys !== null && unit === "rpm") return (sign * phys) / 60;
  if (phys !== null && unit === "hz") return sign * phys;
  return sign * 0.5 * within(hit.cap, cell.dmx);
}

/**
 * 棱镜面数。
 *
 * @param caps 能力区间（为空时值大于一半即插入 3 棱）。
 * @param cell 读数。
 * @returns 面数；没有插入时为 0。
 */
export function prismFacets(caps: readonly Capability[], cell: BeamCell): number {
  if (caps.length === 0) return cell.fraction >= 0.5 ? 3 : 0;
  const hit = capAt(caps, cell.dmx);
  if (!hit) return 0;
  const { cap } = hit;
  if (cap.tag === "noFunction" || cap.tag === "shutterOpen" || /^\s*(open|out|off|none|无|关|开光|空)\s*$/i.test(cap.label)) return 0;
  const n = Number(/(\d+)/.exec(cap.label)?.[1] ?? 3);
  return Math.min(16, Math.max(3, Number.isFinite(n) ? n : 3));
}

/**
 * 快门 / 频闪通道在某一时刻是否出光。
 *
 * @param caps 能力区间（为空时总是出光）。
 * @param cell 读数。
 * @param tSec 播放头时间（秒）。
 * @returns 1 为出光，0 为不出光。
 */
export function shutterGate(caps: readonly Capability[], cell: BeamCell, tSec: number): number {
  if (caps.length === 0) return 1;
  const hit = capAt(caps, cell.dmx);
  if (!hit) return 1;
  const { cap } = hit;
  if (cap.tag === "shutterClosed") return 0;
  if (cap.tag !== "strobe") return 1;
  const phys = cap.unit?.toLowerCase() === "hz" ? physicalAt(cap, cell.dmx) : null;
  const hz = Math.max(0.2, phys ?? 1 + 19 * within(cap, cell.dmx));
  return tSec * hz - Math.floor(tSec * hz) < 0.3 ? 1 : 0;
}

/**
 * 这一帧的光束外观。
 *
 * @param s 静态信息（`null` 为没有光束通道）。
 * @param cell 取某个功能的读数；没有时为 `undefined`。
 * @param tSec 播放头时间（秒）。
 * @returns 光束外观。
 */
export function beamLookOf(s: BeamStatic | null, cell: (fn: ChannelFunction) => BeamCell | undefined, tSec: number): BeamLook {
  if (!s) return OPEN_BEAM;
  const turn = (caps: readonly Capability[] | null, fn: ChannelFunction) => {
    const c = caps ? cell(fn) : undefined;
    return caps && c ? rotationSpeed(caps, c) * tSec * Math.PI * 2 : 0;
  };
  let gobo: string | null = null;
  const g = s.gobo ? cell("gobo") : undefined;
  if (s.gobo && g) {
    const hit = capAt(s.gobo.caps, g.dmx);
    gobo = hit ? (s.gobo.patterns[hit.index] ?? null) : null;
  }
  const p = s.prism ? cell("prism") : undefined;
  const sh = s.shutter ? cell("shutter") : undefined;
  const iris = s.iris ? (cell("iris")?.fraction ?? 0) : 0;
  const frost = s.frost ? (cell("frost")?.fraction ?? 0) : 0;
  const focus = s.focus ? (cell("focus")?.fraction ?? 0.5) : 0.5;
  return {
    gobo,
    goboAngle: gobo ? turn(s.goboRotate, "goboRotate") : 0,
    prism: s.prism && p ? prismFacets(s.prism, p) : 0,
    prismAngle: turn(s.prismRotate, "prismRotate"),
    angleScale: (1 - 0.85 * iris) * (1 + 0.4 * frost),
    soft: Math.min(1, frost + Math.abs(focus - 0.5) * 1.2),
    gate: s.shutter && sh ? shutterGate(s.shutter, sh, tSec) : 1,
  };
}
