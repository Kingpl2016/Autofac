import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { addStaticCue, convertToLook, updateLooks } from "../cueOps";
import {
  adjacentKey,
  hasKeyAt,
  heldValueAt,
  lookKeyTimes,
  removeKeyAt,
  segmentCurve,
  setKeyAt,
  setSegmentCurve,
  setValueAt,
  toggleKeyAt,
} from "../keyframes";
import { fixed } from "../looks";
import { addFixtures } from "../ops";
import { createEmptyProject, type Param } from "../project";
import { projectIntegrityIssues } from "../schema";
import { RGBW } from "./testkit";

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

describe("关键帧编辑", () => {
  it("固定值打第一帧变成关键帧；同一帧（半帧以内）再打是改值；删到一帧退回固定值", () => {
    let p: Param<number> = fixed(30);
    p = toggleKeyAt(p, 500, 30);
    expect(p).toEqual({ kind: "keys", keys: [{ tMs: 500, value: 30, curve: "linear" }] });
    p = setKeyAt(p, 1500, 80, "easeIn");
    p = setKeyAt(p, 1510, 90);
    expect(p.kind === "keys" && p.keys).toEqual([
      { tMs: 500, value: 30, curve: "linear" },
      { tMs: 1500, value: 90, curve: "easeIn" },
    ]);
    expect(hasKeyAt(p, 1490)).toBe(true);
    expect(hasKeyAt(p, 1000)).toBe(false);
    p = toggleKeyAt(p, 1500, 0);
    expect(p).toEqual(fixed(30));
    expect(removeKeyAt(fixed(5), 0)).toEqual(fixed(5));
  });

  it("有关键帧时改值自动在播放头处打帧（剪映的自动关键帧）；没有时改成固定值", () => {
    expect(setValueAt(fixed(1), 300, 9)).toEqual(fixed(9));
    expect(setValueAt(undefined, 300, 9)).toEqual(fixed(9));
    const keyed = setKeyAt<number>(undefined, 0, 0);
    const p = setValueAt(keyed, 1000, 100);
    expect(p.kind === "keys" && p.keys.map((k) => [k.tMs, k.value])).toEqual([
      [0, 0],
      [1000, 100],
    ]);
  });

  it("区段插值方式：改的是播放头之前最近那一帧", () => {
    let p = setKeyAt<number>(setKeyAt<number>(setKeyAt<number>(undefined, 0, 0), 1000, 50), 2000, 100);
    p = setSegmentCurve(p, 1500, "hold");
    expect(segmentCurve(p, 1200)).toBe("hold");
    expect(segmentCurve(p, 500)).toBe("linear");
    expect(segmentCurve(fixed(1), 0)).toBeNull();
  });

  it("关键帧导航、外观的全部关键帧时刻、保持值", () => {
    const times = [0, 1000, 2000];
    expect(adjacentKey(times, 1000, 1)).toBe(2000);
    expect(adjacentKey(times, 1000, -1)).toBe(0);
    expect(adjacentKey(times, 2000, 1)).toBeNull();
    const look = {
      intensity: setKeyAt<number>(setKeyAt<number>(undefined, 0, 0), 800, 100),
      color: setKeyAt(undefined, 400, { kind: "rgb" as const, rgb: [1, 2, 3] as [number, number, number] }),
      attrs: { pan: setKeyAt<number>(undefined, 800, 0.5) },
    };
    expect(lookKeyTimes(look)).toEqual([0, 400, 800]);
    expect(heldValueAt(look.intensity, 500)).toBe(0);
    expect(heldValueAt(look.intensity, 900)).toBe(100);
  });

  it("引擎取值与关键帧插值一致（属性面板显示的值）", () => {
    const p: Param<number> = {
      kind: "keys",
      keys: [
        { tMs: 0, value: 0, curve: "linear" },
        { tMs: 1000, value: 100, curve: "hold" },
        { tMs: 2000, value: 0, curve: "linear" },
      ],
    };
    expect(engine.sampleNum(p, 500, 2000)).toBeCloseTo(50);
    expect(engine.sampleNum(p, 1500, 2000)).toBeCloseTo(100);
    expect(engine.sampleNum({ kind: "curve", curve: { shape: "square", from: 0, to: 100, cycles: 1, phase: 0 } }, 250, 1000)).toBe(100);
  });
});

describe("外观片段", () => {
  it("静态 Cue 转成外观片段：颜色变成 RGB 意图，时间与淡入淡出不变；可以再打关键帧", () => {
    let id = "";
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
      id = addStaticCue(d, d.tracks[0].id, 1000, { rgb: [10, 20, 30], fadeInMs: 200, lengthMs: 2000 }) ?? "";
    });
    const next = produce(p, (d) => {
      expect(convertToLook(d, [id])).toBe(1);
      updateLooks(d, [id], (look) => void (look.intensity = setKeyAt(look.intensity, 500, 40)));
    });
    const cue = next.cues[0];
    expect(cue).toMatchObject({ kind: "look", startMs: 1000, endMs: 3000, fadeInMs: 200 });
    expect(cue.kind === "look" && cue.look.color).toEqual(fixed({ kind: "rgb", rgb: [10, 20, 30] }));
    expect(cue.kind === "look" && cue.look.intensity?.kind).toBe("keys");
    expect(projectIntegrityIssues(next)).toEqual([]);
  });
});
