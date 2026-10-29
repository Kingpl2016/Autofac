import { useEffect, type RefObject } from "react";

import { useAppearanceRevision } from "@/features/appearance";
import { drawHeatmap, heatmapCells } from "../lib/heatmap";
import { collapseRows } from "../lib/recordTimeline";
import { themeColor } from "@/shared/lib/canvas";
import type { Overview } from "../lib/types";

/** 热力色阶（冷 → 暖）对应的主题变量。 */
const HEAT_VARS = ["--heat-0", "--heat-1", "--heat-2", "--heat-3", "--heat-4"] as const;

/** 绘制选项。 */
export interface HeatCanvasOptions {
  /** 把所有行合成一行（每列取最大值），用于单行的迷你时间线 */
  collapse?: boolean;
  /** 行底色使用的主题变量（默认 `--muted`） */
  track?: string;
}

/**
 * 把概览画成热力图：数据、尺寸或外观（主题 / 主色）变化时重绘。
 *
 * 单元格折算放在 effect 里做，组件每次重渲染（例如 10Hz 的时间码）不会重复计算或重绘。
 *
 * @param canvasRef 目标画布。
 * @param overview 概览数据；为 `null` 时不绘制。
 * @param width 画布像素宽度（列数）；不大于 0 时不绘制。
 * @param rowHeight 每行像素高度。
 * @param options 绘制选项。
 */
export function useHeatCanvas(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  overview: Overview | null,
  width: number,
  rowHeight: number,
  options: HeatCanvasOptions = {},
): void {
  const appearanceRevision = useAppearanceRevision();
  const collapse = options.collapse ?? false;
  const track = options.track ?? "--muted";
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !overview || width <= 0) return;
    const full = heatmapCells(overview, width);
    const cells = collapse ? collapseRows(full) : full;
    const height = cells.length * rowHeight;
    if (height <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // 测试环境（jsdom）没有 2D 上下文
    canvas.width = width;
    canvas.height = height;
    drawHeatmap(
      ctx,
      cells,
      rowHeight,
      width,
      HEAT_VARS.map((v) => themeColor(canvas, v, "currentColor")),
      themeColor(canvas, track, "transparent"),
    );
    // appearanceRevision 只用于触发重绘：颜色变量变化后重新取色
  }, [canvasRef, overview, width, rowHeight, collapse, track, appearanceRevision]);
}
