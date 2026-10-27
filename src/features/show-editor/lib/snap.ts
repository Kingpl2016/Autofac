import type { ShowProject } from "./project";
import { beatsBetween } from "./tempo";

/** 吸附的默认触发距离（像素）：指针离目标这么近就吸过去。 */
export const SNAP_THRESHOLD_PX = 10;

/**
 * 把时间吸附到最近的目标。
 *
 * @param timeMs 原始时间（毫秒）。
 * @param targets 可吸附的时间点。
 * @param thresholdMs 吸附距离（毫秒）；离最近目标超过它就不吸附。
 * @returns 吸附后的时间；没有目标在范围内时原样返回。
 */
export function snapValue(timeMs: number, targets: readonly number[], thresholdMs: number): number {
  let best = timeMs;
  let bestDist = thresholdMs;
  for (const t of targets) {
    const d = Math.abs(t - timeMs);
    if (d <= bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/**
 * 收集吸附目标：工程起止、播放头、标记点、其他 Cue 的边缘和节拍点。
 *
 * @param project 工程（只读）。
 * @param playheadMs 播放头位置。
 * @param excludeCueIds 不参与的 Cue（正在被拖动的那些）。
 * @returns 去重后的时间点。
 */
export function collectSnapTargets(
  project: Pick<ShowProject, "cues" | "markers" | "tempo" | "durationMs">,
  playheadMs: number,
  excludeCueIds: ReadonlySet<string> = new Set(),
): number[] {
  const targets = new Set<number>([0, project.durationMs, playheadMs]);
  for (const m of project.markers) targets.add(m.timeMs);
  for (const c of project.cues) {
    if (excludeCueIds.has(c.id)) continue;
    targets.add(c.startMs);
    targets.add(c.endMs);
  }
  if (project.tempo) {
    for (const b of beatsBetween(project.tempo, 0, project.durationMs, 20_000)) targets.add(b.timeMs);
  }
  return [...targets];
}

/** 一个 Cue 的起止时间。 */
export interface Span {
  startMs: number;
  endMs: number;
}

/**
 * 对一次拖动 / 拉伸的结果做吸附。
 *
 * - 只改了起点（左边缘拉伸）：吸附起点；只改了终点：吸附终点；
 * - 起止都变了（整体移动）：起点和终点各自找最近的目标，取吸附距离更小的那个，整体平移相同的量，
 *   所以 Cue 的长度保持不变。
 *
 * @param next 拖动后的起止时间。
 * @param original 拖动前的起止时间。
 * @param targets 吸附目标。
 * @param thresholdMs 吸附距离（毫秒）。
 * @returns 吸附后的起止时间。
 */
export function snapSpan(
  next: Span,
  original: Span,
  targets: readonly number[],
  thresholdMs: number,
): Span {
  const startChanged = next.startMs !== original.startMs;
  const endChanged = next.endMs !== original.endMs;
  if (startChanged && !endChanged) {
    return { startMs: snapValue(next.startMs, targets, thresholdMs), endMs: next.endMs };
  }
  if (endChanged && !startChanged) {
    return { startMs: next.startMs, endMs: snapValue(next.endMs, targets, thresholdMs) };
  }
  if (!startChanged && !endChanged) return next;
  const dStart = snapValue(next.startMs, targets, thresholdMs) - next.startMs;
  const dEnd = snapValue(next.endMs, targets, thresholdMs) - next.endMs;
  const snappedStart = Math.abs(dStart) <= thresholdMs && snapValue(next.startMs, targets, thresholdMs) !== next.startMs;
  const snappedEnd = Math.abs(dEnd) <= thresholdMs && snapValue(next.endMs, targets, thresholdMs) !== next.endMs;
  let delta = 0;
  if (snappedStart && snappedEnd) delta = Math.abs(dStart) <= Math.abs(dEnd) ? dStart : dEnd;
  else if (snappedStart) delta = dStart;
  else if (snappedEnd) delta = dEnd;
  return { startMs: next.startMs + delta, endMs: next.endMs + delta };
}

/**
 * 像素距离换算成毫秒。
 *
 * @param px 像素。
 * @param pxPerSec 每秒像素数。
 */
export function pxToMs(px: number, pxPerSec: number): number {
  return (px / pxPerSec) * 1000;
}
