// 迷你趋势图:用 canvas 画一条折线。颜色取自 CSS 变量,深浅色主题自动适配。

import { h } from "./dom.js";
import { sparkPoints } from "./format.js";

const WIDTH = 120;
const HEIGHT = 28;

/** 创建一个趋势图 canvas。label 供读屏器朗读(canvas 本身没有文字内容)。 */
export function createSpark(label) {
  return h("canvas", { class: "spark", width: WIDTH, height: HEIGHT, role: "img", "aria-label": label });
}

/** 用最新的数值序列重画趋势图;label 会同步到 aria-label,方便读屏器读到最新值。 */
export function drawSpark(canvas, values, { floor = 1, label = null } = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const styles = getComputedStyle(canvas);
  const line = styles.getPropertyValue("--accent").trim() || "#0b6bcb";
  const grid = styles.getPropertyValue("--border").trim() || "#999999";
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEIGHT - 0.5);
  ctx.lineTo(WIDTH, HEIGHT - 0.5);
  ctx.stroke();
  const points = sparkPoints(values, WIDTH, HEIGHT, floor);
  if (points.length > 0) {
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }
  if (label !== null) canvas.setAttribute("aria-label", label);
}
