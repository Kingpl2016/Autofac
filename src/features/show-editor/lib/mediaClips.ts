import { newId } from "./ids";
import type { MediaClip, MediaRef, MediaTrack, ShowProject } from "./project";
import { clamp } from "@/shared/lib/math";
import { snapToFrame } from "./time";

/**
 * 媒体轨道与媒体片段（剪映式多轨音视频）：增删轨道、放置 / 移动 / 裁剪 / 分割片段、音量与淡入淡出。
 *
 * 编辑操作在 immer 草稿上执行（一次调用 = 一步撤销）；`compute*` / `*At` 为纯函数（拖动预览与播放用）。
 * 同一媒体轨道上的片段不重叠；片段不能超出素材（`inMs + durationMs <= 素材时长`）。
 */

/** 媒体片段的最短长度（毫秒）。 */
export const MIN_MEDIA_CLIP_MS = 100;

/** 片段在时间线上的终点。 */
export function mediaClipEndMs(clip: Pick<MediaClip, "startMs" | "durationMs">): number {
  return clip.startMs + clip.durationMs;
}

/**
 * 所有媒体片段里最晚的终点（导入后延长节目时长用）。
 *
 * @param project 工程（只读）。
 * @returns 毫秒；没有片段时为 0。
 */
export function mediaContentEndMs(project: Pick<ShowProject, "mediaClips">): number {
  return project.mediaClips.reduce((max, c) => Math.max(max, mediaClipEndMs(c)), 0);
}

/**
 * 新建媒体轨道。
 *
 * @param d 工程草稿。
 * @param kind 轨道类型。
 * @param name 轨道名。
 * @returns 新轨道 id。
 */
export function addMediaTrack(d: ShowProject, kind: MediaTrack["kind"], name: string): string {
  const id = newId();
  d.mediaTracks.push({ id, kind, name, mute: false, solo: false, lock: false, volume: 1 });
  return id;
}

/**
 * 删除媒体轨道及其上的片段（素材本身留在素材库）。
 *
 * @param d 工程草稿。
 * @param id 轨道 id。
 */
export function removeMediaTrack(d: ShowProject, id: string): void {
  d.mediaTracks = d.mediaTracks.filter((t) => t.id !== id);
  d.mediaClips = d.mediaClips.filter((c) => c.trackId !== id);
}

/**
 * 修改媒体轨道（音量夹到 0~1）。
 *
 * @param d 工程草稿。
 * @param id 轨道 id。
 * @param patch 要改的字段。
 */
export function setMediaTrack(
  d: ShowProject,
  id: string,
  patch: Partial<Pick<MediaTrack, "name" | "mute" | "solo" | "lock" | "volume" | "height">>,
): void {
  const t = d.mediaTracks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  t.volume = clamp(Number.isFinite(t.volume) ? t.volume : 1, 0, 1);
}

/**
 * 轨道上 `[startMs, endMs)` 是否空闲。
 *
 * @param project 工程（只读）。
 * @param trackId 轨道 id。
 * @param startMs 起点。
 * @param endMs 终点。
 * @param exclude 不参与判断的片段（正在移动的那些）。
 */
export function mediaSpanFree(
  project: Pick<ShowProject, "mediaClips">,
  trackId: string,
  startMs: number,
  endMs: number,
  exclude: ReadonlySet<string> = new Set(),
): boolean {
  return project.mediaClips.every(
    (c) => c.trackId !== trackId || exclude.has(c.id) || mediaClipEndMs(c) <= startMs || c.startMs >= endMs,
  );
}

/** 放置结果。 */
export interface MediaPlaceResult {
  clipId: string;
  trackId: string;
  /** 是否为此新建了轨道 */
  createdTrack: boolean;
}

/**
 * 把素材整段放到时间线上：优先放进 `preferTrackId`（类型相同、未锁定、有空位），否则放进第一条有空位的同类轨道，
 * 都没有时新建一条轨道。
 *
 * @param d 工程草稿。
 * @param mediaId 素材 id。
 * @param atMs 时间线起点（对齐到帧）。
 * @param newTrackName 需要新建轨道时的名字。
 * @param preferTrackId 首选轨道。
 * @returns 放置结果；素材不存在时为 `null`。
 */
