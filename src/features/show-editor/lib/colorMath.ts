import { hsvToRgb as hsvToUnitRgb, rgbToHsv as unitRgbToHsv, type Hsv } from "@/shared/appearance/hsv";
import { parseHex, rgbToHex as unitRgbToHex, type Rgb as UnitRgb } from "@/shared/appearance/oklch";
import type { Rgb } from "./project";

/**
 * 色盘用的颜色换算（只用于界面：色轮坐标、十六进制输入、色块显示）。
 * 灯具实际怎么混色由引擎决定（见 `mixPreview`）。
 *
 * 换算本身在 `@/shared/appearance`（各通道 0~1 的 `{ r, g, b }`）；这里只把工程里的
 * `[r, g, b]`（0~255 整数）与之互转。
 */

export type { Hsv };

/** `[r, g, b]`（0~255）→ 各通道 0~1。 */
function toUnit([r, g, b]: Rgb): UnitRgb {
  return { r: r / 255, g: g / 255, b: b / 255 };
}

/** 各通道 0~1 → `[r, g, b]`（0~255 取整）。 */
function fromUnit({ r, g, b }: UnitRgb): Rgb {
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * RGB → HSV。
 *
 * @param rgb sRGB 0~255。
 * @returns HSV；灰色的色相为 0。
 */
export function rgbToHsv(rgb: Rgb): Hsv {
  return unitRgbToHsv(toUnit(rgb));
}

/**
 * HSV → RGB。
 *
 * @param hsv HSV（饱和度、明度会被限制在 0~1）。
 * @returns sRGB 0~255（取整）。
 */
export function hsvToRgb(hsv: Hsv): Rgb {
  return fromUnit(hsvToUnitRgb(hsv));
}

/**
 * RGB → `#rrggbb`。
 *
 * @param rgb sRGB 0~255（越界会被截断）。
 * @returns 小写十六进制。
 */
export function rgbToHex(rgb: Rgb): string {
  return unitRgbToHex(toUnit(rgb));
}

/**
 * 解析 `#rgb` / `#rrggbb`（`#` 可省略）。
 *
 * @param text 输入。
 * @returns sRGB；无法解析时为 `null`。
 */
export function hexToRgb(text: string): Rgb | null {
  const unit = parseHex(text);
  return unit ? fromUnit(unit) : null;
}

/**
 * 色轮上的点（圆心为原点、半径 1）→ 色相 / 饱和度。
 *
 * @param x 横坐标（向右为正）。
 * @param y 纵坐标（向下为正，与屏幕一致）。
 * @returns 色相（0 度在正上方，顺时针）与饱和度（到圆心的距离，夹在 0~1）。
 */
export function wheelToHs(x: number, y: number): { h: number; s: number } {
  const h = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
  return { h, s: Math.min(1, Math.hypot(x, y)) };
}

/**
 * 色相 / 饱和度 → 色轮上的点（与 `wheelToHs` 互逆）。
 *
 * @param h 色相。
 * @param s 饱和度。
 * @returns 坐标（半径 1 的圆内）。
 */
export function hsToWheel(h: number, s: number): { x: number; y: number } {
  const a = (h * Math.PI) / 180;
  return { x: Math.sin(a) * s, y: -Math.cos(a) * s };
}
