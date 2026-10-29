/**
 * 每秒对应的像素宽度范围（时间线的缩放极限）。下限足够小，几个小时的节目也能整场放进一屏。
 */
export const MIN_PX_PER_SEC = 0.5;
export const MAX_PX_PER_SEC = 1280;
/** 默认缩放。 */
export const DEFAULT_PX_PER_SEC = 160;
/** 每次缩放的倍率。 */
export const ZOOM_STEP = 1.25;

/**
 * 规整缩放值：夹在 [MIN, MAX] 内；10 以上取整像素，以下保留两位小数（低缩放时取整会跳得太粗）。
 *
 * @param px 每秒像素数。
 * @returns 规整后的值。
 */
export function normalizeZoom(px: number): number {
  const v = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, Number.isFinite(px) ? px : DEFAULT_PX_PER_SEC));
  return v >= 10 ? Math.round(v) : Math.round(v * 100) / 100;
}

/**
 * 按方向缩放：放大乘以倍率，缩小除以倍率，结果夹在 [MIN, MAX] 内。
 *
 * @param current 当前每秒像素数。
 * @param direction `1` 放大，`-1` 缩小。
 * @returns 新的每秒像素数。
 */
export function zoomPxPerSec(current: number, direction: 1 | -1): number {
  return normalizeZoom(direction === 1 ? current * ZOOM_STEP : current / ZOOM_STEP);
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
 * @returns 每秒像素数（规整后，夹在范围内）。
 */
export function sliderToZoom(position: number): number {
  const p = Math.min(ZOOM_SLIDER_STEPS, Math.max(0, position)) / ZOOM_SLIDER_STEPS;
  return normalizeZoom(MIN_PX_PER_SEC * (MAX_PX_PER_SEC / MIN_PX_PER_SEC) ** p);
}

/** 缩放到某段时间时两侧各留的边距（视口宽度的比例）。 */
const RANGE_MARGIN = 0.05;

/**
 * 缩放到一段时间：这段时间铺满视口（两侧各留 5% 边距），并算出让它居中的横向滚动位置。
 *
 * @param range 时间范围（毫秒）；长度为 0 时按 1 秒处理。
 * @param viewWidth 视口宽度（像素）。
 * @param startLeft 时间 0 在内容里的横坐标（像素）。
 * @returns 每秒像素数与横向滚动位置。
 */
export function zoomToRange(range: { startMs: number; endMs: number }, viewWidth: number, startLeft = 0): { pxPerSec: number; scrollLeft: number } {
  const start = Math.min(range.startMs, range.endMs);
  const length = Math.max(1000, Math.abs(range.endMs - range.startMs));
  const usable = Math.max(1, viewWidth * (1 - 2 * RANGE_MARGIN));
  const pxPerSec = normalizeZoom(usable / (length / 1000));
  // 真正的宽度（缩放被夹住时可能比视口宽或窄）：让范围居中
  const width = (length / 1000) * pxPerSec;
  const x = startLeft + (start / 1000) * pxPerSec;
  return { pxPerSec, scrollLeft: Math.max(0, Math.round(x - (viewWidth - width) / 2)) };
}