export function placeMediaClip(
  d: ShowProject,
  mediaId: string,
  atMs: number,
  newTrackName: string,
  preferTrackId?: string,
): MediaPlaceResult | null {
  const media = d.media.find((m) => m.id === mediaId);
  if (!media || media.durationMs < MIN_MEDIA_CLIP_MS) return null;
  const startMs = snapToFrame(Math.max(0, atMs));
  const endMs = startMs + media.durationMs;
  const fits = (t: MediaTrack) => t.kind === media.kind && !t.lock && mediaSpanFree(d, t.id, startMs, endMs);
  const preferred = d.mediaTracks.find((t) => t.id === preferTrackId);
  const track = (preferred && fits(preferred) ? preferred : undefined) ?? d.mediaTracks.find(fits);
  const createdTrack = !track;
  const trackId = track?.id ?? addMediaTrack(d, media.kind, newTrackName);
  const clipId = newId();
  d.mediaClips.push({
    id: clipId,
    trackId,
    mediaId,
    startMs,
    inMs: 0,
    durationMs: media.durationMs,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
  });
  return { clipId, trackId, createdTrack };
}

/**
 * 删除媒体片段。
 *
 * @param d 工程草稿。
 * @param ids 片段 id。
 */
export function removeMediaClips(d: ShowProject, ids: readonly string[]): void {
  const set = new Set(ids);
  d.mediaClips = d.mediaClips.filter((c) => !set.has(c.id));
}

/**
 * 修改片段的音量、淡入淡出、静音（淡入 + 淡出不超过片段长度）。
 *
 * @param d 工程草稿。
 * @param ids 片段 id。
 * @param patch 要改的字段。
 */
export function setMediaClip(
  d: ShowProject,
  ids: readonly string[],
  patch: Partial<Pick<MediaClip, "volume" | "fadeInMs" | "fadeOutMs" | "muted">>,
): void {
  const set = new Set(ids);
  for (const c of d.mediaClips) {
    if (!set.has(c.id)) continue;
    if (patch.volume !== undefined && Number.isFinite(patch.volume)) c.volume = clamp(patch.volume, 0, 1);
    if (patch.fadeInMs !== undefined && Number.isFinite(patch.fadeInMs)) {
      c.fadeInMs = Math.round(clamp(patch.fadeInMs, 0, c.durationMs - c.fadeOutMs));
    }
    if (patch.fadeOutMs !== undefined && Number.isFinite(patch.fadeOutMs)) {
      c.fadeOutMs = Math.round(clamp(patch.fadeOutMs, 0, c.durationMs - c.fadeInMs));
    }
    if (patch.muted !== undefined) {
      if (patch.muted) c.muted = true;
      else delete c.muted;
    }
  }
}

/**
 * 在 `atMs` 处分割片段（播放头处“分割”）。不跨过 `atMs` 的片段不受影响；两段都至少 {@link MIN_MEDIA_CLIP_MS}。
 *
 * @param d 工程草稿。
 * @param ids 要分割的片段。
 * @param atMs 时间线时刻。
 * @returns 新产生的（后半段）片段 id。
 */
export function splitMediaClips(d: ShowProject, ids: readonly string[], atMs: number): string[] {
  const set = new Set(ids);
  const created: string[] = [];
  const at = snapToFrame(atMs);
  for (const c of [...d.mediaClips]) {
    if (!set.has(c.id)) continue;
    const head = at - c.startMs;
    const tail = c.durationMs - head;
    if (head < MIN_MEDIA_CLIP_MS || tail < MIN_MEDIA_CLIP_MS) continue;
    const id = newId();
    d.mediaClips.push({
      ...c,
      id,
      startMs: at,
      inMs: c.inMs + head,
      durationMs: tail,
      fadeInMs: 0,
      fadeOutMs: Math.min(c.fadeOutMs, tail),
    });
    c.durationMs = head;
    c.fadeOutMs = 0;
    c.fadeInMs = Math.min(c.fadeInMs, head);
    created.push(id);
  }
  return created;
}

/** 一个片段的目标位置。 */
export interface MediaPlacement {
  id: string;
  trackId: string;
  startMs: number;
  inMs: number;
  durationMs: number;
}

/**
 * 检查一组目标位置是否合法：轨道存在、类型一致、未锁定，不超出素材，彼此及与其它片段不重叠。
 *
 * @param project 工程（只读）。
 * @param placements 目标位置。
 * @returns 合法时为 `true`。
 */
