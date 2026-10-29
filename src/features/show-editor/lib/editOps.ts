import { current, isDraft } from "immer";

import { gapAround, MIN_CUE_MS, normalizeFades, splitCues, type CuePlacement } from "./cueOps";
import { newId } from "./ids";
import { MIN_MEDIA_CLIP_MS, splitMediaClips } from "./mediaClips";
import type { Cue, CueTag, ShowProject } from "./project";
import { clamp } from "@/shared/lib/math";
import { snapToFrame } from "./time";

/**
 * 剪辑类快捷操作（剪映 / Premiere 的常用操作）：
 *
 * - 删掉播放头左侧 / 右侧的部分（`Q` / `W`），同时作用于灯光片段与媒体片段；
 * - 跳到上一个 / 下一个剪辑点（`↑` / `↓`）、选中上一个 / 下一个片段（`[` / `]`）；
 * - 统一长度、按住 Ctrl 拖动复制、颜色标签、禁用片段。
 *
 * 编辑操作在 immer 草稿上执行（一次调用 = 一步撤销）。
 */

/** 删掉播放头哪一侧。 */
export type TrimSide = "start" | "end";

/**
 * 删掉片段在 `atMs` 左侧（`start`）或右侧（`end`）的部分。只作用于跨过 `atMs` 的片段；
 * 删左侧时外观关键帧随之平移，保持在原来的时间点上。
 *
 * @param d 工程草稿。
 * @param ids 候选片段。
 * @param atMs 时刻（对齐到帧）。
 * @param side 删哪一侧。
 * @returns 被修剪的片段数。
 */
export function trimCuesAt(d: ShowProject, ids: readonly string[], atMs: number, side: TrimSide): number {
  const at = snapToFrame(atMs);
  const wanted = new Set(ids);
  // 与 splitCues 相同的条件：轨道可编辑、两侧都不短于最短长度
  const left = new Set(
    d.cues
      .filter(
        (c) =>
          wanted.has(c.id) &&
          !d.tracks.find((t) => t.id === c.trackId)?.lock &&
          at - c.startMs >= MIN_CUE_MS &&
          c.endMs - at >= MIN_CUE_MS,
      )
      .map((c) => c.id),
  );
  if (left.size === 0) return 0;
  // 分割后：原片段（保留原 id）是左半段，新建的是右半段
  const right = new Set(splitCues(d, [...left], at));
  d.cues = d.cues.filter((c) => (side === "start" ? !left.has(c.id) : !right.has(c.id)));
  return right.size;
}

/**
 * 同 [`trimCuesAt`]，作用于媒体片段。
 *
 * @param d 工程草稿。
 * @param ids 候选媒体片段。
 * @param atMs 时刻。
 * @param side 删哪一侧。
 * @returns 被修剪的片段数。
 */
export function trimMediaAt(d: ShowProject, ids: readonly string[], atMs: number, side: TrimSide): number {
  const at = snapToFrame(atMs);
  const left = new Set(mediaClipsAt(d, ids, at));
  if (left.size === 0) return 0;
  const right = new Set(splitMediaClips(d, [...left], at));
  d.mediaClips = d.mediaClips.filter((c) => (side === "start" ? !left.has(c.id) : !right.has(c.id)));
  return right.size;
}

/**
 * 剪辑点：节目起止、所有片段 / 媒体片段的边缘、标记点、段落边界（升序、去重）。
 *
 * @param project 工程（只读）。
 * @returns 时刻（毫秒）。
 */
export function editPoints(project: Pick<ShowProject, "cues" | "mediaClips" | "markers" | "sections" | "durationMs">): number[] {
  const set = new Set<number>([0, project.durationMs]);
  for (const c of project.cues) set.add(c.startMs).add(c.endMs);
  for (const c of project.mediaClips) set.add(c.startMs).add(c.startMs + c.durationMs);
  for (const m of project.markers) set.add(m.timeMs);
  for (const s of project.sections) set.add(s.startMs).add(s.endMs);
  return [...set].filter((t) => t >= 0 && t <= project.durationMs).sort((a, b) => a - b);
}

/**
 * 上一个 / 下一个剪辑点（相差不到半帧的视为同一点）。
 *
 * @param points 剪辑点（升序）。
 * @param atMs 当前时刻。
 * @param dir `-1` 上一个，`1` 下一个。
 * @returns 时刻；没有更多时为 `null`。
 */
export function adjacentEditPoint(points: readonly number[], atMs: number, dir: 1 | -1): number | null {
  const eps = 1000 / 60;
  if (dir > 0) return points.find((t) => t > atMs + eps) ?? null;
  for (let i = points.length - 1; i >= 0; i -= 1) if (points[i] < atMs - eps) return points[i];
  return null;
}

/**
 * 轨道上与 `from` 相邻的片段：有当前片段时取它的前一个 / 后一个，否则取播放头之前 / 之后最近的。
 *
 * @param project 工程（只读）。
 * @param trackId 轨道。
 * @param fromCueId 当前片段（省略时以 `atMs` 为准）。
 * @param atMs 播放头。
 * @param dir `-1` 前一个，`1` 后一个。
 * @returns 片段 id；没有时为 `null`。
 */
export function adjacentCue(
  project: Pick<ShowProject, "cues">,
  trackId: string,
  fromCueId: string | null,
  atMs: number,
  dir: 1 | -1,
): string | null {
  const list = project.cues.filter((c) => c.trackId === trackId).sort((a, b) => a.startMs - b.startMs);
  if (list.length === 0) return null;
  const i = fromCueId ? list.findIndex((c) => c.id === fromCueId) : -1;
  if (i >= 0) return list[i + dir]?.id ?? null;
  if (dir > 0) return list.find((c) => c.startMs >= atMs)?.id ?? null;
  return [...list].reverse().find((c) => c.endMs <= atMs || c.startMs < atMs)?.id ?? null;
}

