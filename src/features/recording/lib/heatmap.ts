import { cellIntensity } from "./overview";
import type { Overview } from "./types";

/** 热力图每行的最小 / 最大高度（像素）。 */
const MIN_ROW_PX = 4;
const MAX_ROW_PX = 20;
/** 目标总高度（像素）；行数很多时会超出，由容器滚动。 */
const TARGET_HEIGHT_PX = 256;

/**
 * 按行数选择每行高度：行少时放大、行多时压缩，但不低于可点击的最小高度。
 *
 * @param rows Universe 行数。
 */
export function rowHeightFor(rows: number): number {
  if (rows <= 0) return MAX_ROW_PX;
  return Math.min(MAX_ROW_PX, Math.max(MIN_ROW_PX, Math.floor(TARGET_HEIGHT_PX / rows)));
}

/**
 * 把概览矩阵折算为 `columns` 列的显示强度（0..1）。
 *
 * 列数少于桶数时同一列内取最大值，避免短暂的活动在缩小显示时被抹掉；
 * 列数多于桶数时每个桶拉伸覆盖多列。
 *
 * @param overview 解码后的概览。
 * @param columns 画布像素列数。
 * @returns 每行一个 `Float32Array`，长度为 `columns`。
 */
export function heatmapCells(overview: Overview, columns: number): Float32Array[] {
  const cols = Math.max(1, Math.floor(columns));
  return overview.universes.map((_, row) => {
    const level = overview.level[row] ?? new Uint8Array(0);
    const change = overview.change[row] ?? new Uint8Array(0);
    const out = new Float32Array(cols);
    const n = Math.min(level.length, change.length, overview.buckets);
    if (n === 0) return out;
    for (let c = 0; c < cols; c += 1) {
      const lo = Math.floor((c * n) / cols);
      const hi = Math.max(lo + 1, Math.ceil(((c + 1) * n) / cols));
      let best = 0;
      for (let b = lo; b < hi && b < n; b += 1) {
        best = Math.max(best, cellIntensity(level[b], change[b]));
      }
      out[c] = best;
    }
    return out;
  });
}

/** 屏幕阅读器用的每路摘要。 */
export interface RowSummary {
  universe: number;
  /** 有变化的时间占比 0..1 */
  activeShare: number;
  /** 最大电平 0..255 */
  peakLevel: number;
}

/**
 * 为无障碍文字替代生成每路 Universe 的活动摘要。
 *
 * @param overview 解码后的概览。
 */
export function summarizeOverview(overview: Overview): RowSummary[] {
  return overview.universes.map((universe, row) => {
    const change = overview.change[row] ?? new Uint8Array(0);
    const level = overview.level[row] ?? new Uint8Array(0);
    const active = change.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    return {
      universe,
      activeShare: change.length === 0 ? 0 : active / change.length,
      peakLevel: level.reduce((m, v) => Math.max(m, v), 0),
    };
  });
}

/** 绘制所需的最小 2D 上下文接口（便于单测用假对象替代）。 */
export interface HeatmapContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
}

/**
 * 在 2D 上下文上绘制热力图。
 *
 * @param ctx 画布上下文。
 * @param cells `heatmapCells` 的结果。
 * @param rowHeight 每行像素高度。
 * @param columns 像素列数。
 * @param color 前景色（CSS 颜色，取自主题变量）。
 * @param track 行底色（CSS 颜色，取自主题变量）。
 */
export function drawHeatmap(
  ctx: HeatmapContext,
  cells: Float32Array[],
  rowHeight: number,
  columns: number,
  color: string,
  track: string,
): void {
  ctx.clearRect(0, 0, columns, cells.length * rowHeight);
  const gap = rowHeight > 6 ? 1 : 0;
  for (let r = 0; r < cells.length; r += 1) {
    const y = r * rowHeight;
    ctx.globalAlpha = 1;
    ctx.fillStyle = track;
    ctx.fillRect(0, y, columns, rowHeight - gap);
    ctx.fillStyle = color;
    const row = cells[r];
    for (let c = 0; c < row.length; c += 1) {
      const v = row[c];
      if (v <= 0) continue;
      // 保留一个最低可见度，避免低电平 / 稀疏变化被背景吞没
      ctx.globalAlpha = 0.15 + 0.85 * v;
      ctx.fillRect(c, y, 1, rowHeight - gap);
    }
  }
  ctx.globalAlpha = 1;
}