export function checkMediaPlacements(
  project: Pick<ShowProject, "media" | "mediaTracks" | "mediaClips">,
  placements: readonly MediaPlacement[],
): boolean {
  const media = new Map(project.media.map((m) => [m.id, m]));
  const tracks = new Map(project.mediaTracks.map((t) => [t.id, t]));
  const clips = new Map(project.mediaClips.map((c) => [c.id, c]));
  const moving = new Set(placements.map((p) => p.id));
  for (const p of placements) {
    const clip = clips.get(p.id);
    const track = tracks.get(p.trackId);
    const ref = clip ? media.get(clip.mediaId) : undefined;
    if (!clip || !track || !ref || track.lock || track.kind !== ref.kind) return false;
    if (p.startMs < 0 || p.inMs < 0 || p.durationMs < MIN_MEDIA_CLIP_MS || p.inMs + p.durationMs > ref.durationMs) return false;
    if (!mediaSpanFree(project, p.trackId, p.startMs, p.startMs + p.durationMs, moving)) return false;
  }
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i];
      const b = placements[j];
      if (a.trackId === b.trackId && a.startMs < b.startMs + b.durationMs && b.startMs < a.startMs + a.durationMs) return false;
    }
  }
  return true;
}

/**
 * 写入目标位置（调用方先用 {@link checkMediaPlacements} 检查）。淡入淡出随长度收紧。
 *
 * @param d 工程草稿。
 * @param placements 目标位置。
 */
export function applyMediaPlacements(d: ShowProject, placements: readonly MediaPlacement[]): void {
  const byId = new Map(placements.map((p) => [p.id, p]));
  for (const c of d.mediaClips) {
    const p = byId.get(c.id);
    if (!p) continue;
    Object.assign(c, { trackId: p.trackId, startMs: p.startMs, inMs: p.inMs, durationMs: p.durationMs });
    c.fadeInMs = Math.min(c.fadeInMs, c.durationMs);
    c.fadeOutMs = Math.min(c.fadeOutMs, c.durationMs - c.fadeInMs);
  }
}

/** 媒体片段拖动类型。 */
export type MediaDragKind = "move" | "trimStart" | "trimEnd";

/** 一次媒体片段拖动的输入。 */
export interface MediaDragInput {
  kind: MediaDragKind;
  /** 移动时为全部选中的片段，裁剪时为被抓住的那一个 */
  ids: readonly string[];
  deltaMs: number;
  /** 纵向跨过的媒体轨道数（只用于移动） */
  rowDelta: number;
  snapTargets: readonly number[] | null;
  thresholdMs: number;
}

/** 拖动结果。 */
export interface MediaDragResult {
  placements: MediaPlacement[];
  guideMs: number | null;
  valid: boolean;
}

