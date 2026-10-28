import type { Tempo, Track } from "../lib/project";
import { START_LEFT } from "./timelineData";

/**
 * 自研时间线的纯几何：轨道行高与纵向虚拟化、可见时间范围、标尺刻度。
 *
 * 与 DOM 无关，便于单测；组件只负责把结果画出来。
 */

/** 轨道高度档位（像素）。 */
export const TRACK_HEIGHTS = { compact: 28, normal: 44, tall: 72 } as const;

/** 折叠轨道（分组 / 场景）的高度。 */
export const COLLAPSED_HEIGHT = 20;

/** 轨道区底部多留的空白（像素），方便在最后一条轨道下方开始框选。 */
export const BODY_BOTTOM_PAD = 40;

/**
 * 轨道的显示高度。
 *
 * @param track 轨道。
 * @returns 像素。
 */
export function trackHeight(track: Pick<Track, "height" | "collapsed">): number {
  if (track.collapsed) return COLLAPSED_HEIGHT;
  return TRACK_HEIGHTS[track.height ?? "normal"];
}

/** 全部轨道的纵向排布。 */
export interface RowLayout {
  /** 每行顶边（像素，相对轨道区顶部） */
  tops: number[];
  /** 每行高度 */
  heights: number[];
  /** 总高度 */
  total: number;
}

/**
 * 计算轨道的纵向排布。
 *
 * @param tracks 轨道（显示顺序）。
 * @returns 排布。
 */
export function rowLayout(tracks: readonly Pick<Track, "height" | "collapsed">[]): RowLayout {
  const tops: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (const t of tracks) {
    tops.push(y);
    const h = trackHeight(t);
    heights.push(h);
    y += h;
  }
  return { tops, heights, total: y };
}

/**
 * 纵坐标落在哪一行（二分查找）。
 *
 * @param layout 排布。
 * @param y 相对轨道区顶部的纵坐标（含滚动）。
 * @returns 行下标；在所有行之外时为 `-1`。
 */
