import type { CompiledShow } from "../engine/engine";
import type { Rgb } from "./project";

/**
 * 时间线色带（剪映的“缩略图条”在灯光里的对应物）：按固定步长对引擎采样，得到每台灯具在一段时间里的实际输出色。
 *
 * 一次采样求值全部灯具，所以 N 列只需 N 次求值，与片段数量无关；每个片段从中截取自己那一段。
 */

/** 一段时间的采样结果。 */
export interface ColorLanes {
  /** 第一列的时刻 */
  fromMs: number;
  /** 列间隔 */
  stepMs: number;
  /** 列数 */
  columns: number;
  /** 灯具 id → 每列的颜色 */
  colors: Map<string, Rgb[]>;
}

/** 单次采样最多的列数（防止极端缩放时卡顿）。 */
export const MAX_LANE_COLUMNS = 600;

/**
 * 对 `[fromMs, toMs)` 按 `stepMs` 采样。
 *
 * @param compiled 编译结果；`null` 时返回空结果。
 * @param fromMs 起点。
 * @param toMs 终点。
 * @param stepMs 列间隔（至少 1 毫秒）。
 * @returns 采样结果；列数超过 [`MAX_LANE_COLUMNS`] 时自动放大步长。
 */
export function sampleLanes(compiled: CompiledShow | null, fromMs: number, toMs: number, stepMs: number): ColorLanes {
  const span = Math.max(0, toMs - fromMs);
  let step = Math.max(1, stepMs);
  if (span / step > MAX_LANE_COLUMNS) step = span / MAX_LANE_COLUMNS;
  const columns = Math.max(0, Math.ceil(span / step));
  const colors = new Map<string, Rgb[]>();
  if (!compiled || columns === 0) return { fromMs, stepMs: step, columns: 0, colors };
  for (const id of compiled.fixtureIds) colors.set(id, new Array<Rgb>(columns));
  for (let c = 0; c < columns; c += 1) {
    // 取列中点，避免恰好落在片段边界上
    const bytes = compiled.previewAt(fromMs + (c + 0.5) * step);
    compiled.fixtureIds.forEach((id, i) => {
      const list = colors.get(id);
      if (list) list[c] = [bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]];
    });
  }
  return { fromMs, stepMs: step, columns, colors };
}

/**
 * 把若干灯具在 `[startMs, endMs)` 内的采样合成一条 CSS 渐变（硬边色块），用于片段底部的色带。
 *
 * 多台灯具（分组 / 场景轨道）取平均色。
 *
 * @param lanes 采样结果。
 * @param fixtureIds 轨道驱动的灯具。
 * @param startMs 片段起点。
 * @param endMs 片段终点。
 * @param maxStops 最多的色块数（宽度很窄时合并相邻列）。
 * @returns `linear-gradient(...)`；没有覆盖到的采样时为 `null`。
 */
export function stripGradient(
  lanes: ColorLanes,
  fixtureIds: readonly string[],
  startMs: number,
  endMs: number,
  maxStops = 48,
): string | null {
  if (lanes.columns === 0 || endMs <= startMs) return null;
  const lists = fixtureIds.map((id) => lanes.colors.get(id)).filter((l): l is Rgb[] => l !== undefined);
  if (lists.length === 0) return null;
  const first = Math.max(0, Math.floor((startMs - lanes.fromMs) / lanes.stepMs));
  const last = Math.min(lanes.columns, Math.ceil((endMs - lanes.fromMs) / lanes.stepMs));
  if (last <= first) return null;
  const n = last - first;
  const groups = Math.min(maxStops, n);
  const stops: string[] = [];
  for (let g = 0; g < groups; g += 1) {
    const a = first + Math.floor((g * n) / groups);
    const b = Math.max(a + 1, first + Math.floor(((g + 1) * n) / groups));
    let r = 0;
    let gg = 0;
    let bl = 0;
    let count = 0;
    for (let c = a; c < b; c += 1) {
      for (const list of lists) {
        const col = list[c];
        if (!col) continue;
        r += col[0];
        gg += col[1];
        bl += col[2];
        count += 1;
      }
    }
    const color = count === 0 ? "rgb(0 0 0)" : `rgb(${Math.round(r / count)} ${Math.round(gg / count)} ${Math.round(bl / count)})`;
    // 只覆盖片段与采样范围的交集；用硬边（同一位置两个色标）
    const from = ((lanes.fromMs + a * lanes.stepMs - startMs) / (endMs - startMs)) * 100;
    const to = ((lanes.fromMs + b * lanes.stepMs - startMs) / (endMs - startMs)) * 100;
    stops.push(`${color} ${Math.max(0, from).toFixed(2)}% ${Math.min(100, to).toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