/** 在吸附目标里找离 `values` 中任一值最近的，返回调整量与目标。 */
function bestSnap(values: readonly number[], targets: readonly number[], thresholdMs: number) {
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
 * 计算媒体片段拖动的预览：移动（可换到同类轨道）、裁剪入点（起点与入点一起动）、裁剪出点；实时吸附。
 *
 * @param project 拖动开始时的工程（只读）。
 * @param input 拖动输入。
 * @returns 预览结果。
 */
export function computeMediaDrag(
  project: Pick<ShowProject, "media" | "mediaTracks" | "mediaClips">,
  input: MediaDragInput,
): MediaDragResult {
  const ids = new Set(input.ids);
  const clips = project.mediaClips.filter((c) => ids.has(c.id));
  if (clips.length === 0) return { placements: [], guideMs: null, valid: false };
  const media = new Map<string, MediaRef>(project.media.map((m) => [m.id, m]));
  const targets = input.snapTargets ?? [];
  const finish = (placements: MediaPlacement[], guideMs: number | null) => ({
    placements,
    guideMs,
    valid: checkMediaPlacements(project, placements),
  });

  if (input.kind !== "move") {
    const c = clips[0];
    const sourceLen = media.get(c.mediaId)?.durationMs ?? c.inMs + c.durationMs;
    // 同轨相邻片段限制裁剪范围
    const others = project.mediaClips.filter((x) => x.trackId === c.trackId && x.id !== c.id);
    const prevEnd = Math.max(0, ...others.filter((x) => mediaClipEndMs(x) <= c.startMs).map(mediaClipEndMs));
    const nextStart = Math.min(Infinity, ...others.filter((x) => x.startMs >= mediaClipEndMs(c)).map((x) => x.startMs));
    let guideMs: number | null = null;
    if (input.kind === "trimStart") {
      let start = c.startMs + input.deltaMs;
      const snap = bestSnap([start], targets, input.thresholdMs);
      if (snap) {
        start += snap.adjust;
        guideMs = snap.target;
      }
      const end = mediaClipEndMs(c);
      const lo = Math.max(prevEnd, c.startMs - c.inMs);
      start = snapToFrame(clamp(start, lo, end - MIN_MEDIA_CLIP_MS));
      if (guideMs !== null && start !== guideMs) guideMs = null;
      const delta = start - c.startMs;
      return finish([{ id: c.id, trackId: c.trackId, startMs: start, inMs: c.inMs + delta, durationMs: c.durationMs - delta }], guideMs);
    }
    let end = mediaClipEndMs(c) + input.deltaMs;
    const snap = bestSnap([end], targets, input.thresholdMs);
    if (snap) {
      end += snap.adjust;
      guideMs = snap.target;
    }
    const hi = Math.min(nextStart, c.startMs + sourceLen - c.inMs);
    end = clamp(snapToFrame(end), c.startMs + MIN_MEDIA_CLIP_MS, hi);
    if (guideMs !== null && end !== guideMs) guideMs = null;
    return finish([{ id: c.id, trackId: c.trackId, startMs: c.startMs, inMs: c.inMs, durationMs: end - c.startMs }], guideMs);
  }

  // ---- 移动 ----
  const index = new Map(project.mediaTracks.map((t, i) => [t.id, i]));
  let rowDelta = Math.round(input.rowDelta);
  const targetTrack = (trackId: string) => project.mediaTracks[(index.get(trackId) ?? -1) + rowDelta];
  if (rowDelta !== 0) {
    const ok = clips.every((c) => {
      const t = targetTrack(c.trackId);
      return t !== undefined && !t.lock && t.kind === media.get(c.mediaId)?.kind;
    });
    if (!ok) rowDelta = 0;
  }
  let delta = input.deltaMs;
  let guideMs: number | null = null;
  const snap = bestSnap(clips.flatMap((c) => [c.startMs + delta, mediaClipEndMs(c) + delta]), targets, input.thresholdMs);
  if (snap) {
    delta += snap.adjust;
    guideMs = snap.target;
  }
  const minStart = Math.min(...clips.map((c) => c.startMs));
  if (delta < -minStart) {
    delta = -minStart;
    guideMs = null;
  }
  const placements = clips.map((c) => ({
    id: c.id,
    trackId: targetTrack(c.trackId)?.id ?? c.trackId,
    startMs: snapToFrame(c.startMs + delta),
    inMs: c.inMs,
    durationMs: c.durationMs,
  }));
  return finish(placements, guideMs);
}

/**
 * 片段在时间线时刻 `atMs` 的增益（0~1）：片段音量 × 轨道音量 × 淡入淡出包络；静音、不在片段内时为 0。
 * 存在独奏轨道时，非独奏轨道为 0。
 *
 * @param clip 片段。
 * @param track 所在轨道。
 * @param atMs 时间线时刻。
 * @param anySolo 是否有媒体轨道开了独奏。
 * @returns 增益 0~1。
 */
export function mediaGainAt(clip: MediaClip, track: MediaTrack, atMs: number, anySolo: boolean): number {
  if (clip.muted || track.mute || (anySolo && !track.solo)) return 0;
  const t = atMs - clip.startMs;
  if (t < 0 || t >= clip.durationMs) return 0;
  let env = 1;
  if (clip.fadeInMs > 0 && t < clip.fadeInMs) env = Math.min(env, t / clip.fadeInMs);
  const left = clip.durationMs - t;
  if (clip.fadeOutMs > 0 && left < clip.fadeOutMs) env = Math.min(env, left / clip.fadeOutMs);
  return clamp(clip.volume * track.volume * env, 0, 1);
}

/**
 * 时刻 `atMs` 要显示的视频片段：从上到下第一条有片段覆盖此刻、且未静音隐藏的视频轨道（上面的盖住下面的）。
 *
 * @param project 工程（只读）。
 * @param atMs 时间线时刻。
 * @returns 片段 id；此刻没有视频时为 `null`。
 */
export function visibleVideoClip(project: Pick<ShowProject, "mediaTracks" | "mediaClips">, atMs: number): string | null {
  for (const track of project.mediaTracks) {
    if (track.kind !== "video") continue;
    const clip = project.mediaClips.find((c) => c.trackId === track.id && atMs >= c.startMs && atMs < mediaClipEndMs(c));
    if (clip) return clip.id;
  }
  return null;
}
