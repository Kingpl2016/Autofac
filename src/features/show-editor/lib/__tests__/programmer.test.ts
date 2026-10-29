import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { createPreviewEvaluator } from "../color";
import { addStaticCue } from "../cueOps";
import {
  applyPattern,
  groupSelection,
  invertSelection,
  modelSelection,
  ordered,
  selectionOfTracks,
  stepSelection,
  trackSelection,
} from "../fixtureSelection";
import { fixed } from "../looks";
import { addFixtures, createGroup } from "../ops";
import {
  hasProgrammerValues,
  knockout,
  PROGRAMMER_TRACK_ID,
  programAttr,
  programColor,
  programIntensity,
  recordLooks,
  recordScene,
  withProgrammer,
} from "../programmer";
import { createEmptyProject, type ShowProject } from "../project";
import { projectIntegrityIssues } from "../schema";
import { DIMMER, PIXEL_BAR, RGBW } from "./testkit";

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

/** 4 台 RGBW + 1 台调光灯，时长 10 秒；灯 1~2 组成分组。 */
function rig(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 4);
    addFixtures(d, DIMMER, 1);
    d.durationMs = 10_000;
    d.output.gamma = 1;
    createGroup(d, "前排", [d.fixtures[1].id, d.fixtures[0].id]);
  });
}

describe("选择工具", () => {
  const all = ["a", "b", "c", "d", "e"];

  it("反选、奇偶、前后半、隔 N 选 1（作用于当前选择，没有选择时作用于全部）", () => {
    expect(invertSelection(all, ["b", "d"])).toEqual(["a", "c", "e"]);
    expect(applyPattern(all, [], { kind: "odd" })).toEqual(["a", "c", "e"]);
    expect(applyPattern(all, [], { kind: "even" })).toEqual(["b", "d"]);
    expect(applyPattern(all, ["e", "a", "c"], { kind: "even" })).toEqual(["c"]);
    expect(applyPattern(all, [], { kind: "firstHalf" })).toEqual(["a", "b", "c"]);
    expect(applyPattern(all, [], { kind: "secondHalf" })).toEqual(["d", "e"]);
    expect(applyPattern(all, [], { kind: "every", n: 2, offset: 1 })).toEqual(["b", "d"]);
    expect(applyPattern(all, [], { kind: "every", n: 3, offset: 0 })).toEqual(["a", "d"]);
    expect(ordered(all, ["e", "ghost", "a"])).toEqual(["a", "e"]);
  });

  it("逐个前进 / 后退循环", () => {
    expect(stepSelection(all, [], 1)).toEqual(["a"]);
    expect(stepSelection(all, [], -1)).toEqual(["e"]);
    expect(stepSelection(all, ["b", "c"], 1)).toEqual(["d"]);
    expect(stepSelection(all, ["e"], 1)).toEqual(["a"]);
    expect(stepSelection(all, ["a"], -1)).toEqual(["e"]);
    expect(stepSelection([], ["a"], 1)).toEqual([]);
  });

  it("按分组（保持成员顺序）、按模型、按轨道选择", () => {
    const p = rig();
    expect(groupSelection(p, p.groups[0].id)).toEqual([p.fixtures[1].id, p.fixtures[0].id]);
    expect(modelSelection(p, DIMMER.id)).toEqual([p.fixtures[4].id]);
    expect(trackSelection(p, p.tracks[2].id)).toEqual([p.fixtures[2].id]);
    expect(trackSelection(p, "ghost")).toEqual([]);
  });

  it("轨道选择换算成灯具选择：灯具 / 分组 / 场景轨道，去重；只选一条分组轨道时带上分组", () => {
    const base = rig();
    const p = produce(base, (d) => {
      d.tracks.push({ id: "sc", target: { kind: "scene" }, mute: false, solo: false, lock: false, name: "场景" });
      d.cues.push({
        id: "c",
        kind: "scene",
        trackId: "sc",
        startMs: 0,
        endMs: 1000,
        brightness: 100,
        fadeInMs: 0,
        fadeOutMs: 0,
        easing: "linear",
        entries: [{ fixtureId: d.fixtures[3].id, look: {} }, { fixtureId: d.fixtures[0].id, look: {} }],
      });
    });
    const f = p.fixtures.map((x) => x.id);
    const groupTrack = p.tracks.find((t) => t.target.kind === "group")?.id ?? "";
    expect(groupTrack).not.toBe("");
    expect(selectionOfTracks(p, [p.tracks[2].id])).toEqual({ fixtureIds: [f[2]], groupId: null });
    expect(selectionOfTracks(p, [groupTrack])).toEqual({ fixtureIds: [f[1], f[0]], groupId: p.groups[0].id });
    expect(selectionOfTracks(p, ["sc"])).toEqual({ fixtureIds: [f[3], f[0]], groupId: null });
    // 多条：按轨道顺序去重，不再带分组；已删除的轨道忽略
    expect(selectionOfTracks(p, [groupTrack, p.tracks[0].id, "ghost", "sc"])).toEqual({ fixtureIds: [f[1], f[0], f[3]], groupId: null });
    expect(selectionOfTracks(p, [])).toEqual({ fixtureIds: [], groupId: null });
  });
});

