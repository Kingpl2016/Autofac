import type { EditSegment } from "@/features/recording";

/** 编辑中的一个保留片段（源时间轴，微秒，`[startUs, endUs)`）。 */
export interface Segment extends EditSegment {
  /** 稳定 id（选中、键盘焦点与 React key 用） */
  id: string;
}

/** 片段的最短长度（微秒）：修剪与切割都不会产生更短的片段。 */
export const MIN_SEGMENT_US = 100_000;

let seq = 0;
/** 生成新的片段 id。 */
export function newSegmentId(): string {
  seq += 1;
  return `seg-${seq}`;
}

/**
 * 整段节目作为唯一的保留片段（编辑的初始状态）。
 *
 * @param durationUs 节目总时长。
 */
export function fullSegments(durationUs: number): Segment[] {
  return durationUs > 0 ? [{ id: newSegmentId(), startUs: 0, endUs: durationUs }] : [];
}

/**
 * 规整片段（与后端 `normalize_segments` 一致）：裁剪到 `[0, durationUs]`、丢弃空片段、
 * 按开始时间排序并合并重叠或首尾相接的片段。
 *
 * @param segments 片段（顺序任意）。
 * @param durationUs 节目总时长。
 * @returns 升序、互不重叠的 `{ startUs, endUs }`。
 */
export function normalizeSegments(segments: readonly EditSegment[], durationUs: number): EditSegment[] {
  const v = segments
    .map((s) => ({ startUs: Math.min(s.startUs, durationUs), endUs: Math.min(s.endUs, durationUs) }))
    .filter((s) => s.endUs > s.startUs)
    .sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  const out: EditSegment[] = [];
  for (const s of v) {
    const last = out[out.length - 1];
    if (last && s.startUs <= last.endUs) last.endUs = Math.max(last.endUs, s.endUs);
    else out.push({ ...s });
  }
  return out;
}

/**
 * 保留片段的总长度（即导出结果的时长）。
 *
 * @param segments 已规整的片段。
 */
export function totalDuration(segments: readonly EditSegment[]): number {
  return segments.reduce((n, s) => n + (s.endUs - s.startUs), 0);
}

/**
 * 不保留的区间（片段之间的间隙与首尾两端），用于在时间轴上画出“删除”标记。
 *
 * @param segments 已排序、互不重叠的片段。
 * @param durationUs 节目总时长。
 */
export function gapsOf(segments: readonly EditSegment[], durationUs: number): EditSegment[] {
  const out: EditSegment[] = [];
  let cursor = 0;
  for (const s of segments) {
    if (s.startUs > cursor) out.push({ startUs: cursor, endUs: s.startUs });
    cursor = Math.max(cursor, s.endUs);
  }
  if (cursor < durationUs) out.push({ startUs: cursor, endUs: durationUs });
  return out;
}

/**
 * 包含 `tUs` 的片段下标。
 *
 * @param segments 已排序的片段。
 * @param tUs 源时间。
 * @returns 下标；落在间隙里时为 `-1`。
 */
export function segmentIndexAt(segments: readonly EditSegment[], tUs: number): number {
  return segments.findIndex((s) => tUs >= s.startUs && tUs < s.endUs);
}

/**
 * 在 `tUs` 处把所在片段一分为二；切点离片段两端不足 {@link MIN_SEGMENT_US} 时不切。
 *
 * @param segments 已排序的片段。
 * @param tUs 切点（源时间）。
 * @returns 新片段列表与切开后右半段的 id；没有切开时原样返回、`rightId` 为 `null`。
 */
export function splitAt(segments: readonly Segment[], tUs: number): { segments: Segment[]; rightId: string | null } {
  const i = segmentIndexAt(segments, tUs);
  const s = segments[i];
  if (!s || tUs - s.startUs < MIN_SEGMENT_US || s.endUs - tUs < MIN_SEGMENT_US) {
    return { segments: [...segments], rightId: null };
  }
  const right: Segment = { id: newSegmentId(), startUs: tUs, endUs: s.endUs };
  return {
    segments: [...segments.slice(0, i), { ...s, endUs: tUs }, right, ...segments.slice(i + 1)],
    rightId: right.id,
  };
}

