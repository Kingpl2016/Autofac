import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { addStaticCue } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { anchoredScrollLeft, pointToTimeRow, timeToX, type TimelineViewport } from "../geometry";
import {
  buildRows,
  diffRows,
  msToSec,
  ROW_HEIGHT,
  rulerLabel,
  scaleCountFor,
  secToMs,
  START_LEFT,
} from "../timelineData";

function sample(): { project: ShowProject; a: string; b: string } {
  const project = produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    d.durationMs = 30_000;
    addStaticCue(d, d.tracks[0].id, 1000, { lengthMs: 2000 });
    addStaticCue(d, d.tracks[0].id, 5000, { lengthMs: 1000 });
    addStaticCue(d, d.tracks[1].id, 0, { lengthMs: 4000 });
  });
  return { project, a: project.tracks[0].id, b: project.tracks[1].id };
}

describe("buildRows", () => {
  it("每条轨道一行，Cue 按起点排序，时间换算为秒", () => {
    const { project, a } = sample();
    const rows = buildRows(project, new Set());
    expect(rows.map((r) => r.id)).toEqual(project.tracks.map((t) => t.id));
    expect(rows[0].id).toBe(a);
    expect(rows[0].actions.map((x) => [x.start, x.end])).toEqual([
      [1, 3],
      [5, 6],
    ]);
    expect(rows[0].rowHeight).toBe(ROW_HEIGHT);
  });

  it("用左右邻居限定每个 Cue 的活动范围，保证拖动时不会重叠", () => {
    const { project } = sample();
    const [first, second] = buildRows(project, new Set())[0].actions;
    expect([first.minStart, first.maxEnd]).toEqual([0, 5]);
    expect([second.minStart, second.maxEnd]).toEqual([3, 30]);
  });

  it("选中状态与锁定轨道", () => {
    const { project } = sample();
    const id = project.cues[0].id;
    const locked = produce(project, (d) => {
      d.tracks[1].lock = true;
    });
    const rows = buildRows(locked, new Set([id]));
    expect(rows[0].actions[0].selected).toBe(true);
    expect(rows[0].actions[1].selected).toBe(false);
    expect(rows[0].actions[0].movable).toBe(true);
    expect(rows[1].actions[0]).toMatchObject({ movable: false, flexible: false });
  });
});

describe("diffRows", () => {
  it("没变化时为空；有移动 / 拉伸时给出新的毫秒值", () => {
    const { project } = sample();
    const rows = buildRows(project, new Set());
    expect(diffRows(project, rows)).toEqual([]);
    rows[0].actions[0].start = 1.5;
    rows[0].actions[0].end = 4.0004;
    rows[1].actions[0].end = 3.999;
    expect(diffRows(project, rows)).toEqual([
      { id: project.cues.find((c) => c.startMs === 1000)!.id, startMs: 1500, endMs: 4000 },
      { id: project.cues.find((c) => c.startMs === 0)!.id, startMs: 0, endMs: 3999 },
    ]);
  });

  it("忽略工程里不存在的 Cue", () => {
    const { project } = sample();
    const rows = buildRows(project, new Set());
    rows[0].actions.push({ id: "ghost", start: 0, end: 1, effectId: "cue" });
    expect(diffRows(project, rows)).toEqual([]);
  });
});

describe("时间换算与刻度", () => {
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

  it("刻度数向上取整且至少为 1", () => {
    expect(scaleCountFor(180_000)).toBe(180);
    expect(scaleCountFor(180_001)).toBe(181);
    expect(scaleCountFor(0)).toBe(1);
  });
});

describe("pointToTimeRow", () => {
  const viewport: TimelineViewport = {
    rect: { left: 100, top: 400, width: 800, height: 300 },
    scrollLeft: 0,
    scrollTop: 0,
    pxPerSec: 100,
    rowCount: 3,
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
    // 只有 3 条轨道，第 4 行没有对应轨道
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
