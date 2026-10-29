import { produce } from "immer";

import { MIN_CUE_MS, normalizeFades, placeCues, splitCues, type ClipCue, type CuePlacement } from "./cueOps";
import { duplicateCuesTo } from "./editOps";
import type { CycleParam, Look, Param, ShowProject, Tempo } from "./project";
import { clamp } from "@/shared/lib/math";
import { snapToFrame } from "./time";

/**
 * 时间线的批量编辑（纯函数，直接修改 immer 草稿）：轨道排序、片段排列、复制 N 份、
 * 波纹移动、时间范围的删除 / 插入空白、关键帧移动。
 *
 * 影响范围（`EditScope`）：默认只作用于给定的轨道；`allTracks` 时作用于全部轨道，
 * 标记点、段落、A-B 循环区与媒体片段也一起移动（时间轴整体插入或删掉一段）。
 */

// ---------------------------------------------------------------------------
// 轨道排序
// ---------------------------------------------------------------------------

/**
 * 把一组轨道移到第 `toIndex` 条轨道之前（`toIndex` 按移动前的顺序计，等于轨道数时移到最后），
 * 保持它们之间的相对顺序。
 *
 * @param draft 工程草稿。
 * @param ids 要移动的轨道。
 * @param toIndex 目标位置（0 ~ 轨道数）。
 * @returns 顺序是否变化。
 */
export function moveTracks(draft: ShowProject, ids: readonly string[], toIndex: number): boolean {
  const moving = new Set(ids);
  const before = draft.tracks.map((t) => t.id).join(",");
  const picked = draft.tracks.filter((t) => moving.has(t.id));
  if (picked.length === 0) return false;
  const target = clamp(Math.round(toIndex), 0, draft.tracks.length);
  const rest = draft.tracks.filter((t) => !moving.has(t.id));
  const at = draft.tracks.slice(0, target).filter((t) => !moving.has(t.id)).length;
  draft.tracks = [...rest.slice(0, at), ...picked, ...rest.slice(at)];
  return draft.tracks.map((t) => t.id).join(",") !== before;
}

/**
 * 把一组轨道整体上移 / 下移一位（到顶 / 到底时不动）。
 *
 * @param draft 工程草稿。
 * @param ids 要移动的轨道。
 * @param delta `-1` 上移，`1` 下移。
 * @returns 顺序是否变化。
 */
export function moveTracksBy(draft: ShowProject, ids: readonly string[], delta: -1 | 1): boolean {
  const moving = new Set(ids);
  const indices = draft.tracks.flatMap((t, i) => (moving.has(t.id) ? [i] : []));
  if (indices.length === 0) return false;
  if (delta < 0) {
    if (indices[0] === 0) return false;
    return moveTracks(draft, ids, indices[0] - 1);
  }
  const last = indices[indices.length - 1];
  if (last === draft.tracks.length - 1) return false;
  return moveTracks(draft, ids, last + 2);
}

// ---------------------------------------------------------------------------
// 片段排列
// ---------------------------------------------------------------------------

/** 选中的片段（按起点排序；锁定轨道上的不算）。 */
function pickedCues(draft: ShowProject, ids: readonly string[]) {
  const wanted = new Set(ids);
  const locked = new Set(draft.tracks.filter((t) => t.lock).map((t) => t.id));
  return draft.cues.filter((c) => wanted.has(c.id) && !locked.has(c.trackId)).sort((a, b) => a.startMs - b.startMs || a.trackId.localeCompare(b.trackId));
}

/** 按新起点放置（长度不变）；整组要么全部生效，要么不动。 */
function placeStarts(draft: ShowProject, starts: ReadonlyMap<string, number>): boolean {
  const placements: CuePlacement[] = [];
  for (const c of draft.cues) {
    const s = starts.get(c.id);
    if (s === undefined) continue;
    const start = snapToFrame(s);
    placements.push({ id: c.id, trackId: c.trackId, startMs: start, endMs: start + (c.endMs - c.startMs) });
  }
  return placements.length > 0 && placeCues(draft, placements);
}

/**
 * 起点对齐：选中片段的起点都移到 `atMs`（长度不变）。同一条轨道上有多个选中片段时会重叠，整次放弃。
 *
 * @param draft 工程草稿。
 * @param ids 片段。
 * @param atMs 对齐到的时刻；省略时对齐到最早的起点。
 * @returns 是否生效。
 */
