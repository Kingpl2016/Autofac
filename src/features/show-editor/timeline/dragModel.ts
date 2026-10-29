import { checkPlacements, gapAround, MIN_CUE_MS, trackAccepts, type CuePlacement } from "../lib/cueOps";
import type { ShowProject } from "../lib/project";
import { clamp } from "@/shared/lib/math";
import { snapToFrame } from "../lib/time";

/**
 * 时间线拖动的纯计算（剪映式）：移动（可多选、可换轨）、左右裁剪，实时吸附并给出吸附线位置。
 *
 * 拖动过程中每次指针移动都调用一次，结果只用于预览；松手时把 `placements` 交给 `placeCues` 写入工程。
 */

/** 拖动类型。 */
export type DragKind = "move" | "trimStart" | "trimEnd";

/** 一次拖动的输入。 */
export interface DragInput {
  kind: DragKind;
  /** 被拖动的片段：移动时为全部选中的片段，裁剪时为被抓住的那一个 */
  ids: readonly string[];
  /** 指针横向位移换算的时间（毫秒） */
  deltaMs: number;
  /** 指针纵向跨过的轨道数（只用于移动） */
  rowDelta: number;
  /** 吸附目标；`null` 为不吸附 */
  snapTargets: readonly number[] | null;
  /** 吸附距离（毫秒） */
  thresholdMs: number;
}

/** 一次拖动的结果。 */
export interface DragResult {
  placements: CuePlacement[];
  /** 吸附到的时刻（画黄色吸附线）；没有吸附时为 `null` */
  guideMs: number | null;
  /** 放下后能否生效（否则预览标红，松手时还原） */
  valid: boolean;
  /** 实际采用的换轨行数（目标轨道不可用时退回 0） */
  rowDelta: number;
}

/**
 * 在吸附目标里找离 `values` 中任一值最近的那个，返回需要的调整量。
 *
 * @param values 候选时刻（例如片段的起点和终点）。
 * @param targets 吸附目标。
 * @param thresholdMs 吸附距离。
 * @returns 调整量与吸附到的目标；都不在范围内时为 `null`。
 */
function bestSnap(
  values: readonly number[],
  targets: readonly number[],
  thresholdMs: number,
): { adjust: number; target: number } | null {
  let best: { adjust: number; target: number } | null = null;
  for (const v of values) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) <= thresholdMs && (!best || Math.abs(d) < Math.abs(best.adjust))) best = { adjust: d, target: t };
    }
  }
  return best;
}

/**
 * 计算拖动的预览位置。
 *
 * @param project 拖动开始时的工程（只读）。
 * @param input 拖动输入。
 * @returns 预览结果；没有可拖动的片段时 `placements` 为空。
 */
export function computeDrag(
  project: Pick<ShowProject, "cues" | "tracks" | "durationMs">,
  input: DragInput,
): DragResult {
  const ids = new Set(input.ids);
  const cues = project.cues.filter((c) => ids.has(c.id));
  if (cues.length === 0) return { placements: [], guideMs: null, valid: false, rowDelta: 0 };
  const targets = input.snapTargets ?? [];

  if (input.kind !== "move") {
    const cue = cues[0];
    const gap = gapAround(project, cue.trackId, cue.startMs, new Set([cue.id])) ?? [0, project.durationMs];
    let guideMs: number | null = null;
    if (input.kind === "trimStart") {
      let start = cue.startMs + input.deltaMs;
      const snap = bestSnap([start], targets, input.thresholdMs);
      if (snap) {
        start += snap.adjust;
        guideMs = snap.target;
      }
      start = snapToFrame(clamp(start, gap[0], cue.endMs - MIN_CUE_MS));
      if (guideMs !== null && start !== guideMs) guideMs = null;
      const placements = [{ id: cue.id, trackId: cue.trackId, startMs: start, endMs: cue.endMs }];
      return { placements, guideMs, valid: checkPlacements(project, placements) !== null, rowDelta: 0 };
    }
    let end = cue.endMs + input.deltaMs;
    const snap = bestSnap([end], targets, input.thresholdMs);
    if (snap) {
      end += snap.adjust;
      guideMs = snap.target;
    }
    end = snapToFrame(clamp(end, cue.startMs + MIN_CUE_MS, gap[1]));
    if (guideMs !== null && end !== guideMs) guideMs = null;
    const placements = [{ id: cue.id, trackId: cue.trackId, startMs: cue.startMs, endMs: end }];
    return { placements, guideMs, valid: checkPlacements(project, placements) !== null, rowDelta: 0 };
  }

  // ---- 移动 ----
  const index = new Map(project.tracks.map((t, i) => [t.id, i]));
  let rowDelta = Math.round(input.rowDelta);
  const targetTrack = (trackId: string) => project.tracks[(index.get(trackId) ?? -1) + rowDelta];
  if (rowDelta !== 0) {
    const ok = cues.every((c) => {
      const t = targetTrack(c.trackId);
      return t !== undefined && !t.lock && trackAccepts(t, c);
    });
    if (!ok) rowDelta = 0;
  }

  let delta = input.deltaMs;
  let guideMs: number | null = null;
  const snap = bestSnap(cues.flatMap((c) => [c.startMs + delta, c.endMs + delta]), targets, input.thresholdMs);
  if (snap) {
    delta += snap.adjust;
    guideMs = snap.target;
  }
  // 整组不越出节目范围
  const minStart = Math.min(...cues.map((c) => c.startMs));
  const maxEnd = Math.max(...cues.map((c) => c.endMs));
  const bounded = clamp(delta, -minStart, project.durationMs - maxEnd);
  if (bounded !== delta) guideMs = null;
  delta = bounded;

  const place = (d: number): CuePlacement[] =>
    cues.map((c) => {
      const startMs = snapToFrame(c.startMs + d);
      return { id: c.id, trackId: targetTrack(c.trackId)?.id ?? c.trackId, startMs, endMs: startMs + (c.endMs - c.startMs) };
    });

  let placements = place(delta);
  let valid = checkPlacements(project, placements) !== null;
  if (!valid && rowDelta === 0) {
    // 同轨移动被邻居挡住：贴着邻居停下（与旧时间线的“活动范围”一致）
    let lo = -Infinity;
    let hi = Infinity;
    for (const c of cues) {
      const gap = gapAround(project, c.trackId, c.startMs, ids) ?? [c.startMs, c.endMs];
      lo = Math.max(lo, gap[0] - c.startMs);
      hi = Math.min(hi, gap[1] - c.endMs);
    }
    if (lo <= hi) {
      const clamped = clamp(delta, lo, hi);
      if (clamped !== delta) guideMs = null;
      delta = clamped;
      placements = place(delta);
      valid = checkPlacements(project, placements) !== null;
    }
  }
  return { placements, guideMs, valid, rowDelta };
}

/**
 * 框选：与矩形相交的片段。
 *
 * @param spans 可见片段的矩形（像素，相对轨道区内容）。
 * @param rect 选框（像素，相对轨道区内容）。
 * @returns 相交的片段 id。
 */
export function marqueeHits(
  spans: readonly { id: string; left: number; top: number; width: number; height: number }[],
  rect: { left: number; top: number; width: number; height: number },
): string[] {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  return spans
    .filter((s) => s.left < right && rect.left < s.left + s.width && s.top < bottom && rect.top < s.top + s.height)
    .map((s) => s.id);
}
