/**
 * 读取主题变量（如 `--primary`）解析后的颜色，供 Canvas 绘制使用。
 *
 * @param el 用于解析变量的元素（需已挂载到文档）。
 * @param name CSS 变量名。
 * @param fallback 变量缺失时的回退值。
 */
export function themeColor(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}
