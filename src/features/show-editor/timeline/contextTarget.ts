import type { ContextTarget } from "../stores/useEditorUiStore";
import { pointToTimeRow, type TimelineViewport } from "./geometry";
import { START_LEFT } from "./timelineData";

/**
 * 由右键事件的目标元素与位置判断右键菜单的目标（片段、媒体片段、轨道头、媒体轨道、空白处、标尺）。
 *
 * 元素用 `data-*` 标记：`data-cue-id`、`data-media-clip-id`、`data-track-header-id`、
 * `data-media-track-header-id`、`data-media-track-id`（媒体轨道行）、`data-timeline-ruler`、`#timeline-body`。
 *
 * @param el 事件目标。
 * @param clientX 指针横坐标。
 * @param clientY 指针纵坐标。
 * @param viewport 时间线视口（换算时间与轨道；没有时时间取 0）。
 * @param trackIds 轨道 id（与视口的行一一对应）。
 * @returns 目标；不在时间线的可操作区域时为 `null`。
 */
export function resolveContextTarget(
  el: Element | null,
  clientX: number,
  clientY: number,
  viewport: TimelineViewport | null,
  trackIds: readonly string[],
): ContextTarget | null {
  if (!el) return null;
  const pick = (attr: string) => el.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) ?? null;
  const timeAt = () =>
    viewport ? Math.max(0, Math.round(((clientX - viewport.rect.left + viewport.scrollLeft - START_LEFT) / viewport.pxPerSec) * 1000)) : 0;

  const cue = pick("data-cue-id");
  if (cue) return { kind: "cue", id: cue };
  const clip = pick("data-media-clip-id");
  if (clip) return { kind: "mediaClip", id: clip };
  const header = pick("data-track-header-id");
  if (header) return { kind: "track", id: header };
  const mediaHeader = pick("data-media-track-header-id") ?? pick("data-media-track-id");
  if (mediaHeader) return { kind: "mediaTrack", id: mediaHeader };
  if (el.closest("[data-timeline-ruler]")) return { kind: "ruler", timeMs: timeAt() };
  if (el.closest("#timeline-body")) {
    const hit = viewport ? pointToTimeRow(viewport, clientX, clientY) : null;
    return { kind: "empty", trackId: hit ? (trackIds[hit.rowIndex] ?? null) : null, timeMs: hit?.timeMs ?? timeAt() };
  }
  return null;
}
