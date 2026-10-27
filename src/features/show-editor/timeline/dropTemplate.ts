import type { CueStyle } from "../lib/cueOps";
import type { CueTemplate } from "../lib/cueTemplates";
import type { Track } from "../lib/project";
import { pointToTimeRow, type TimelineViewport } from "./geometry";

/** 放下一个模板的结果。 */
export type DropResult =
  | { kind: "added"; cueId: string; trackId: string }
  /** 放在时间线之外，或没有对应的轨道 */
  | { kind: "miss" }
  /** 位置落在已有 Cue 里，或空隙太小放不下 */
  | { kind: "noRoom"; trackId: string };

/**
 * 模板转成新建 Cue 的外观。
 *
 * @param template 素材库里的模板。
 * @returns 可传给 `addStaticCue` 的外观参数。
 */
export function templateStyle(template: CueTemplate): Partial<CueStyle> {
  return {
    rgb: [...template.rgb],
    brightness: template.brightness,
    fadeInMs: template.fadeInMs,
    fadeOutMs: template.fadeOutMs,
  };
}

/**
 * 处理把模板拖放到时间线上：按指针位置找到轨道与时间，新建 Cue。
 *
 * @param viewport 时间线当前视口；时间线未挂载时为 `null`。
 * @param pointer 放下时指针的屏幕坐标。
 * @param tracks 当前全部轨道（与时间线行一一对应）。
 * @param template 被拖拽的模板。
 * @param addAt 实际新建 Cue 的函数（见 `useCueActions`），放不下时返回 `null`。
 * @returns 放下的结果。
 */
export function dropTemplate(
  viewport: TimelineViewport | null,
  pointer: { x: number; y: number },
  tracks: readonly Track[],
  template: CueTemplate,
  addAt: (trackId: string, timeMs: number, style: Partial<CueStyle>) => string | null,
): DropResult {
  return dropOnTimeline(viewport, pointer, tracks, (trackId, timeMs) =>
    addAt(trackId, timeMs, templateStyle(template)),
  );
}

/**
 * 处理把任意素材（模板、特效…）拖放到时间线上：按指针位置找到轨道与时间，交给 `add` 新建 Cue。
 *
 * @param viewport 时间线当前视口；时间线未挂载时为 `null`。
 * @param pointer 放下时指针的屏幕坐标。
 * @param tracks 当前全部轨道（与时间线行一一对应）。
 * @param add 在指定轨道与时间新建 Cue 的函数，放不下时返回 `null`。
 * @returns 放下的结果。
 */
export function dropOnTimeline(
  viewport: TimelineViewport | null,
  pointer: { x: number; y: number },
  tracks: readonly Track[],
  add: (trackId: string, timeMs: number) => string | null,
): DropResult {
  if (!viewport) return { kind: "miss" };
  const hit = pointToTimeRow(viewport, pointer.x, pointer.y);
  const track = hit ? tracks[hit.rowIndex] : undefined;
  if (!hit || !track) return { kind: "miss" };
  const cueId = add(track.id, hit.timeMs);
  return cueId ? { kind: "added", cueId, trackId: track.id } : { kind: "noRoom", trackId: track.id };
}
