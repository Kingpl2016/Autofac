// 512 通道栅格:用 Canvas 绘制,32 列 × 16 行。

import { channelIntensity, channelName } from "./format.js";

const COLUMNS = 32;

/** "#rrggbb" 或 "rgb(...)" → [r, g, b]。借助 canvas 把任意 CSS 颜色规范化。 */
function parseColor(ctx, css) {
  ctx.fillStyle = "#000";
  ctx.fillStyle = css;
  const normalized = ctx.fillStyle;
  if (normalized.startsWith("#")) {
    const n = parseInt(normalized.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(normalized);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** 在两种颜色之间按 t(0~1)线性插值。 */
export function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

/** 相对亮度,用来挑选文字颜色。 */
export function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export class DmxGrid {
  /**
   * @param {HTMLCanvasElement} canvas 画布
   * @param {HTMLElement} tip 悬浮提示元素(绝对定位在画布容器内)
   */
  constructor(canvas, tip) {
    this.canvas = canvas;
    this.tip = tip;
    this.ctx = canvas.getContext("2d");
    this.data = new Uint8Array(0);
    this._raf = 0;
    this._cellW = 20;
    this._cellH = 20;
    this._onMove = (e) => this._hover(e);
    this._onLeave = () => this.tip.classList.add("hidden");
    canvas.addEventListener("mousemove", this._onMove);
    canvas.addEventListener("mouseleave", this._onLeave);
    this._resizeObserver = new ResizeObserver(() => this._schedule());
    this._resizeObserver.observe(canvas);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this.canvas.removeEventListener("mousemove", this._onMove);
    this.canvas.removeEventListener("mouseleave", this._onLeave);
    this._resizeObserver.disconnect();
  }

  /** 更新通道数据并重绘(同一帧内多次调用只会绘制一次)。 */
  setData(data) {
    this.data = data;
    this._schedule();
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._draw();
    });
  }

  _draw() {
    const { canvas, ctx } = this;
    const cssWidth = Math.max(canvas.clientWidth, COLUMNS * 10);
    const dpr = window.devicePixelRatio || 1;
    this._cellW = cssWidth / COLUMNS;
    this._cellH = Math.max(18, Math.min(34, this._cellW * 0.9));
    const rows = Math.ceil(Math.max(this.data.length, 512) / COLUMNS);
    const cssHeight = rows * this._cellH;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.height = `${cssHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const style = getComputedStyle(canvas);
    const bg = parseColor(ctx, style.getPropertyValue("--surface-2").trim() || "#eef1f5");
    const fg = parseColor(ctx, style.getPropertyValue("--accent").trim() || "#0b6bcb");
    const text = parseColor(ctx, style.getPropertyValue("--text").trim() || "#17202b");
    const border = style.getPropertyValue("--border").trim() || "#cfd6df";

    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const showText = this._cellW >= 26;
    ctx.font = `${Math.min(12, this._cellH * 0.45)}px ui-monospace, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < 512; i += 1) {
      const col = i % COLUMNS;
      const row = Math.floor(i / COLUMNS);
      const x = col * this._cellW;
      const y = row * this._cellH;
      const has = i < this.data.length;
      const value = has ? this.data[i] : 0;
      const color = has ? mix(bg, fg, channelIntensity(value)) : bg;
      ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
      ctx.fillRect(x + 0.5, y + 0.5, this._cellW - 1, this._cellH - 1);
      if (showText && has) {
        const light = luminance(color) > 0.55;
        ctx.fillStyle = light ? "#111" : "#fff";
        if (!light && luminance(text) < 0.4 && luminance(color) < 0.3) ctx.fillStyle = "#e8edf3";
        ctx.fillText(String(value), x + this._cellW / 2, y + this._cellH / 2);
      }
    }
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    for (let r = 0; r <= rows; r += 4) {
      ctx.beginPath();
      ctx.moveTo(0, r * this._cellH);
      ctx.lineTo(cssWidth, r * this._cellH);
      ctx.stroke();
    }
  }

  _hover(event) {
    const rect = this.canvas.getBoundingClientRect();
    const col = Math.floor((event.clientX - rect.left) / this._cellW);
    const row = Math.floor((event.clientY - rect.top) / this._cellH);
    const index = row * COLUMNS + col;
    if (col < 0 || col >= COLUMNS || row < 0 || index >= 512) {
      this.tip.classList.add("hidden");
      return;
    }
    const value = index < this.data.length ? this.data[index] : null;
    this.tip.textContent =
      value === null
        ? `${channelName(index)}:无数据`
        : `${channelName(index)}:${value}(0x${value.toString(16).padStart(2, "0")})`;
    this.tip.classList.remove("hidden");
    const parent = this.canvas.parentElement.getBoundingClientRect();
    this.tip.style.left = `${event.clientX - parent.left + 12}px`;
    this.tip.style.top = `${event.clientY - parent.top + 12}px`;
  }
}
