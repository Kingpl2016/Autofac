/** Canvas 绘制的公共辅助。 */

/**
 * 读取主题变量（如 `--primary`）解析后的颜色，供 Canvas 绘制使用。
 *
 * @param el 用于解析变量的元素（需已挂载到文档）。
 * @param name CSS 变量名。
 * @param fallback 变量缺失时的回退值。
 * @returns 颜色字符串。
 */
export function themeColor(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 按设备像素比准备一块高清画布：把位图尺寸设为 CSS 尺寸 × DPR，坐标系缩放回 CSS 像素，并清空。
 *
 * @param canvas 画布。
 * @param width CSS 宽度（像素）。
 * @param height CSS 高度（像素）。
 * @returns 2D 上下文（之后按 CSS 像素绘制）；拿不到上下文时为 `null`。
 */
export function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}