describe("编程器内容", () => {
  it("设强度 / 颜色 / 属性，按层去掉，空了就移出", () => {
    let v = programIntensity({}, ["a", "b"], 150);
    expect(v.a.intensity).toEqual(fixed(100));
    v = programColor(v, ["a"], { kind: "rgb", rgb: [255, 0, 0] });
    v = programAttr(v, ["b"], "pan", 0.25);
    expect(v.b.attrs?.pan).toEqual(fixed(0.25));
    expect(hasProgrammerValues(v)).toBe(true);
    v = knockout(v, ["a"], "intensity");
    expect(v.a).toEqual({ color: fixed({ kind: "rgb", rgb: [255, 0, 0] }) });
    v = knockout(v, ["b"], "pan");
    expect(v.b).toEqual({ intensity: fixed(100) });
    v = knockout(v, ["b"]);
    expect(v.b).toBeUndefined();
    expect(hasProgrammerValues(knockout(v))).toBe(false);
  });
});

describe("预览叠加（置顶层）", () => {
  it("编程器的颜色胜过节目里后开始的外观片段，不同灯具可以是不同颜色", () => {
    const p = produce(rig(), (d) => {
      d.cues.push({
        id: "green",
        kind: "look",
        trackId: d.tracks[0].id,
        startMs: 5000,
        endMs: 7000,
        brightness: 100,
        fadeInMs: 0,
        fadeOutMs: 0,
        easing: "linear",
        look: { intensity: fixed(100), color: fixed({ kind: "rgb", rgb: [0, 255, 0] }) },
      });
    });
    let v = programIntensity({}, [p.fixtures[0].id, p.fixtures[1].id], 100);
    v = programColor(v, [p.fixtures[0].id], { kind: "rgb", rgb: [255, 0, 0] });
    v = programColor(v, [p.fixtures[1].id], { kind: "rgb", rgb: [0, 0, 255] });
    const composed = withProgrammer(p, v);
    expect(composed.tracks.at(-1)).toMatchObject({ id: PROGRAMMER_TRACK_ID, onTop: true });
    expect(p.tracks.some((t) => t.id === PROGRAMMER_TRACK_ID)).toBe(false);
    const colors = createPreviewEvaluator(composed, engine)(6000);
    expect(colors.get(p.fixtures[0].id)).toEqual([255, 0, 0]);
    expect(colors.get(p.fixtures[1].id)).toEqual([0, 0, 255]);
    expect(colors.get(p.fixtures[2].id)).toEqual([0, 0, 0]);
  });

  it("编程器为空时原样返回；有独奏轨道时编程器轨道也独奏", () => {
    const p = rig();
    expect(withProgrammer(p, {})).toBe(p);
    const solo = produce(p, (d) => void (d.tracks[2].solo = true));
    const composed = withProgrammer(solo, programIntensity({}, [p.fixtures[0].id], 100));
    expect(composed.tracks.at(-1)?.solo).toBe(true);
  });
});