export function rowAt(layout: RowLayout, y: number): number {
  if (y < 0 || y >= layout.total) return -1;
  let lo = 0;
  let hi = layout.tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 视口里可见的行（纵向虚拟化），前后各多渲染 `overscan` 行。
 *
 * @param layout 排布。
 * @param scrollTop 纵向滚动距离。
 * @param height 视口高度。
 * @param overscan 额外渲染的行数。
 * @returns `[起始行, 结束行)`；没有行时为 `[0, 0]`。
 */
export function visibleRows(layout: RowLayout, scrollTop: number, height: number, overscan = 3): [number, number] {
  const n = layout.tops.length;
  if (n === 0) return [0, 0];
  const first = Math.max(0, rowAt(layout, Math.min(Math.max(0, scrollTop), layout.total - 1)));
  let last = first;
  while (last < n && layout.tops[last] < scrollTop + height) last += 1;
  return [Math.max(0, first - overscan), Math.min(n, last + overscan)];
}

/**
 * 视口对应的时间范围（横向虚拟化：只渲染与之相交的片段），两侧各多留 `marginPx`。
 *
 * @param scrollLeft 横向滚动距离。
 * @param width 视口宽度。
 * @param pxPerSec 每秒像素数。
 * @param marginPx 额外留的像素。
 * @returns `[起点, 终点]`（毫秒）。
 */
export function visibleTimeRange(scrollLeft: number, width: number, pxPerSec: number, marginPx = 200): [number, number] {
  const from = ((scrollLeft - START_LEFT - marginPx) / pxPerSec) * 1000;
  const to = ((scrollLeft - START_LEFT + width + marginPx) / pxPerSec) * 1000;
  return [Math.max(0, from), to];
}

/** 标尺的一个主刻度。 */
export interface MajorTick {
  ms: number;
  label: string;
}

/** 标尺刻度。 */
export interface Ticks {
  major: MajorTick[];
  minor: number[];
  /** 主刻度间隔（毫秒） */
  stepMs: number;
}

/** 一帧的毫秒数（30 FPS）。 */
const FRAME_MS = 1000 / 30;

/** 候选主刻度间隔（毫秒），从细到粗。帧级间隔用帧数表示。 */
const STEPS = [
  FRAME_MS,
  FRAME_MS * 2,
  FRAME_MS * 5,
  FRAME_MS * 10,
  FRAME_MS * 15,
  1000,
  2000,
  5000,
  10_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
  900_000,
  1_800_000,
  3_600_000,
];

/** 主刻度之间至少这么宽（像素），放得下文字。 */
export const MIN_MAJOR_GAP_PX = 72;

/** 次刻度之间至少这么宽（像素）。 */
const MIN_MINOR_GAP_PX = 8;

/**
 * 刻度文字：整秒为 `m:ss`（一小时以上 `h:mm:ss`），秒内为帧号 `12f`（剪映的写法）。
 *
 * @param ms 刻度时刻。
 * @returns 文字。
 */
export function tickLabel(ms: number): string {
  const frames = Math.round(ms / FRAME_MS);
  const sec = Math.floor(frames / 30);
  const f = frames % 30;
  if (f !== 0) return `${f}f`;
  const s = sec % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * 按缩放选择刻度间隔，并列出 `[fromMs, toMs]` 内的刻度。
 *
 * @param pxPerSec 每秒像素数。
 * @param fromMs 可见范围起点。
 * @param toMs 可见范围终点。
 * @returns 主 / 次刻度。
 */
export function rulerTicks(pxPerSec: number, fromMs: number, toMs: number): Ticks {
  const pxPerMs = pxPerSec / 1000;
  const stepMs = STEPS.find((s) => s * pxPerMs >= MIN_MAJOR_GAP_PX) ?? STEPS[STEPS.length - 1];
  // 次刻度：把主刻度等分成 5 / 4 / 2 份中最细且不挤的
  const div = [5, 4, 2].find((d) => (stepMs / d) * pxPerMs >= MIN_MINOR_GAP_PX) ?? 1;
  const minorStep = stepMs / div;
  const from = Math.max(0, fromMs);
  const major: MajorTick[] = [];
  const minor: number[] = [];
  const first = Math.floor(from / stepMs);
  for (let i = first; i * stepMs <= toMs; i += 1) {
    const ms = Math.round(i * stepMs);
    if (ms >= from) major.push({ ms, label: tickLabel(ms) });
    if (div > 1) {
      for (let k = 1; k < div; k += 1) {
        const m = Math.round(i * stepMs + k * minorStep);
        if (m >= from && m <= toMs) minor.push(m);
      }
    }
    if (major.length > 2000) break;
  }
  return { major, minor, stepMs };
}

/** 小节·拍刻度里，每隔几小节标一次（按缩放取不挤的那一档）。 */
const BAR_STEPS = [1, 2, 4, 8, 16, 32, 64, 128] as const;

/**
 * 小节·拍刻度：主刻度在小节线上（标 `小节`，缩放到能看清每拍时在拍上标 `小节.拍`），次刻度在拍上。
 *
 * @param tempo 节拍设置（BPM、第一拍偏移、每小节拍数）。
 * @param pxPerSec 每秒像素数。
 * @param fromMs 可见范围起点。
 * @param toMs 可见范围终点。
 * @returns 主 / 次刻度；`stepMs` 为主刻度间隔。
 */
export function barTicks(tempo: Pick<Tempo, "bpm" | "offsetMs" | "beatsPerBar">, pxPerSec: number, fromMs: number, toMs: number): Ticks {
  const beatMs = 60_000 / Math.max(1, tempo.bpm);
  const perBar = Math.max(1, Math.floor(tempo.beatsPerBar));
  const pxPerMs = pxPerSec / 1000;
  const beatPx = beatMs * pxPerMs;
  // 每拍够宽时每拍都标（小节.拍），否则按小节步长标
  const labelBeats = beatPx >= MIN_MAJOR_GAP_PX;
  const barStep = BAR_STEPS.find((n) => n * perBar * beatPx >= MIN_MAJOR_GAP_PX) ?? BAR_STEPS[BAR_STEPS.length - 1];
  const showMinor = beatPx >= MIN_MINOR_GAP_PX;
  const from = Math.max(0, fromMs);
  const first = Math.ceil((from - tempo.offsetMs) / beatMs);
  const last = Math.floor((toMs - tempo.offsetMs) / beatMs);
  const major: MajorTick[] = [];
  const minor: number[] = [];
  for (let k = Math.max(first, Math.ceil(-tempo.offsetMs / beatMs)); k <= last; k += 1) {
    const ms = Math.round(tempo.offsetMs + k * beatMs);
    if (ms < from) continue;
    const bar = Math.floor(k / perBar);
    const inBar = k - bar * perBar;
    const isMajor = labelBeats || (inBar === 0 && bar % barStep === 0);
    if (isMajor) major.push({ ms, label: labelBeats ? `${bar + 1}.${inBar + 1}` : String(bar + 1) });
    else if (showMinor) minor.push(ms);
    if (major.length + minor.length > 4000) break;
  }
  return { major, minor, stepMs: labelBeats ? beatMs : barStep * perBar * beatMs };
}
