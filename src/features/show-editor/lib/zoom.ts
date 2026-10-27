/** 每秒对应的像素宽度范围（时间线的缩放极限）。 */
export const MIN_PX_PER_SEC = 20;
export const MAX_PX_PER_SEC = 1280;
/** 默认缩放。 */
export const DEFAULT_PX_PER_SEC = 160;
/** 每次缩放的倍率。 */
export const ZOOM_STEP = 1.25;

/**
 * 按方向缩放：放大乘以倍率，缩小除以倍率，结果夹在 [MIN, MAX] 内并取整像素。
 *
 * @param current 当前每秒像素数。
 * @param direction `1` 放大，`-1` 缩小。
 */
export function zoomPxPerSec(current: number, direction: 1 | -1): number {
  const next = direction === 1 ? current * ZOOM_STEP : current / ZOOM_STEP;
  return Math.round(Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, next)));
}