export function alignCueStarts(draft: ShowProject, ids: readonly string[], atMs?: number): boolean {
  const cues = pickedCues(draft, ids);
  if (cues.length === 0) return false;
  const at = atMs ?? cues[0].startMs;
  return placeStarts(draft, new Map(cues.map((c) => [c.id, at])));
}

/**
 * 首尾相接：按起点顺序，每个片段紧接在前一个之后（可留间隔）；第一个不动。
 *
 * @param draft 工程草稿。
 * @param ids 片段。
 * @param gapMs 片段之间的间隔（毫秒）。
 * @returns 是否生效。
 */
export function chainCues(draft: ShowProject, ids: readonly string[], gapMs = 0): boolean {
  const cues = pickedCues(draft, ids);
  if (cues.length < 2) return false;
  const starts = new Map<string, number>();
  let cursor = cues[0].startMs;
  for (const c of cues) {
    starts.set(c.id, cursor);
    cursor = snapToFrame(cursor + (c.endMs - c.startMs) + Math.max(0, gapMs));
  }
  return placeStarts(draft, starts);
}

/**
 * 按固定间隔排开：第 i 个片段的起点为第一个的起点 + i × 间隔（长度不变）。
 *
 * @param draft 工程草稿。
 * @param ids 片段。
 * @param intervalMs 起点间隔（毫秒，至少一帧）。
 * @returns 是否生效。
 */
export function spaceCues(draft: ShowProject, ids: readonly string[], intervalMs: number): boolean {
  const cues = pickedCues(draft, ids);
  if (cues.length < 2 || !(intervalMs > 0)) return false;
  const first = cues[0].startMs;
  return placeStarts(draft, new Map(cues.map((c, i) => [c.id, first + i * intervalMs])));
}

/**
 * 量化到节拍：每个片段的起点吸到最近的网格（长度不变）。
 *
 * @param draft 工程草稿。
 * @param ids 片段。
 * @param tempo 节拍。
 * @param beats 网格（拍）：1 为每拍，0.5 为半拍，4 为每小节（4/4）。
 * @returns 是否生效（没有片段需要移动时为 `false`）。
 */
export function quantizeCues(draft: ShowProject, ids: readonly string[], tempo: Tempo, beats = 1): boolean {
  const cues = pickedCues(draft, ids);
  if (cues.length === 0 || !(tempo.bpm > 0) || !(beats > 0)) return false;
  const grid = (60_000 / tempo.bpm) * beats;
  const starts = new Map(cues.map((c) => [c.id, Math.max(0, tempo.offsetMs + Math.round((c.startMs - tempo.offsetMs) / grid) * grid)]));
  if (cues.every((c) => snapToFrame(starts.get(c.id) ?? c.startMs) === c.startMs)) return false;
  return placeStarts(draft, starts);
}

/**
 * 复制 N 份：把选中片段整组往后复制，每份相隔“整组跨度 + 间隔”。放不下（越界、重叠、锁定）时停在放不下的那一份。
 *
 * @param draft 工程草稿。
 * @param ids 片段。
 * @param count 份数（1~64）。
 * @param gapMs 每份之间的间隔（毫秒）。
 * @returns 新片段 id 与实际复制的份数。
 */