/**
 * 删除一个片段（被删除的时段成为间隙，导出时前后片段首尾拼接）。
 * 只剩一个片段时不删，避免导出结果为空。
 *
 * @param segments 片段。
 * @param id 要删除的片段 id。
 */
export function removeSegment(segments: readonly Segment[], id: string): Segment[] {
  if (segments.length <= 1) return [...segments];
  return segments.filter((s) => s.id !== id);
}

/**
 * 修剪片段的一端：开始点不早于前一片段的结束、结束点不晚于后一片段的开始（或节目末尾），
 * 且片段不短于 {@link MIN_SEGMENT_US}。
 *
 * @param segments 已排序的片段。
 * @param id 片段 id。
 * @param edge 修剪哪一端。
 * @param tUs 目标时间（源时间）。
 * @param durationUs 节目总时长。
 */
export function trimSegment(
  segments: readonly Segment[],
  id: string,
  edge: "start" | "end",
  tUs: number,
  durationUs: number,
): Segment[] {
  const i = segments.findIndex((s) => s.id === id);
  if (i < 0) return [...segments];
  const s = segments[i];
  const prevEnd = i > 0 ? segments[i - 1].endUs : 0;
  const nextStart = i < segments.length - 1 ? segments[i + 1].startUs : durationUs;
  const t = Math.round(tUs);
  const next =
    edge === "start"
      ? { ...s, startUs: Math.min(Math.max(t, prevEnd), s.endUs - MIN_SEGMENT_US) }
      : { ...s, endUs: Math.max(Math.min(t, nextStart), s.startUs + MIN_SEGMENT_US) };
  if (next.startUs < prevEnd || next.endUs > nextStart || next.endUs - next.startUs < MIN_SEGMENT_US) {
    return [...segments];
  }
  return segments.map((x) => (x.id === id ? next : x));
}

/**
 * 设入点：`tUs` 之前的内容全部不保留（跨过的片段被裁掉或删除）。结果为空时原样返回。
 *
 * @param segments 已排序的片段。
 * @param tUs 入点（源时间）。
 */
export function setInPoint(segments: readonly Segment[], tUs: number): Segment[] {
  const out = segments
    .filter((s) => s.endUs - Math.max(s.startUs, tUs) >= MIN_SEGMENT_US)
    .map((s) => (s.startUs < tUs ? { ...s, startUs: tUs } : s));
  return out.length > 0 ? out : [...segments];
}

/**
 * 设出点：`tUs` 之后的内容全部不保留。结果为空时原样返回。
 *
 * @param segments 已排序的片段。
 * @param tUs 出点（源时间）。
 */
export function setOutPoint(segments: readonly Segment[], tUs: number): Segment[] {
  const out = segments
    .filter((s) => Math.min(s.endUs, tUs) - s.startUs >= MIN_SEGMENT_US)
    .map((s) => (s.endUs > tUs ? { ...s, endUs: tUs } : s));
  return out.length > 0 ? out : [...segments];
}

/**
 * 预览时的下一个播放位置：落在间隙里时跳到下一个片段开头，越过最后一个片段时回到第一个片段开头。
 *
 * @param segments 已排序的片段（非空）。
 * @param tUs 当前源时间。
 * @returns 需要跳转时的目标源时间；当前就在片段内时为 `null`。
 */
export function previewJumpTarget(segments: readonly EditSegment[], tUs: number): number | null {
  if (segments.length === 0 || segmentIndexAt(segments, tUs) >= 0) return null;
  const next = segments.find((s) => s.startUs > tUs);
  return next ? next.startUs : segments[0].startUs;
}
