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

/** 缩放滑块的刻度数（0 = 最小缩放，`ZOOM_SLIDER_STEPS` = 最大缩放）。 */
export const ZOOM_SLIDER_STEPS = 100;

/**
 * 缩放值 → 滑块位置（对数刻度：每一格的缩放倍率相同，手感均匀）。
 *
 * @param pxPerSec 每秒像素数。
 * @returns 0~`ZOOM_SLIDER_STEPS` 的整数。
 */
export function zoomToSlider(pxPerSec: number): number {
  const v = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec));
  return Math.round((Math.log(v / MIN_PX_PER_SEC) / Math.log(MAX_PX_PER_SEC / MIN_PX_PER_SEC)) * ZOOM_SLIDER_STEPS);
}

/**
 * 滑块位置 → 缩放值。
 *
 * @param position 0~`ZOOM_SLIDER_STEPS`。
 * @returns 每秒像素数（取整，夹在范围内）。
 */
export function sliderToZoom(position: number): number {
  const p = Math.min(ZOOM_SLIDER_STEPS, Math.max(0, position)) / ZOOM_SLIDER_STEPS;
  return Math.round(MIN_PX_PER_SEC * (MAX_PX_PER_SEC / MIN_PX_PER_SEC) ** p);
}
