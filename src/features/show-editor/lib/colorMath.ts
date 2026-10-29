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

/** HSI 颜色：色相 0~360°、饱和度 0~1、强度 0~1（三通道平均值）。 */
export interface Hsi {
  h: number;
  s: number;
  i: number;
}

const DEG = Math.PI / 180;

/**
 * RGB → HSI（色彩学的标准定义：强度为三通道平均值，饱和度为 `1 - min / 强度`）。
 *
 * @param rgb sRGB 0~255。
 * @returns HSI；灰色的色相为 0，黑色的饱和度为 0。
 */
export function rgbToHsi([r8, g8, b8]: Rgb): Hsi {
  const [r, g, b] = [r8 / 255, g8 / 255, b8 / 255];
  const i = (r + g + b) / 3;
  const s = i <= 0 ? 0 : 1 - Math.min(r, g, b) / i;
  const num = 0.5 * (r - g + (r - b));
  const den = Math.sqrt((r - g) ** 2 + (r - b) * (g - b));
  if (den < 1e-9) return { h: 0, s, i };
  const theta = Math.acos(Math.min(1, Math.max(-1, num / den))) / DEG;
  return { h: b <= g ? theta : 360 - theta, s, i };
}

/**
 * HSI → RGB（与 {@link rgbToHsi} 互逆；超出 RGB 范围的组合会被截断）。
 *
 * @param hsi HSI（饱和度、强度会被限制在 0~1）。
 * @returns sRGB 0~255（取整）。
 */
export function hsiToRgb({ h, s, i }: Hsi): Rgb {
  const H = ((h % 360) + 360) % 360;
  const S = Math.min(1, Math.max(0, s));
  const I = Math.min(1, Math.max(0, i));
  // 每 120° 一个扇区：扇区起点的通道最大，下一个通道其次，第三个通道为 I(1-S)
  const sector = Math.floor(H / 120) % 3;
  const a = (H - sector * 120) * DEG;
  const low = I * (1 - S);
  const high = I * (1 + (S * Math.cos(a)) / Math.cos(60 * DEG - a));
  const mid = 3 * I - (low + high);
  const [r, g, b] = sector === 0 ? [high, mid, low] : sector === 1 ? [low, high, mid] : [mid, low, high];
  const to8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return [to8(r), to8(g), to8(b)];
}

/**
 * 旋转色相（保持 HSV 的饱和度与明度）。
 *
 * @param rgb 颜色。
 * @param degrees 旋转角度（正为顺时针）。
 * @returns 新颜色；灰色不变。
 */
export function rotateHue(rgb: Rgb, degrees: number): Rgb {
  const hsv = rgbToHsv(rgb);
  if (hsv.s === 0) return [...rgb];
  return hsvToRgb({ ...hsv, h: (((hsv.h + degrees) % 360) + 360) % 360 });
}

/** 配色方案：互补、邻近、三角、分裂互补。 */
export const HARMONIES = ["complementary", "analogous", "triad", "split"] as const;

/** 配色方案。 */
export type Harmony = (typeof HARMONIES)[number];

/** 每种方案相对基色的色相偏移（第一个为基色本身）。 */
const HARMONY_OFFSETS: Record<Harmony, readonly number[]> = {
  complementary: [0, 180],
  analogous: [0, -30, 30],
  triad: [0, 120, 240],
  split: [0, 150, 210],
};

/**
 * 按配色方案从基色生成一组颜色。
 *
 * @param rgb 基色。
 * @param harmony 方案。
 * @returns 颜色（第一个是基色）；基色是灰色时全部相同。
 */
export function harmonyColors(rgb: Rgb, harmony: Harmony): Rgb[] {
  return HARMONY_OFFSETS[harmony].map((d) => (d === 0 ? ([...rgb] as Rgb) : rotateHue(rgb, d)));
}
