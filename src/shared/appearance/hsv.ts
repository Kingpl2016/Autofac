/** HSV 色彩模型：颜色选择器的饱和度 / 明度面板与色相条使用，和十六进制互转。 */
import { parseHex, rgbToHex, type Rgb } from "./oklch";

/** HSV 颜色：h 为 0 到 360 的色相角，s 与 v 为 0 到 1。 */
export interface Hsv {
  /** 色相角，0 到 360。 */
  h: number;
  /** 饱和度，0 到 1。 */
  s: number;
  /** 明度，0 到 1。 */
  v: number;
}

/**
 * sRGB 转 HSV。
 *
 * @param rgb sRGB 颜色。
 * @returns HSV 颜色；灰色的色相为 0。
 */
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

/**
 * HSV 转 sRGB。
 *
 * @param hsv HSV 颜色（s、v 会被限制在 0 到 1）。
 * @returns sRGB 颜色。
 */
export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const saturation = Math.min(1, Math.max(0, s));
  const value = Math.min(1, Math.max(0, v));
  const chroma = value * saturation;
  const sector = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r1, g1, b1] = (
    [
      [chroma, x, 0],
      [x, chroma, 0],
      [0, chroma, x],
      [0, x, chroma],
      [x, 0, chroma],
      [chroma, 0, x],
    ] as const
  )[Math.min(5, Math.floor(sector))] ?? [0, 0, 0];
  const m = value - chroma;
  return { r: r1 + m, g: g1 + m, b: b1 + m };
}

/**
 * 十六进制转 HSV。
 *
 * @param hex 十六进制颜色。
 * @returns HSV 颜色；格式不合法时返回 null。
 */
export function hexToHsv(hex: string): Hsv | null {
  const rgb = parseHex(hex);
  return rgb ? rgbToHsv(rgb) : null;
}

/**
 * HSV 转十六进制。
 *
 * @param hsv HSV 颜色。
 * @returns 形如 `#6366f1` 的小写字符串。
 */
export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

/**
 * 规范化用户输入的十六进制颜色（支持 3 位简写、可省略 `#`）。
 *
 * @param input 用户输入。
 * @returns 形如 `#rrggbb` 的小写字符串；不合法时返回 null。
 */
export function normalizeHex(input: string): string | null {
  const rgb = parseHex(input);
  return rgb ? rgbToHex(rgb) : null;
}
