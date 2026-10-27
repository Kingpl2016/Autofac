import { START_LEFT, ROW_HEIGHT } from "./timelineData";

/** 时间线编辑区当前的视口信息。 */
export interface TimelineViewport {
  /** 编辑区（不含标尺）相对屏幕的矩形 */
  rect: { left: number; top: number; width: number; height: number };
  /** 横向滚动距离（像素） */
  scrollLeft: number;
  /** 纵向滚动距离（像素） */
  scrollTop: number;
  /** 每秒像素数 */
  pxPerSec: number;
  /** 轨道数 */
  rowCount: number;
}

/**
 * 把屏幕坐标换算成（时间，轨道下标）。
 *
 * 用于从素材库拖拽模板到时间线时找到放下的位置。
 *
 * @param viewport 编辑区视口信息。
 * @param clientX 指针的屏幕横坐标。
 * @param clientY 指针的屏幕纵坐标。
 * @returns 指针在编辑区内时给出毫秒时间（不小于 0）与轨道下标；在编辑区之外或没有对应轨道时为 `null`。
 */
export function pointToTimeRow(
  viewport: TimelineViewport,
  clientX: number,
  clientY: number,
): { timeMs: number; rowIndex: number } | null {
  const { rect, scrollLeft, scrollTop, pxPerSec, rowCount } = viewport;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  const rowIndex = Math.floor((y + scrollTop) / ROW_HEIGHT);
  if (rowIndex < 0 || rowIndex >= rowCount) return null;
  const timeMs = Math.max(0, Math.round(((x + scrollLeft - START_LEFT) / pxPerSec) * 1000));
  return { timeMs, rowIndex };
}

/**
 * 缩放时保持指针下方的时间点不动，计算新的横向滚动距离。
 *
 * @param scrollLeft 缩放前的横向滚动距离。
 * @param pointerX 指针相对编辑区左边缘的横坐标。
 * @param oldPx 缩放前每秒像素数。
 * @param newPx 缩放后每秒像素数。
 * @returns 新的横向滚动距离（不小于 0）。
 */
export function anchoredScrollLeft(
  scrollLeft: number,
  pointerX: number,
  oldPx: number,
  newPx: number,
): number {
  const timeSec = (pointerX + scrollLeft - START_LEFT) / oldPx;
  return Math.max(0, timeSec * newPx + START_LEFT - pointerX);
}

/**
 * 时间对应的横向像素位置（相对时间线内容区，含左侧留白）。
 *
 * @param timeMs 毫秒。
 * @param pxPerSec 每秒像素数。
 */
export function timeToX(timeMs: number, pxPerSec: number): number {
  return START_LEFT + (timeMs / 1000) * pxPerSec;
}
