import type { Rgb } from "./project";

/**
 * 色盘用的颜色换算（只用于界面：色轮坐标、十六进制输入、色块显示）。
 * 灯具实际怎么混色由引擎决定（见 `mixPreview`）。
 */

/** HSV：色相 0~360，饱和度 / 明度 0~1。 */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/**
 * RGB → HSV。
 *
 * @param rgb sRGB 0~255。
 * @returns HSV；灰色的色相为 0。
 */
export function rgbToHsv([r, g, b]: Rgb): Hsv {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/**
 * HSV → RGB。
 *
 * @param hsv HSV。
 * @returns sRGB 0~255（取整）。
 */
export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * RGB → `#rrggbb`。
 *
 * @param rgb sRGB 0~255。
 * @returns 小写十六进制。
 */
export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 解析 `#rgb` / `#rrggbb`（`#` 可省略）。
 *
 * @param text 输入。
 * @returns sRGB；无法解析时为 `null`。
 */
export function hexToRgb(text: string): Rgb | null {
  const s = text.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) return [0, 1, 2].map((i) => parseInt(s[i] + s[i], 16)) as Rgb;
  if (/^[0-9a-f]{6}$/i.test(s)) return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb;
  return null;
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

/** HSL：色相 0~360，饱和度 / 亮度 0~1。 */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/**
 * RGB → HSL。
 *
 * @param rgb sRGB 0~255。
 * @returns HSL；灰色的色相与饱和度为 0。
 */
export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  return { h: rgbToHsv([r, g, b]).h, s: Math.min(1, s), l };
}

/**
 * HSL → RGB。
 *
 * @param hsl HSL（超出范围的值会夹回）。
 * @returns sRGB 0~255（取整）。
 */
export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const ss = Math.min(1, Math.max(0, s));
  const ll = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = ll - c / 2;
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