describe("记录", () => {
  it("记录为场景片段：没有场景轨道时自动新建；多台灯各自的外观；完整性成立", () => {
    const p = rig();
    let v = programIntensity({}, [p.fixtures[0].id, p.fixtures[3].id], 80);
    v = programColor(v, [p.fixtures[3].id], { kind: "kelvin", kelvin: 3200 });
    let result!: ReturnType<typeof recordScene>;
    const next = produce(p, (d) => {
      result = recordScene(d, v, 1010, 2000, "场景");
    });
    expect(result.trackIds).toHaveLength(1);
    const clip = next.cues.find((c) => c.id === result.cueIds[0]);
    expect(clip).toMatchObject({ kind: "scene", startMs: 1000, endMs: 3000 });
    expect(clip?.kind === "scene" && clip.entries.map((e) => e.fixtureId)).toEqual([p.fixtures[0].id, p.fixtures[3].id]);
    expect(next.tracks.find((t) => t.id === result.trackIds[0])).toMatchObject({ target: { kind: "scene" }, name: "场景" });
    expect(projectIntegrityIssues(next)).toEqual([]);

    // 再记录一次：复用已有场景轨道，长度不越过后一个片段
    const again = produce(next, (d) => {
      result = recordScene(d, v, 0, 5000, "场景");
    });
    expect(result.trackIds).toHaveLength(0);
    expect(again.cues.find((c) => c.id === result.cueIds[0])).toMatchObject({ startMs: 0, endMs: 1000 });
  });

  it("像素也能编程：场景条目按“整灯、各像素”的顺序记录，预览按像素输出", () => {
    const p = produce(createEmptyProject("t"), (d) => void addFixtures(d, PIXEL_BAR, 1));
    const f = p.fixtures[0].id;
    // 整灯只给颜色（不发光），像素 1、3 给颜色 + 强度
    let v = programColor({}, [`${f}#3`, `${f}#1`, f], { kind: "rgb", rgb: [0, 0, 255] });
    v = programIntensity(v, [`${f}#3`, `${f}#1`], 100);
    // 不存在的像素不记录
    v = programIntensity(v, [`${f}#9`], 100);
    let result!: ReturnType<typeof recordScene>;
    const next = produce(p, (d) => {
      result = recordScene(d, v, 0, 2000, "场景");
    });
    const clip = next.cues.find((c) => c.id === result.cueIds[0]);
    expect(clip?.kind === "scene" && clip.entries.map((e) => e.fixtureId)).toEqual([f, `${f}#1`, `${f}#3`]);
    expect(projectIntegrityIssues(next)).toEqual([]);

    const colors = createPreviewEvaluator(withProgrammer(p, v), engine)(500);
    expect(colors.get(`${f}#1`)?.[2]).toBeGreaterThan(200);
    expect(colors.get(`${f}#2`)).toEqual([0, 0, 0]);
  });

  it("记录到各自轨道：每台灯一个外观片段，被占用的跳过", () => {
    const p = produce(rig(), (d) => {
      addStaticCue(d, d.tracks[1].id, 0, { lengthMs: 3000 });
    });
    const v = programIntensity({}, [p.fixtures[0].id, p.fixtures[1].id], 50);
    let result!: ReturnType<typeof recordLooks>;
    const next = produce(p, (d) => {
      result = recordLooks(d, v, 1000, 2000);
    });
    expect(result.cueIds).toHaveLength(1);
    expect(result.skipped).toEqual([p.fixtures[1].id]);
    const clip = next.cues.find((c) => c.id === result.cueIds[0]);
    expect(clip).toMatchObject({ kind: "look", trackId: p.tracks[0].id, look: { intensity: fixed(50) } });
    expect(projectIntegrityIssues(next)).toEqual([]);
  });

  it("编程器为空时什么都不记录", () => {
    const p = rig();
    const next = produce(p, (d) => {
      expect(recordScene(d, {}, 0, 1000, "场景").cueIds).toEqual([]);
    });
    expect(next).toBe(p);
  });
});
