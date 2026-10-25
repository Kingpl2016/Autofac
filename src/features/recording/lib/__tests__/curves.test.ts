import { describe, expect, it } from "vitest";

import {
  MAX_CURVE_CHANNELS,
  curveStyle,
  curveWindow,
  drawCurves,
  parseChannelList,
  stepVertices,
  summarizeSeries,
  valueToY,
  windowTimeToX,
  type CurveContext,
} from "../curves";
import type { ChannelSeries } from "../types";

describe("parseChannelList", () => {
  it("1 起输入转 0 起，去重升序", () => {
    expect(parseChannelList("3, 1, 1, 10-12")).toEqual([0, 2, 9, 10, 11]);
  });

  it("忽略非法片段与越界值", () => {
    expect(parseChannelList("abc, 0, 513, 5")).toEqual([4]);
    expect(parseChannelList("510-600")).toEqual([509, 510, 511]);
    expect(parseChannelList("")).toEqual([]);
  });

  it("反向范围自动纠正，数量被限制", () => {
    expect(parseChannelList("5-3")).toEqual([2, 3, 4]);
    expect(parseChannelList("1-100")).toHaveLength(MAX_CURVE_CHANNELS);
  });
});

describe("curveWindow", () => {
  const D = 600_000_000;
  it("整段节目", () => {
    expect(curveWindow("all", 123, D)).toEqual([0, D]);
  });

  it("以播放头为中心并吸附，窗口宽度恒定", () => {
    const [t0, t1] = curveWindow("s10", 300_000_000, D);
    expect(t1 - t0).toBe(20_000_000);
    expect(t0).toBe(290_000_000);
    // 播放头小幅移动不改变窗口（吸附到半窗口的一半 = 5s）
    expect(curveWindow("s10", 301_900_000, D)).toEqual([t0, t1]);
  });

  it("贴近两端时整体平移而不缩窄", () => {
    expect(curveWindow("s10", 1_000_000, D)).toEqual([0, 20_000_000]);
    expect(curveWindow("s10", D, D)).toEqual([D - 20_000_000, D]);
  });

  it("节目比窗口短时覆盖整段", () => {
    expect(curveWindow("s60", 5_000_000, 30_000_000)).toEqual([0, 30_000_000]);
    expect(curveWindow("s10", 0, 0)).toEqual([0, 0]);
  });
});

describe("坐标与样式", () => {
  it("值映射到 y：255 在顶部、0 在底部", () => {
    expect(valueToY(255, 102)).toBe(1);
    expect(valueToY(0, 102)).toBe(101);
    expect(valueToY(999, 102)).toBe(1);
  });

  it("时间映射到 x 并钳制", () => {
    expect(windowTimeToX(50, 0, 100, 200)).toBe(100);
    expect(windowTimeToX(-5, 0, 100, 200)).toBe(0);
    expect(windowTimeToX(500, 0, 100, 200)).toBe(200);
    expect(windowTimeToX(5, 10, 10, 200)).toBe(0);
  });

  it("20 种样式互不相同", () => {
    const keys = new Set(
      Array.from({ length: 20 }, (_, i) => {
        const s = curveStyle(i);
        return `${s.colorVar}|${s.dash.join(",")}`;
      }),
    );
    expect(keys.size).toBe(20);
    expect(curveStyle(0)).toEqual({ colorVar: "--chart-1", dash: [] });
    expect(curveStyle(5).dash).toEqual([6, 3]);
  });
});

describe("stepVertices", () => {
  it("保持式阶梯：值变化时先水平延伸再垂直跳变，末尾延伸到右边缘", () => {
    const v = stepVertices(
      [
        { tUs: 0, min: 0, max: 0 },
        { tUs: 50, min: 255, max: 255 },
      ],
      "max",
      0,
      100,
      100,
      102,
    );
    expect(v).toEqual([
      [0, 101],
      [50, 101],
      [50, 1],
      [100, 1],
    ]);
  });

  it("没有点时没有顶点", () => {
    expect(stepVertices([], "max", 0, 1, 10, 10)).toEqual([]);
  });
});

describe("summarizeSeries", () => {
  it("通道号转回 1 起并汇总范围", () => {
    const s: ChannelSeries[] = [
      {
        channel: 4,
        points: [
          { tUs: 0, min: 10, max: 20 },
          { tUs: 1, min: 5, max: 90 },
        ],
      },
    ];
    expect(summarizeSeries(s)).toEqual([{ channel: 5, min: 5, max: 90 }]);
  });
});

describe("drawCurves", () => {
  it("先画 5 条参考线，再为每条曲线画范围竖条与阶梯线，结束时复位状态", () => {
    let strokes = 0;
    const dashes: number[][] = [];
    const ctx: CurveContext = {
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      clearRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {
        strokes += 1;
      },
      setLineDash: (d) => dashes.push(d),
    };
    const series: ChannelSeries[] = [
      {
        channel: 0,
        points: [
          { tUs: 0, min: 0, max: 0 },
          { tUs: 50, min: 10, max: 200 }, // 有范围 → 一根竖条
        ],
      },
      { channel: 1, points: [] },
    ];
    drawCurves(ctx, series, {
      t0: 0,
      t1: 100,
      width: 100,
      height: 100,
      colors: ["A", "B"],
      gridColor: "G",
    });
    // 5 条网格 + 1 根竖条 + 第一条曲线的阶梯线；第二条无点不画
    expect(strokes).toBe(5 + 1 + 1);
    expect(ctx.globalAlpha).toBe(1);
    expect(dashes[dashes.length - 1]).toEqual([]);
  });
});
