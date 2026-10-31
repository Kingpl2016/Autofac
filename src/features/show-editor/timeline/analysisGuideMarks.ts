import type { TimelineAnalysis, TimelineEvent } from "../lib/mediaAnalysis";
import { START_LEFT } from "./timelineData";

/** 音乐分析参考线的纯计算（便于测试；组件见 `AnalysisGuides.tsx`）。 */

/** 一屏最多画多少条重拍线（太密时只画强的）。 */
const MAX_HIT_LINES = 400;

/** 一条参考线 / 一段渐强带（像素坐标，相对可见区左边缘）。 */
export interface GuideMark {
  key: string;
  kind: TimelineEvent["kind"];
  x: number;
  /** 渐强带的宽度 */
  width?: number;
  strength: number;
}

/**
 * 可见范围内的参考线（纯函数，便于测试）：只保留落在 `[左, 右]` 像素之内的事件，重拍太多时按强度保留前 400 条。
 *
 * @param events 事件（时间线毫秒）。
 * @param view 可见范围：滚动位置、宽度、缩放（像素 / 秒）。
 * @returns 参考线。
 */
export function guideMarks(events: readonly TimelineEvent[], view: { scrollLeft: number; width: number; pxPerSec: number }): GuideMark[] {
  const x = (ms: number) => START_LEFT + (ms / 1000) * view.pxPerSec - view.scrollLeft;
  const out: GuideMark[] = [];
  const hits: GuideMark[] = [];
  for (const e of events) {
    const x0 = x(e.atMs);
    const x1 = e.endMs === undefined ? x0 : x(e.endMs);
    if (x1 < -2 || x0 > view.width + 2) continue;
    const mark: GuideMark = { key: `${e.kind}-${e.atMs}`, kind: e.kind, x: x0, strength: e.strength, ...(e.endMs === undefined ? {} : { width: x1 - x0 }) };
    if (e.kind === "hit") hits.push(mark);
    else out.push(mark);
  }
  const keptHits = hits.length > MAX_HIT_LINES ? [...hits].sort((a, b) => b.strength - a.strength || a.x - b.x).slice(0, MAX_HIT_LINES).sort((a, b) => a.x - b.x) : hits;
  return [...keptHits, ...out];
}

/**
 * 当前分析的概要（工具条用）。
 *
 * @param analysis 分析。
 * @returns 各类事件的数量。
 */
export function guideCounts(analysis: TimelineAnalysis | null): Record<TimelineEvent["kind"], number> {
  const out: Record<TimelineEvent["kind"], number> = { hit: 0, build: 0, drop: 0, break: 0, cut: 0 };
  for (const e of analysis?.events ?? []) out[e.kind] += 1;
  return out;
}
