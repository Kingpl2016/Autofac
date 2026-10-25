import type { ChannelSeries, SeriesPoint } from "./types";

/** 一次最多绘制的通道数（与后端 `MAX_SERIES_CHANNELS` 一致）。 */
export const MAX_CURVE_CHANNELS = 16;
/** DMX 通道编号上限（用户输入为 1 起）。 */
const DMX_CHANNELS = 512;

/** 时间窗口模式：整段节目，或跟随播放头的前后若干秒。 */
export type CurveWindow = "all" | "s10" | "s60";

const WINDOW_HALF_US: Record<Exclude<CurveWindow, "all">, number> = {
  s10: 10_000_000,
  s60: 60_000_000,
};

/**
 * 解析形如 `1, 2, 10-12` 的通道列表（用户输入为 1 起，返回 0 起）。
 *
 * 非法片段与超出 1~512 的值被忽略；结果去重升序，最多 {@link MAX_CURVE_CHANNELS} 个。
 *
 * @param text 用户输入。
 */
export function parseChannelList(text: string): number[] {
  const set = new Set<number>();
  for (const raw of text.split(/[,，\s]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+)(?:\s*[-~–]\s*(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const lo = Math.max(1, Math.min(a, b));
    const hi = Math.min(DMX_CHANNELS, Math.max(a, b));
    for (let c = lo; c <= hi && set.size < MAX_CURVE_CHANNELS * 4; c += 1) set.add(c - 1);
  }
  return [...set].sort((x, y) => x - y).slice(0, MAX_CURVE_CHANNELS);
}

/**
 * 计算曲线的查询时间窗口 `[t0, t1]`（微秒）。
 *
 * 窗口模式下以播放头为中心，并把中心吸附到半窗口的一半，使播放头缓慢移动时
 * 不必每帧重新请求；贴近两端时窗口整体平移以保持宽度。
 *
 * @param mode 窗口模式。
 * @param posUs 当前播放位置。
 * @param durationUs 节目总时长。
 */
export function curveWindow(
  mode: CurveWindow,
  posUs: number,
  durationUs: number,
): [number, number] {
  if (mode === "all" || durationUs <= 0) return [0, Math.max(0, durationUs)];
  const half = WINDOW_HALF_US[mode];
  const width = Math.min(half * 2, durationUs);
  const snap = half / 2;
  const center = Math.round(posUs / snap) * snap;
  let t0 = center - width / 2;
  t0 = Math.min(Math.max(0, t0), durationUs - width);
  return [Math.round(t0), Math.round(t0 + width)];
}

/** 折线样式：颜色取自主题图表变量，不同通道再以虚线样式区分。 */
export interface CurveStyle {
  /** CSS 变量名，如 `--chart-2` */
  colorVar: string;
  /** Canvas 虚线数组 */
  dash: number[];
}

const DASHES: number[][] = [[], [6, 3], [2, 3], [8, 3, 2, 3]];

/**
 * 第 `index` 条曲线的样式（5 种主题色 × 4 种线型 = 20 种组合）。
 *
 * @param index 曲线序号（0 起）。
 */
export function curveStyle(index: number): CurveStyle {
  return {
    colorVar: `--chart-${(index % 5) + 1}`,
    dash: DASHES[Math.floor(index / 5) % DASHES.length],
  };
}

/** 值 0..255 映射到画布 y（0 在底部，255 在顶部，上下各留 1px）。 */
export function valueToY(v: number, height: number): number {
  const usable = Math.max(1, height - 2);
  return 1 + (1 - Math.min(255, Math.max(0, v)) / 255) * usable;
}

/** 时间映射到窗口内的 x。 */
export function windowTimeToX(t: number, t0: number, t1: number, width: number): number {
  if (t1 <= t0) return 0;
  return ((Math.min(t1, Math.max(t0, t)) - t0) / (t1 - t0)) * width;
}

/**
 * 把降采样点转换为"保持式"阶梯折线的顶点（值保持到下一个点才变化）。
 *
 * @param points 降采样点（按时间升序）。
 * @param pick 取 `max`（上包络）或 `min`（下包络）。
 * @param t0 窗口起点。
 * @param t1 窗口终点。
 * @param width 画布宽。
 * @param height 画布高。
 * @returns 顶点数组 `[x, y]`；最后一个顶点延伸到右边缘。
 */
export function stepVertices(
  points: SeriesPoint[],
  pick: "min" | "max",
  t0: number,
  t1: number,
  width: number,
  height: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let prevY: number | null = null;
  for (const p of points) {
    const x = windowTimeToX(p.tUs, t0, t1, width);
    const y = valueToY(p[pick], height);
    if (prevY !== null && prevY !== y) out.push([x, prevY]);
    out.push([x, y]);
    prevY = y;
  }
  if (out.length > 0) out.push([width, out[out.length - 1][1]]);
  return out;
}

/** 绘制所需的最小 2D 上下文接口（便于单测用假对象替代）。 */
export interface CurveContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  setLineDash(d: number[]): void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
}

/** 绘制参数。 */
export interface CurveDrawOptions {
  t0: number;
  t1: number;
  width: number;
  height: number;
  /** 与 `series` 一一对应的线条颜色 */
  colors: string[];
  /** 水平参考线颜色 */
  gridColor: string;
}

/** 水平参考线对应的电平。 */
export const GRID_LEVELS = [0, 64, 128, 192, 255] as const;

/**
 * 绘制通道曲线：参考网格、min–max 范围竖条与上包络阶梯线。
 *
 * @param ctx 画布上下文。
 * @param series 各通道曲线。
 * @param o 绘制参数。
 */
export function drawCurves(
  ctx: CurveContext,
  series: ChannelSeries[],
  o: CurveDrawOptions,
): void {
  ctx.clearRect(0, 0, o.width, o.height);
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = o.gridColor;
  ctx.globalAlpha = 0.5;
  for (const level of GRID_LEVELS) {
    const y = Math.round(valueToY(level, o.height)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(o.width, y);
    ctx.stroke();
  }

  series.forEach((s, i) => {
    const style = curveStyle(i);
    ctx.strokeStyle = o.colors[i] ?? o.colors[0] ?? "currentColor";

    // 范围竖条：桶内最小到最大之间的跨度（尖峰、渐变都能看到）
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    for (const p of s.points) {
      if (p.min === p.max) continue;
      const x = Math.round(windowTimeToX(p.tUs, o.t0, o.t1, o.width)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, valueToY(p.max, o.height));
      ctx.lineTo(x, valueToY(p.min, o.height));
      ctx.stroke();
    }

    // 上包络阶梯线
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(style.dash);
    const v = stepVertices(s.points, "max", o.t0, o.t1, o.width, o.height);
    if (v.length > 0) {
      ctx.beginPath();
      ctx.moveTo(v[0][0], v[0][1]);
      for (let k = 1; k < v.length; k += 1) ctx.lineTo(v[k][0], v[k][1]);
      ctx.stroke();
    }
  });
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** 每条曲线的整体范围（屏幕阅读器摘要）。 */
export interface SeriesSummary {
  /** 通道号（1 起，便于展示） */
  channel: number;
  min: number;
  max: number;
}

/**
 * 汇总每个通道在窗口内的最小 / 最大值。
 *
 * @param series 各通道曲线。
 */
export function summarizeSeries(series: ChannelSeries[]): SeriesSummary[] {
  return series.map((s) => ({
    channel: s.channel + 1,
    min: s.points.reduce((m, p) => Math.min(m, p.min), 255),
    max: s.points.reduce((m, p) => Math.max(m, p.max), 0),
  }));
}
