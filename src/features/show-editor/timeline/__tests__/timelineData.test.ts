import { describe, expect, it } from "vitest";

import type { Track } from "../../lib/project";
import { anchoredScrollLeft, pointToTimeRow, timeToX, type TimelineViewport } from "../geometry";
import { contentWidth, msToSec, ROW_HEIGHT, rulerLabel, secToMs, START_LEFT } from "../timelineData";
import {
  COLLAPSED_HEIGHT,
  rowAt,
  rowLayout,
  rulerTicks,
  tickLabel,
  TRACK_HEIGHTS,
  visibleRows,
  visibleTimeRange,
} from "../timelineLayout";

const track = (id: string, over: Partial<Track> = {}): Track => ({
  id,
  target: { kind: "fixture", id },
  mute: false,
  solo: false,
  lock: false,
  ...over,
});

describe("时间换算与刻度文字", () => {
  it("秒毫秒互换并取整", () => {
    expect(msToSec(1500)).toBe(1.5);
    expect(secToMs(1.2345)).toBe(1235);
    expect(secToMs(0.0004)).toBe(0);
  });

  it("标尺文字", () => {
    expect(rulerLabel(0)).toBe("0:00");
    expect(rulerLabel(65)).toBe("1:05");
    expect(rulerLabel(3725)).toBe("1:02:05");
  });

  it("刻度文字：整秒为 m:ss，秒内为帧号", () => {
    expect(tickLabel(0)).toBe("0:00");
    expect(tickLabel(65_000)).toBe("1:05");
    expect(tickLabel(3_725_000)).toBe("1:02:05");
    expect(tickLabel(1000 + 10 * (1000 / 30))).toBe("10f");
  });

  it("内容宽度含左右留白", () => {
    expect(contentWidth(10_000, 100)).toBe(START_LEFT * 2 + 1000);
  });
});

describe("轨道排布与虚拟化", () => {
  const tracks = [track("a"), track("b", { height: "tall" }), track("c", { collapsed: true }), track("d", { height: "compact" })];
  const layout = rowLayout(tracks);

  it("按档位计算行高与顶边", () => {
    expect(layout.heights).toEqual([ROW_HEIGHT, TRACK_HEIGHTS.tall, COLLAPSED_HEIGHT, TRACK_HEIGHTS.compact]);
    expect(layout.tops).toEqual([0, 44, 116, 136]);
    expect(layout.total).toBe(164);
  });

  it("纵坐标落在哪一行", () => {
    expect(rowAt(layout, 0)).toBe(0);
    expect(rowAt(layout, 43.9)).toBe(0);
    expect(rowAt(layout, 44)).toBe(1);
    expect(rowAt(layout, 120)).toBe(2);
    expect(rowAt(layout, 163)).toBe(3);
    expect(rowAt(layout, 164)).toBe(-1);
    expect(rowAt(layout, -1)).toBe(-1);
  });

  it("只渲染可见行（含前后余量）", () => {
    const many = rowLayout(Array.from({ length: 1000 }, (_, i) => track(`t${i}`)));
    const [from, to] = visibleRows(many, ROW_HEIGHT * 500, ROW_HEIGHT * 10, 2);
    expect(from).toBe(498);
    expect(to).toBe(512);
    expect(visibleRows(rowLayout([]), 0, 100)).toEqual([0, 0]);
  });

  it("可见时间范围（含两侧余量，不小于 0）", () => {
    expect(visibleTimeRange(0, 1000, 100, 0)).toEqual([0, ((1000 - START_LEFT) / 100) * 1000]);
    const [from, to] = visibleTimeRange(2020, 1000, 100, 100);
    expect(from).toBe(19_000);
    expect(to).toBe(31_000);
  });
});

describe("自适应刻度", () => {
  it("主刻度间隔随缩放变化，且不少于最小间距", () => {
    expect(rulerTicks(100, 0, 10_000).stepMs).toBe(1000);
    expect(rulerTicks(20, 0, 60_000).stepMs).toBe(5000);
    // 放大到帧级：5 帧一个主刻度
    expect(rulerTicks(1000, 0, 2000).stepMs).toBeCloseTo((1000 / 30) * 5, 3);
    const ticks = rulerTicks(100, 0, 3000);
    expect(ticks.major.map((t) => t.label)).toEqual(["0:00", "0:01", "0:02", "0:03"]);
    expect(ticks.minor.length).toBeGreaterThan(0);
    expect(ticks.minor.every((m) => m % 1000 !== 0)).toBe(true);
  });

  it("从可见范围起点之后的刻度开始", () => {
    const ticks = rulerTicks(100, 4500, 7000);
    expect(ticks.major.map((t) => t.ms)).toEqual([5000, 6000, 7000]);
  });
});

describe("pointToTimeRow", () => {
  const viewport: TimelineViewport = {
    rect: { left: 100, top: 400, width: 800, height: 300 },
    scrollLeft: 0,
    scrollTop: 0,
    pxPerSec: 100,
    rows: rowLayout([track("a"), track("b"), track("c")]),
  };

  it("把屏幕坐标换算为时间和轨道", () => {
    // x = 100 + 20 + 250 → 相对编辑区 270 → 减去左侧留白 20 → 250px → 2.5 秒
    expect(pointToTimeRow(viewport, 370, 400 + ROW_HEIGHT + 5)).toEqual({ timeMs: 2500, rowIndex: 1 });
  });

  it("计入滚动距离", () => {
    const scrolled = { ...viewport, scrollLeft: 300, scrollTop: ROW_HEIGHT };
    expect(pointToTimeRow(scrolled, 100 + START_LEFT, 400 + 5)).toEqual({ timeMs: 3000, rowIndex: 1 });
  });

  it("左侧留白里时间为 0；编辑区之外或没有对应轨道返回 null", () => {
    expect(pointToTimeRow(viewport, 105, 405)).toEqual({ timeMs: 0, rowIndex: 0 });
    expect(pointToTimeRow(viewport, 50, 405)).toBeNull();
    expect(pointToTimeRow(viewport, 200, 380)).toBeNull();
    expect(pointToTimeRow(viewport, 1000, 405)).toBeNull();
    expect(pointToTimeRow(viewport, 200, 400 + ROW_HEIGHT * 3 + 1)).toBeNull();
  });
});

describe("缩放锚点", () => {
  it("缩放前后指针下方的时间点不变", () => {
    const scrollLeft = 500;
    const pointerX = 300;
    const oldPx = 100;
    const newPx = 250;
    const timeBefore = (pointerX + scrollLeft - START_LEFT) / oldPx;
    const next = anchoredScrollLeft(scrollLeft, pointerX, oldPx, newPx);
    const timeAfter = (pointerX + next - START_LEFT) / newPx;
    expect(timeAfter).toBeCloseTo(timeBefore, 6);
  });

  it("缩小到内容不足一屏时滚动距离不会变成负数", () => {
    expect(anchoredScrollLeft(0, 400, 200, 20)).toBe(0);
  });

  it("时间到横向位置", () => {
    expect(timeToX(2000, 100)).toBe(START_LEFT + 200);
  });
});