export function repeatCues(draft: ShowProject, ids: readonly string[], count: number, gapMs = 0): { ids: string[]; copies: number } {
  const cues = pickedCues(draft, ids);
  const out = { ids: [] as string[], copies: 0 };
  if (cues.length === 0) return out;
  const start = Math.min(...cues.map((c) => c.startMs));
  const end = Math.max(...cues.map((c) => c.endMs));
  const period = snapToFrame(end - start + Math.max(0, gapMs));
  for (let k = 1; k <= clamp(Math.round(count), 1, 64); k += 1) {
    const created = duplicateCuesTo(
      draft,
      cues.map((c) => ({ id: c.id, trackId: c.trackId, startMs: c.startMs + k * period, endMs: c.endMs + k * period })),
    );
    if (created.length === 0) break;
    out.ids.push(...created);
    out.copies += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 影响范围、时间映射
// ---------------------------------------------------------------------------

/** 编辑的影响范围。 */
export interface EditScope {
  /** 只作用于这些轨道；`null` 为全部轨道 */
  trackIds: readonly string[] | null;
  /** 标记点、段落、A-B 循环区与媒体片段也一起移动（一般与 `trackIds = null` 一起用） */
  objects: boolean;
}

/** 范围内（未锁定）的轨道。 */
function scopeTracks(draft: ShowProject, scope: EditScope): Set<string> {
  const wanted = scope.trackIds ? new Set(scope.trackIds) : null;
  return new Set(draft.tracks.filter((t) => !t.lock && (!wanted || wanted.has(t.id))).map((t) => t.id));
}

/**
 * 按时间映射移动标记点、段落、循环区与媒体片段（`objects` 范围时）。
 * 映射后长度不足的段落 / 循环区删除；`drop` 返回 `true` 的标记点删除。
 */
function mapObjects(draft: ShowProject, map: (t: number) => number, drop: (t: number) => boolean): void {
  draft.markers = draft.markers.filter((m) => !drop(m.timeMs));
  for (const m of draft.markers) m.timeMs = map(m.timeMs);
  draft.sections = draft.sections.flatMap((s) => {
    const startMs = map(s.startMs);
    const endMs = map(s.endMs);
    return endMs - startMs >= MIN_CUE_MS ? [{ ...s, startMs, endMs }] : [];
  });
  if (draft.loopRange) {
    const startMs = map(draft.loopRange.startMs);
    const endMs = map(draft.loopRange.endMs);
    draft.loopRange = endMs - startMs >= MIN_CUE_MS ? { startMs, endMs } : null;
  }
  const lockedMedia = new Set(draft.mediaTracks.filter((t) => t.lock).map((t) => t.id));
  for (const c of draft.mediaClips) if (!lockedMedia.has(c.trackId)) c.startMs = map(c.startMs);
}

/**
 * 把标记点、段落、A-B 循环区与媒体片段里不早于 `fromMs` 的部分平移（拖动时的全局波纹用）。
 *
 * @param draft 工程草稿。
 * @param fromMs 从这个时刻起（含）。
 * @param deltaMs 平移量（毫秒）。
 */
export function shiftTimelineObjects(draft: ShowProject, fromMs: number, deltaMs: number): void {
  if (deltaMs === 0) return;
  mapObjects(draft, (t) => (t >= fromMs ? Math.max(0, t + deltaMs) : t), () => false);
}

/** 标记点、段落、循环区或（未锁定的）媒体片段里有没有会被 `fromMs` 起的平移带动的。 */
function hasObjectsFrom(draft: ShowProject, fromMs: number): boolean {
  const lockedMedia = new Set(draft.mediaTracks.filter((t) => t.lock).map((t) => t.id));
  return (
    draft.markers.some((m) => m.timeMs >= fromMs) ||
    draft.sections.some((s) => s.endMs >= fromMs) ||
    (draft.loopRange ? draft.loopRange.endMs >= fromMs : false) ||
    draft.mediaClips.some((c) => !lockedMedia.has(c.trackId) && c.startMs >= fromMs)
  );
}

/** 节目时长不够放下全部片段时延长（插入空白、波纹往后推时）。 */
function fitDuration(draft: ShowProject): void {
  const end = Math.max(draft.durationMs, ...draft.cues.map((c) => c.endMs));
  draft.durationMs = end;
}

/**
 * 波纹平移：范围内起点不早于 `fromMs` 的片段整体平移 `deltaMs`（往前移时不会越过前面的片段或 0 点，
 * 会被截停）；`objects` 时标记点、段落、循环区与媒体片段也一起移动。往后推超出节目时长时延长节目。
 *
 * @param draft 工程草稿。
 * @param scope 影响范围。
 * @param fromMs 从这个时刻起（含）。
 * @param deltaMs 平移量（毫秒，可为负）。
 * @param exclude 不参与平移的片段（例如正在拖动的片段本身）。
 * @returns 实际的平移量（被截停时绝对值变小；范围内 `fromMs` 之后既没有片段、也没有要带动的对象时为 0）。
 */
export function rippleShift(
  draft: ShowProject,
  scope: EditScope,
  fromMs: number,
  deltaMs: number,
  exclude: ReadonlySet<string> = new Set(),
): number {
  const tracks = scopeTracks(draft, scope);
  const moving = draft.cues.filter((c) => tracks.has(c.trackId) && c.startMs >= fromMs && !exclude.has(c.id));
  if (moving.length === 0 && !(scope.objects && hasObjectsFrom(draft, fromMs))) return 0;
  let delta = snapToFrame(deltaMs);
  if (delta < 0) {
    // 不越过同轨道上不动的片段与 0 点
    for (const c of moving) {
      const prevEnd = Math.max(
        0,
        ...draft.cues.filter((o) => o.trackId === c.trackId && o.endMs <= c.startMs && (o.startMs < fromMs || exclude.has(o.id))).map((o) => o.endMs),
      );
      delta = Math.max(delta, prevEnd - c.startMs);
    }
    if (scope.objects) delta = Math.max(delta, -fromMs);
  }
  if (delta === 0) return 0;
  for (const c of moving) {
    c.startMs += delta;
    c.endMs += delta;
  }
  if (scope.objects) mapObjects(draft, (t) => (t >= fromMs ? Math.max(0, t + delta) : t), () => false);
  if (delta > 0) fitDuration(draft);
  return delta;
}

/**
 * 插入空白：在 `atMs` 处把范围内跨过它的片段切开，后面的内容整体往后推 `lengthMs`。
 *
 * @param draft 工程草稿。
 * @param atMs 插入点。
 * @param lengthMs 空白长度（至少一帧）。
 * @param scope 影响范围。
 * @returns 是否有内容被推后。
 */
export function insertGap(draft: ShowProject, atMs: number, lengthMs: number, scope: EditScope): boolean {
  const at = snapToFrame(Math.max(0, atMs));
  const length = snapToFrame(lengthMs);
  if (length <= 0) return false;
  const tracks = scopeTracks(draft, scope);
  splitCues(
    draft,
    draft.cues.filter((c) => tracks.has(c.trackId) && c.startMs < at && at < c.endMs).map((c) => c.id),
    at,
  );
  return rippleShift(draft, scope, at, length) !== 0;
}

/**
 * 删除一段时间：范围内的片段在两端切开后删掉中间部分；`close` 时后面的内容前移合拢
 * （`objects` 时标记点、段落、循环区与媒体片段一起合拢，落在范围里的标记点删除）。
 *
 * @param draft 工程草稿。
 * @param range 时间范围。
 * @param scope 影响范围。
 * @param close 是否合拢（波纹删除）。
 * @returns 删除的片段（片段段落）数。
 */
export function deleteRange(draft: ShowProject, range: { startMs: number; endMs: number }, scope: EditScope, close: boolean): number {
  const start = snapToFrame(Math.max(0, Math.min(range.startMs, range.endMs)));
  const end = snapToFrame(Math.max(range.startMs, range.endMs));
  if (end - start <= 0) return 0;
  const tracks = scopeTracks(draft, scope);
  const crossing = (at: number) => draft.cues.filter((c) => tracks.has(c.trackId) && c.startMs < at && at < c.endMs).map((c) => c.id);
  splitCues(draft, crossing(start), start);
  splitCues(draft, crossing(end), end);
  const gone = new Set<string>();
  for (const c of draft.cues) {
    if (!tracks.has(c.trackId) || c.endMs <= start || c.startMs >= end) continue;
    if (c.startMs >= start && c.endMs <= end) {
      gone.add(c.id);
    } else if (c.startMs < start) {
      // 切不开（剩下的一段短于最短长度）：保留范围之前的部分
      c.endMs = start;
      normalizeFades(c);
      if (c.endMs - c.startMs < MIN_CUE_MS) gone.add(c.id);
    } else {
      // 起点在范围里、终点在范围之后但切不开：剩下的部分太短，整段删除
      gone.add(c.id);
    }
  }
  draft.cues = draft.cues.filter((c) => !gone.has(c.id));
  if (close) {
    const length = end - start;
    for (const c of draft.cues) {
      if (tracks.has(c.trackId) && c.startMs >= end) {
        c.startMs -= length;
        c.endMs -= length;
      }
    }
    if (scope.objects) {
      mapObjects(
        draft,
        (t) => (t < start ? t : t >= end ? t - length : start),
        (t) => t >= start && t < end,
      );
    }
  }
  return gone.size;
}

/**
 * 复制一段时间：范围内的片段（跨过边界的在边界处切开，只取范围里的部分）按“相对范围起点”的偏移
 * 放进剪贴板格式，粘贴时保持它们在这段时间里的位置。锁定的轨道也可以复制。
 *
 * @param project 工程（只读）。
 * @param range 时间范围。
 * @param trackIds 只看这些轨道；`null` 为全部。
 * @returns 剪贴板内容（按起点排序；切完短于最短长度的部分丢弃）。
 */
export function copyRange(project: ShowProject, range: { startMs: number; endMs: number }, trackIds: readonly string[] | null): ClipCue[] {
  const start = snapToFrame(Math.min(range.startMs, range.endMs));
  const end = snapToFrame(Math.max(range.startMs, range.endMs));
  const wanted = trackIds ? new Set(trackIds) : null;
  // 在副本上切开（锁定轨道也要能复制：先解锁副本）
  const cut = produce(project, (d) => {
    for (const t of d.tracks) t.lock = false;
    const crossing = (at: number) => d.cues.filter((c) => (!wanted || wanted.has(c.trackId)) && c.startMs < at && at < c.endMs).map((c) => c.id);
    splitCues(d, crossing(start), start);
    splitCues(d, crossing(end), end);
  });
  const inside = cut.cues
    .filter((c) => (!wanted || wanted.has(c.trackId)) && c.startMs >= start && c.endMs <= end)
    .sort((a, b) => a.startMs - b.startMs);
  return inside.map((c) => {
    const { id: _id, trackId, startMs, endMs, ...rest } = structuredClone(c);
    void _id;
    return { trackId, offsetMs: startMs - start, lengthMs: endMs - startMs, cue: rest };
  });
}

// ---------------------------------------------------------------------------
// 关键帧
// ---------------------------------------------------------------------------

/**
 * 外观里某个时刻的关键帧能移动到的范围：不越过相邻的关键帧，也不出片段。
 *
 * @param look 外观。
 * @param fromMs 关键帧的时刻（片段内）。
 * @param lengthMs 片段长度。
 * @returns `[最早, 最晚]`（毫秒，片段内）。
 */
export function keyMoveRange(look: Look, fromMs: number, lengthMs: number): [number, number] {
  let lo = 0;
  let hi = lengthMs;
  const visit = <T>(p: Param<T> | CycleParam<T> | undefined) => {
    if (p?.kind !== "keys" || !p.keys.some((k) => k.tMs === fromMs)) return;
    for (const k of p.keys) {
      if (k.tMs < fromMs) lo = Math.max(lo, k.tMs + 1);
      if (k.tMs > fromMs) hi = Math.min(hi, k.tMs - 1);
    }
  };
  visit(look.intensity);
  visit(look.color);
  for (const p of Object.values(look.attrs ?? {})) visit(p);
  return [lo, hi];
}

/**
 * 移动（或复制）外观里某个时刻的关键帧：同一时刻上所有参数的关键帧一起移动，不越过相邻的关键帧、不出片段。
 *
 * @param look 外观（原地修改）。
 * @param fromMs 原时刻（片段内）。
 * @param toMs 目标时刻（片段内，会被夹到允许范围）。
 * @param lengthMs 片段长度。
 * @param copy 复制（原关键帧保留）。复制时目标与已有关键帧重合的参数跳过。
 * @returns 实际的目标时刻；没有这个时刻的关键帧时为 `null`。
 */
export function moveLookKey(look: Look, fromMs: number, toMs: number, lengthMs: number, copy = false): number | null {
  const [lo, hi] = copy ? [0, lengthMs] : keyMoveRange(look, fromMs, lengthMs);
  const to = Math.round(clamp(toMs, lo, hi));
  let found = false;
  const move = <T>(p: Param<T> | CycleParam<T> | undefined) => {
    if (p?.kind !== "keys") return;
    const k = p.keys.find((x) => x.tMs === fromMs);
    if (!k) return;
    found = true;
    if (copy) {
      if (!p.keys.some((x) => x.tMs === to)) p.keys = [...p.keys, { ...k, tMs: to }].sort((a, b) => a.tMs - b.tMs);
    } else {
      p.keys = p.keys.map((x) => (x === k ? { ...x, tMs: to } : x)).sort((a, b) => a.tMs - b.tMs);
    }
  };
  move(look.intensity);
  move(look.color);
  for (const p of Object.values(look.attrs ?? {})) move(p);
  return found ? to : null;
}