/**
 * 把一组片段设成相同的长度（起点不动；放不下时缩到后一个片段的起点 / 节目结尾，不足 100 ms 的跳过）。
 *
 * @param d 工程草稿。
 * @param ids 片段。
 * @param lengthMs 长度（毫秒）。
 * @returns 实际修改的片段数。
 */
export function setCueLengths(d: ShowProject, ids: readonly string[], lengthMs: number): number {
  const wanted = new Set(ids);
  const len = Math.max(MIN_CUE_MS, Math.round(lengthMs));
  let n = 0;
  for (const c of d.cues) {
    if (!wanted.has(c.id) || d.tracks.find((t) => t.id === c.trackId)?.lock) continue;
    const gap = gapAround(d, c.trackId, c.startMs, new Set([c.id])) ?? [c.startMs, c.endMs];
    const end = snapToFrame(Math.min(c.startMs + len, gap[1], d.durationMs));
    if (end - c.startMs < MIN_CUE_MS || end === c.endMs) continue;
    c.endMs = end;
    normalizeFades(c);
    n += 1;
  }
  return n;
}

/**
 * 把片段复制到给定位置（Ctrl 拖动复制）：原片段不动，副本放在目标位置。任何副本与已有片段重叠、
 * 越界或轨道锁定 / 类型不符时整次放弃。
 *
 * @param d 工程草稿。
 * @param placements 每个原片段的副本位置（`id` 为原片段 id）。
 * @returns 新副本的 id；放弃时为空。
 */
export function duplicateCuesTo(d: ShowProject, placements: readonly CuePlacement[]): string[] {
  const byId = new Map(d.cues.map((c) => [c.id, c]));
  const tracks = new Map(d.tracks.map((t) => [t.id, t]));
  const copies: Cue[] = [];
  for (const p of placements) {
    const src = byId.get(p.id);
    const track = tracks.get(p.trackId);
    if (!src || !track || track.lock || (track.target.kind === "scene") !== (src.kind === "scene")) return [];
    if (p.startMs < 0 || p.endMs > d.durationMs || p.endMs - p.startMs < MIN_CUE_MS) return [];
    const clone = structuredClone(isDraft(src) ? current(src) : src) as Cue;
    copies.push({ ...clone, id: newId(), trackId: p.trackId, startMs: p.startMs, endMs: p.endMs });
  }
  const overlaps = (a: Cue, b: { trackId: string; startMs: number; endMs: number }) =>
    a.trackId === b.trackId && a.startMs < b.endMs && b.startMs < a.endMs;
  for (let i = 0; i < copies.length; i += 1) {
    if (d.cues.some((c) => overlaps(c, copies[i]))) return [];
    if (copies.slice(i + 1).some((o) => overlaps(o, copies[i]))) return [];
  }
  d.cues.push(...copies);
  return copies.map((c) => c.id);
}

/**
 * 设置 / 清除片段的颜色标签。
 *
 * @param d 工程草稿。
 * @param ids 片段。
 * @param tag 标签；`null` 清除。
 * @returns 修改的片段数。
 */
export function setCueTag(d: ShowProject, ids: readonly string[], tag: CueTag | null): number {
  const wanted = new Set(ids);
  let n = 0;
  for (const c of d.cues) {
    if (!wanted.has(c.id)) continue;
    if (tag) c.tag = tag;
    else delete c.tag;
    n += 1;
  }
  return n;
}

/**
 * 切换片段的禁用状态：选中的片段里只要有一个启用，就全部禁用；否则全部启用。
 *
 * @param d 工程草稿。
 * @param ids 片段（锁定轨道上的跳过）。
 * @returns 操作后是否为禁用；没有可改的片段时为 `null`。
 */
export function toggleCuesDisabled(d: ShowProject, ids: readonly string[]): boolean | null {
  const wanted = new Set(ids);
  const list = d.cues.filter((c) => wanted.has(c.id) && !d.tracks.find((t) => t.id === c.trackId)?.lock);
  if (list.length === 0) return null;
  const disable = list.some((c) => !c.disabled);
  for (const c of list) {
    if (disable) c.disabled = true;
    else delete c.disabled;
  }
  return disable;
}

/**
 * 媒体片段在 `atMs` 处是否可以修剪（跨过且两侧都不短于 100 ms）。
 *
 * @param project 工程（只读）。
 * @param ids 候选媒体片段。
 * @param atMs 时刻。
 * @returns 可以修剪的片段 id。
 */
export function mediaClipsAt(project: Pick<ShowProject, "mediaClips">, ids: readonly string[] | null, atMs: number): string[] {
  return project.mediaClips
    .filter(
      (c) =>
        (ids === null || ids.includes(c.id)) &&
        atMs - c.startMs >= MIN_MEDIA_CLIP_MS &&
        c.startMs + c.durationMs - atMs >= MIN_MEDIA_CLIP_MS,
    )
    .map((c) => c.id);
}

/**
 * 时刻夹在节目范围内并对齐到帧。
 *
 * @param project 工程（只读）。
 * @param ms 时刻。
 * @returns 规整后的时刻。
 */
export function clampTime(project: Pick<ShowProject, "durationMs">, ms: number): number {
  return snapToFrame(clamp(ms, 0, project.durationMs));
}
