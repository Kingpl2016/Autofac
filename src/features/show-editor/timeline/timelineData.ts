/** 默认轨道行高（像素），与 `TRACK_HEIGHTS.normal` 一致。 */
export const ROW_HEIGHT = 44;

/** 标尺区高度（像素）。 */
export const RULER_HEIGHT = 32;

/** 时间线左侧留白（像素）：时间 0 距内容左边缘的距离。 */
export const START_LEFT = 20;

/**
 * 毫秒转秒。
 *
 * @param ms 毫秒。
 * @returns 秒。
 */
export function msToSec(ms: number): number {
  return ms / 1000;
}

/**
 * 秒转毫秒，四舍五入到整数。
 *
 * @param sec 秒。
 * @returns 毫秒。
 */
export function secToMs(sec: number): number {
  return Math.round(sec * 1000);
}

/**
 * 标尺刻度文字：整秒显示为 `m:ss`，一小时以上为 `h:mm:ss`。
 *
 * @param sec 刻度对应的秒。
 * @returns 文字。
 */
export function rulerLabel(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * 时间线内容的总宽度（像素）：节目时长加左右留白。
 *
 * @param durationMs 节目时长。
 * @param pxPerSec 每秒像素数。
 * @returns 像素。
 */
export function contentWidth(durationMs: number, pxPerSec: number): number {
  return START_LEFT * 2 + (Math.max(0, durationMs) / 1000) * pxPerSec;
}
