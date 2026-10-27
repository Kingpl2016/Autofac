/**
 * OKLCH 色彩数学：十六进制转换与格式化（无第三方依赖）。
 * 用于把用户选的主色折算成应用 CSS 里的 `--accent-h` / `--accent-c`。
 */

/** OKLCH 颜色：l 为 0 到 1 的亮度，c 为色度，h 为 0 到 360 的色相角。 */
export interface Oklch {
  /** 亮度，0 到 1。 */
  l: number;
  /** 色度，通常 0 到 0.4。 */
  c: number;
  /** 色相角，0 到 360。 */
  h: number;
}

/** sRGB 颜色，各通道 0 到 1。 */
export interface Rgb {
  /** 红。 */
  r: number;
  /** 绿。 */
  g: number;
  /** 蓝。 */
  b: number;
}

/** 限制数值范围。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 四舍五入到指定小数位。 */
function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** 把 0 到 1 的通道值转为两位十六进制。 */
function toHexChannel(value: number): string {
  return Math.round(clamp(value, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0");
}

/** sRGB 通道转线性光。 */
function toLinear(channel: number): number {
  return channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** 线性光转 sRGB 通道（越界部分被截断）。 */
function fromLinear(channel: number): number {
  const value = clamp(channel, 0, 1);
  return value <= 0.003_130_8 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/**
 * 解析十六进制颜色（支持 3 位与 6 位，可带 `#`）。
 *
 * @param hex 十六进制颜色字符串。
 * @returns sRGB 颜色；格式不合法时返回 null。
 */
export function parseHex(hex: string): Rgb | null {
  const text = hex.trim().replace(/^#/, "");
  const full = text.length === 3 ? [...text].map((char) => char + char).join("") : text;
  if (!/^[\da-f]{6}$/i.test(full)) return null;
  return {
    r: Number.parseInt(full.slice(0, 2), 16) / 255,
    g: Number.parseInt(full.slice(2, 4), 16) / 255,
    b: Number.parseInt(full.slice(4, 6), 16) / 255,
  };
}

/**
 * 将 sRGB 颜色转为 OKLCH。
 *
 * @param rgb sRGB 颜色。
 * @returns OKLCH 颜色。
 */
export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.412_221_470_8 * lr + 0.536_332_536_3 * lg + 0.051_445_992_9 * lb);
  const m = Math.cbrt(0.211_903_498_2 * lr + 0.680_699_545_1 * lg + 0.107_396_956_6 * lb);
  const s = Math.cbrt(0.088_302_461_9 * lr + 0.281_718_837_6 * lg + 0.629_978_700_5 * lb);
  const lightness = 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s;
  const a = 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s;
  const bb = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s;
  const chroma = Math.hypot(a, bb);
  // 接近灰色时色相没有意义，统一为 0
  const hue = chroma < 1e-4 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l: lightness, c: chroma, h: hue };
}

/**
 * 将 OKLCH 转为 sRGB；超出 sRGB 色域的部分按通道截断。
 *
 * @param color OKLCH 颜色。
 * @returns sRGB 颜色。
 */
export function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const cubedL = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const cubedM = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const cubedS = (l - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  return {
    r: fromLinear(4.076_741_662_1 * cubedL - 3.307_711_591_3 * cubedM + 0.230_969_929_2 * cubedS),
    g: fromLinear(-1.268_438_004_6 * cubedL + 2.609_757_401_1 * cubedM - 0.341_319_396_5 * cubedS),
    b: fromLinear(-0.004_196_086_3 * cubedL - 0.703_418_614_7 * cubedM + 1.707_614_701 * cubedS),
  };
}

/**
 * 将十六进制颜色转为 OKLCH。
 *
 * @param hex 十六进制颜色。
 * @returns OKLCH 颜色；格式不合法时返回 null。
 */
export function hexToOklch(hex: string): Oklch | null {
  const rgb = parseHex(hex);
  return rgb ? rgbToOklch(rgb) : null;
}

/**
 * 将 sRGB 颜色格式化为十六进制字符串。
 *
 * @param rgb sRGB 颜色。
 * @returns 形如 `#6366f1` 的字符串。
 */
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b)}`;
}

/**
 * 将 OKLCH 颜色格式化为 CSS 字符串。
 *
 * @param color OKLCH 颜色。
 * @returns 形如 `oklch(0.623 0.214 259.8)` 的字符串。
 */
export function formatOklch({ l, c, h }: Oklch): string {
  return `oklch(${roundTo(clamp(l, 0, 1), 3)} ${roundTo(Math.max(c, 0), 3)} ${roundTo(h, 1)})`;
}

/** 计算相对亮度（WCAG 2.x），返回 0 到 1。 */
function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * 计算两个 OKLCH 颜色的 WCAG 对比度。
 *
 * @param first 颜色一。
 * @param second 颜色二。
 * @returns 1 到 21 的对比度；普通文字要求至少 4.5。
 */
export function contrastRatio(first: Oklch, second: Oklch): number {
  const a = relativeLuminance(oklchToRgb(first));
  const b = relativeLuminance(oklchToRgb(second));
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}
