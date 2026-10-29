import { MIN_CUE_MS, normalizeFades } from "./cueOps";
import { MIN_MEDIA_CLIP_MS } from "./mediaClips";
import { MAX_DURATION_MS, setLoopRange } from "./ops";
import type { ShowProject } from "./project";
import { clamp } from "@/shared/lib/math";
import { snapToFrame } from "./time";

/**
 * 节目时长：直接设置、适配内容长度；缩短时裁掉超出新结尾的片段 / 媒体 / 段落 / 标记点。
 *
 * 缩短会删东西，界面先用 [`overflowAt`] 统计，确认后再调用 [`setShowDuration`]（一步撤销）。
 */

/** 节目时长下限（毫秒）。 */
export const MIN_SHOW_MS = 1000;

/** 超出某个时刻的内容统计。 */
export interface Overflow {
  /** 会被裁短的片段（Cue） */
  trimmedCues: number;
  /** 会被删除的片段（起点就在新结尾之后，或裁完太短） */
  removedCues: number;
  /** 会被裁短 / 删除的媒体片段 */
  mediaClips: number;
  /** 会被删除的标记点 */
  markers: number;
  /** 会被裁短 / 删除的段落 */
  sections: number;
}

/**
 * 规整节目时长：对齐到帧，夹在 1 秒 ~ 24 小时。
 *
 * @param ms 期望时长。
 * @returns 规整后的时长。
 */
export function normalizeDuration(ms: number): number {
  return clamp(snapToFrame(ms), MIN_SHOW_MS, MAX_DURATION_MS);
}

/**
 * 统计把节目缩短到 `endMs` 时受影响的内容。
 *
 * @param project 工程（只读）。
 * @param endMs 新时长。
 * @returns 统计；全为 0 表示缩短不影响任何内容。
 */
export function overflowAt(project: Pick<ShowProject, "cues" | "mediaClips" | "markers" | "sections">, endMs: number): Overflow {
  const out: Overflow = { trimmedCues: 0, removedCues: 0, mediaClips: 0, markers: 0, sections: 0 };
  for (const c of project.cues) {
    if (c.endMs <= endMs) continue;
    if (endMs - c.startMs < MIN_CUE_MS) out.removedCues += 1;
    else out.trimmedCues += 1;
  }
  out.mediaClips = project.mediaClips.filter((c) => c.startMs + c.durationMs > endMs).length;
  out.markers = project.markers.filter((m) => m.timeMs > endMs).length;
  out.sections = project.sections.filter((s) => s.endMs > endMs).length;
  return out;
}

/**
 * 是否有任何内容受影响。
 *
 * @param o 统计。
 * @returns 有内容会被裁短或删除时为 `true`。
 */
export function hasOverflow(o: Overflow): boolean {
  return o.trimmedCues + o.removedCues + o.mediaClips + o.markers + o.sections > 0;
}

/**
 * 内容的结尾：所有片段、媒体片段、段落、标记点里最晚的时刻。
 *
 * @param project 工程（只读）。
 * @returns 毫秒；没有内容时为 0。
 */
export function contentEndMs(project: Pick<ShowProject, "cues" | "mediaClips" | "markers" | "sections">): number {
  return Math.max(
    0,
    ...project.cues.map((c) => c.endMs),
    ...project.mediaClips.map((c) => c.startMs + c.durationMs),
    ...project.markers.map((m) => m.timeMs),
    ...project.sections.map((s) => s.endMs),
  );
}

/**
 * 设置节目时长。缩短时裁掉超出部分：片段裁到新结尾（裁完不足 100 ms 或起点在结尾之后的删除），
 * 淡入淡出随之收紧；媒体片段同理；段落裁短或删除；结尾之后的标记点删除；循环区间夹到范围内。
 *
 * @param d 工程草稿。
 * @param ms 新时长（会规整）。
 * @returns 实际设置的时长。
 */
export function setShowDuration(d: ShowProject, ms: number): number {
  const end = normalizeDuration(ms);
  d.durationMs = end;
  // 只在确有超出时重建数组（延长时间不产生无关的改动，撤销历史也更干净）
  if (d.cues.some((c) => c.endMs > end)) {
    d.cues = d.cues.filter((c) => {
      if (c.endMs <= end) return true;
      if (end - c.startMs < MIN_CUE_MS) return false;
      c.endMs = end;
      normalizeFades(c);
      return true;
    });
  }
  if (d.mediaClips.some((c) => c.startMs + c.durationMs > end)) {
    d.mediaClips = d.mediaClips.filter((c) => {
      if (c.startMs + c.durationMs <= end) return true;
      if (end - c.startMs < MIN_MEDIA_CLIP_MS) return false;
      c.durationMs = end - c.startMs;
      c.fadeInMs = Math.min(c.fadeInMs, c.durationMs);
      c.fadeOutMs = Math.min(c.fadeOutMs, c.durationMs - c.fadeInMs);
      return true;
    });
  }
  if (d.markers.some((m) => m.timeMs > end)) d.markers = d.markers.filter((m) => m.timeMs <= end);
  if (d.sections.some((s) => s.endMs > end)) {
    d.sections = d.sections.filter((s) => {
      if (s.endMs <= end) return true;
      if (end - s.startMs < 500) return false;
      s.endMs = end;
      return true;
    });
  }
  if (d.loopRange) setLoopRange(d, d.loopRange);
  return end;
}

/**
 * 让节目时长正好覆盖全部内容（没有内容时不变）。
 *
 * @param d 工程草稿。
 * @returns 新时长；没有内容时为当前时长。
 */
export function fitDurationToContent(d: ShowProject): number {
  const end = contentEndMs(d);
  if (end <= 0) return d.durationMs;
  return setShowDuration(d, Math.ceil(end));
}
