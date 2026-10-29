/** 通用数值辅助。 */

/**
 * 把值夹在 `[min, max]` 内。
 *
 * @param value 输入值。
 * @param min 下限。
 * @param max 上限。
 * @returns 夹取后的值。
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 把值夹在 `[0, 1]` 内。
 *
 * @param value 输入值。
 * @returns 夹取后的值。
 */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
