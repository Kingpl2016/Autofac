import { describe, expect, it } from "vitest";

import { createEmptyProject, type ShowProject } from "../project";
import { collectSnapTargets, pxToMs, snapSpan, snapValue, SNAP_THRESHOLD_PX } from "../snap";
import { produce } from "immer";

describe("snapValue", () => {
  it("吸到范围内最近的目标，范围外不动", () => {
    expect(snapValue(1040, [1000, 2000], 50)).toBe(1000);
    expect(snapValue(1060, [1000, 2000], 50)).toBe(1060);
    expect(snapValue(1960, [1000, 2000], 50)).toBe(2000);
    expect(snapValue(500, [], 50)).toBe(500);
  });

  it("两个目标都在范围内时取更近的", () => {
    expect(snapValue(1480, [1450, 1500], 100)).toBe(1500);
  });

  it("刚好在边界上也吸附", () => {
    expect(snapValue(1050, [1000], 50)).toBe(1000);
  });
});

describe("snapSpan", () => {
  const targets = [1000, 3000, 5000];
  const threshold = 60;

  it("只拉起点：吸附起点，终点不变", () => {
    expect(snapSpan({ startMs: 1030, endMs: 4000 }, { startMs: 2000, endMs: 4000 }, targets, threshold)).toEqual({
      startMs: 1000,
      endMs: 4000,
    });
  });

  it("只拉终点：吸附终点", () => {
    expect(snapSpan({ startMs: 2000, endMs: 3040 }, { startMs: 2000, endMs: 4000 }, targets, threshold)).toEqual({
      startMs: 2000,
      endMs: 3000,
    });
  });

  it("整体移动：起点吸上时终点同量平移，长度保持不变", () => {
    const moved = snapSpan({ startMs: 1040, endMs: 2040 }, { startMs: 2000, endMs: 3000 }, targets, threshold);
    expect(moved).toEqual({ startMs: 1000, endMs: 2000 });
    expect(moved.endMs - moved.startMs).toBe(1000);
  });

  it("整体移动：终点更接近目标时按终点吸附", () => {
    expect(snapSpan({ startMs: 1500, endMs: 2970 }, { startMs: 2000, endMs: 3000 }, targets, threshold)).toEqual({
      startMs: 1530,
      endMs: 3000,
    });
  });

  it("起点和终点都能吸上时取距离更小的那个", () => {
    const result = snapSpan({ startMs: 2030, endMs: 3010 }, { startMs: 1000, endMs: 1980 }, [2000, 3000], threshold);
    expect(result).toEqual({ startMs: 2020, endMs: 3000 });
  });

  it("够不着任何目标或根本没动时原样返回", () => {
    const far = { startMs: 1500, endMs: 2500 };
    expect(snapSpan(far, { startMs: 1000, endMs: 2000 }, targets, threshold)).toEqual(far);
    expect(snapSpan(far, far, targets, threshold)).toEqual(far);
  });
});

describe("collectSnapTargets", () => {
  const project = (): ShowProject =>
    produce(createEmptyProject("t"), (d) => {
      d.durationMs = 10_000;
      d.markers.push({ id: "m", timeMs: 4000, label: "x" });
      d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
      d.cues.push(
        { id: "a", trackId: "t", kind: "static", startMs: 1200, endMs: 2200, brightness: 100, fadeInMs: 0, fadeOutMs: 0, easing: "linear", rgb: [1, 1, 1] },
        { id: "b", trackId: "t", kind: "static", startMs: 6100, endMs: 7100, brightness: 100, fadeInMs: 0, fadeOutMs: 0, easing: "linear", rgb: [1, 1, 1] },
      );
    });

  it("包含工程起止、播放头、标记点、其他 Cue 的边缘和拍点（去重）", () => {
    const targets = collectSnapTargets(project(), 3333);
    for (const t of [0, 10_000, 3333, 4000, 1200, 2200, 6100, 7100, 500, 9500]) expect(targets).toContain(t);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("排除正在拖动的 Cue 的边缘", () => {
    const targets = collectSnapTargets(project(), 0, new Set(["a"]));
    expect(targets).not.toContain(1200);
    expect(targets).toContain(6100);
  });

  it("没有节拍时不含拍点", () => {
    const p = produce(project(), (d) => { d.tempo = null; });
    expect(collectSnapTargets(p, 0)).not.toContain(500);
  });
});

describe("pxToMs", () => {
  it("像素换算为毫秒", () => {
    expect(pxToMs(SNAP_THRESHOLD_PX, 100)).toBe(100);
    expect(pxToMs(50, 200)).toBe(250);
  });
});
