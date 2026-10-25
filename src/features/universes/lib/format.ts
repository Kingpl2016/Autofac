import type { ValueFormat } from "@/features/settings";

/**
 * 按值格式化通道值。
 *
 * @param v 通道值 0-255。
 * @param format 值显示格式。
 * @returns 格式化后的字符串。
 */
export function formatChannelValue(v: number, format: ValueFormat): string {
  switch (format) {
    case "hex":
      return v.toString(16).toUpperCase().padStart(2, "0");
    case "percent":
      return `${Math.round((v / 255) * 100)}`;
    case "decimal":
    default:
      return String(v);
  }
}

/**
 * 将通道值映射为电平颜色（黑 → 蓝 → 青 → 白）。
 *
 * @param v 通道值 0-255。
 * @returns CSS `rgb(...)` 字符串。
 */
export function levelColor(v: number): string {
  const t = v / 255;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 1 / 3) {
    const k = t * 3;
    r = 0;
    g = 0;
    b = Math.round(60 + k * 195);
  } else if (t <= 2 / 3) {
    const k = (t - 1 / 3) * 3;
    r = 0;
    g = Math.round(k * 255);
    b = 255;
  } else {
    const k = (t - 2 / 3) * 3;
    r = Math.round(k * 255);
    g = 255;
    b = 255;
  }
  return `rgb(${r}, ${g}, ${b})`;
}
