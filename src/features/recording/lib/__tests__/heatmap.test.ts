import { describe, expect, it } from "vitest";

import {
  drawHeatmap,
  heatmapCells,
  rowHeightFor,
  summarizeOverview,
  type HeatmapContext,
} from "../heatmap";
import type { Overview } from "../types";

const overview = (over: Partial<Overview> = {}): Overview => ({
  durationUs: 1_000_000,
  buckets: 4,
  universes: [1, 2],
  change: [Uint8Array.from([0, 255, 0, 0]), Uint8Array.from([0, 0, 0, 0])],
  level: [Uint8Array.from([0, 255, 255, 0]), Uint8Array.from([100, 100, 100, 100])],
  frames: 3,
  skippedFrames: 0,
  ...over,
});

describe("rowHeightFor", () => {
  it("行少时放大、行多时压缩但不低于最小高度", () => {
    expect(rowHeightFor(1)).toBe(20);
    expect(rowHeightFor(8)).toBe(20);
    expect(rowHeightFor(16)).toBe(16);
    expect(rowHeightFor(64)).toBe(4);
    expect(rowHeightFor(500)).toBe(4);
    expect(rowHeightFor(0)).toBe(20);
  });
});

describe("heatmapCells", () => {
  it("列数等于桶数时一一对应", () => {
    const [r0, r1] = heatmapCells(overview(), 4);
    expect(r0[0]).toBe(0);
    expect(r0[1]).toBeCloseTo(1, 5); // 电平 255 + 变化 255
    expect(r0[2]).toBeCloseTo(0.7, 5); // 仅电平
    expect(r1[0]).toBeCloseTo((100 / 255) * 0.7, 5);
  });

  it("缩小显示取列内最大值，短暂活动不会被抹掉", () => {
    const [r0] = heatmapCells(overview(), 1);
    expect(r0).toHaveLength(1);
    expect(r0[0]).toBeCloseTo(1, 5);
  });

  it("放大显示时每个桶覆盖多列", () => {
    const [r0] = heatmapCells(overview(), 8);
    expect(r0).toHaveLength(8);
    expect(r0[2]).toBeCloseTo(r0[3], 5); // 桶 1 覆盖第 2、3 列
  });

  it("缺失行数据时退化为全 0 而不是抛错", () => {
    const rows = heatmapCells(overview({ level: [], change: [] }), 5);
    expect(rows).toHaveLength(2);
    expect([...rows[0]]).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("summarizeOverview", () => {
  it("给出每路的活动占比与最大电平", () => {
    const s = summarizeOverview(overview());
    expect(s[0]).toEqual({ universe: 1, activeShare: 0.25, peakLevel: 255 });
    expect(s[1]).toEqual({ universe: 2, activeShare: 0, peakLevel: 100 });
  });
});

describe("drawHeatmap", () => {
  it("每行先画底色，再只为非零单元格画前景", () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx: HeatmapContext = {
      fillStyle: "",
      globalAlpha: 1,
      clearRect: (...a) => calls.push(["clear", ...a]),
      fillRect: (...a) => calls.push(["fill", ctx.fillStyle, ctx.globalAlpha, ...a]),
    };
    const cells = [Float32Array.from([0, 1, 0.5]), Float32Array.from([0, 0, 0])];
    drawHeatmap(ctx, cells, 10, 3, "FG", "BG");

    expect(calls[0]).toEqual(["clear", 0, 0, 3, 20]);
    const fills = calls.filter((c) => c[0] === "fill");
    // 两行底色 + 第一行 2 个前景格
    expect(fills).toHaveLength(4);
    expect(fills.filter((c) => c[1] === "FG")).toHaveLength(2);
    expect(fills.filter((c) => c[1] === "BG")).toHaveLength(2);
    // 前景透明度随强度变化且不低于最小可见度
    const alphas = fills.filter((c) => c[1] === "FG").map((c) => c[2] as number);
    expect(alphas[0]).toBeCloseTo(1, 5);
    expect(alphas[1]).toBeGreaterThan(0.15);
    expect(alphas[1]).toBeLessThan(alphas[0]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("传入色阶数组时按强度分档取色（冷 → 暖）", () => {
    const fills: Array<{ style: unknown; alpha: number }> = [];
    const ctx: HeatmapContext = {
      fillStyle: "",
      globalAlpha: 1,
      clearRect: () => {},
      fillRect: () => fills.push({ style: ctx.fillStyle, alpha: ctx.globalAlpha }),
    };
    const ramp = ["C0", "C1", "C2", "C3", "C4"];
    // 一行 5 个单元格，强度依次落在 5 个档位里；1 会被钳制到最后一档
    drawHeatmap(ctx, [Float32Array.from([0.1, 0.3, 0.5, 0.7, 1])], 10, 5, ramp, "BG");

    const fg = fills.filter((f) => f.style !== "BG");
    expect(fg.map((f) => f.style)).toEqual(ramp);
    // 多色阶下颜色本身表达强度，透明度只保证可见（不低于 0.5），强度越高越不透明
    expect(fg[0].alpha).toBeGreaterThanOrEqual(0.5);
    expect(fg[4].alpha).toBeCloseTo(1, 5);
    expect(fg[0].alpha).toBeLessThan(fg[4].alpha);
  });
});
