import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { useProgrammerStore, PROGRAMMER_HISTORY_LIMIT } from "../../stores/useProgrammerStore";
import { createPreviewEvaluator } from "../color";
import { addLookCue } from "../cueOps";
import { fixed } from "../looks";
import { addFixtures, trackFixtureIds } from "../ops";
import {
  DEFAULT_RECORD_PREFS,
  fanValues,
  fanWeights,
  highlightLook,
  programFan,
  programIntensity,
  programIntensityBy,
  recordLengthMs,
  recordScene,
  sanitizeRecordPrefs,
  updateCuesFromProgrammer,
  withHighlight,
  withProgrammer,
} from "../programmer";
import { createEmptyProject, type ShowProject } from "../project";
import { HEAD16, PIXEL_BAR, RGBW, prop } from "./testkit";

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

/** 4 台 RGBW + 1 台摇头灯，时长 10 秒，每台一条轨道。 */
function rig(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 4);
    addFixtures(d, HEAD16, 1);
    d.durationMs = 10_000;
    d.output.gamma = 1;
  });
}

const round = (xs: number[]) => xs.map((x) => Math.round(x * 1000) / 1000);

describe("强度快捷按钮", () => {
  it("在各自当前值上加减，限制在 0~100，没设过的从 0 开始", () => {
    let v = programIntensity({}, ["a"], 95);
    v = programIntensity(v, ["b"], 30);
    v = programIntensityBy(v, ["a", "b", "c"], 10);
    expect([v.a.intensity, v.b.intensity, v.c.intensity]).toEqual([fixed(100), fixed(40), fixed(10)]);
    v = programIntensityBy(v, ["c"], -50);
    expect(v.c.intensity).toEqual(fixed(0));
  });
});

describe("分布（Align / Fan）", () => {
  it("五种方式的权重（5 台）", () => {
    expect(round(fanWeights(5, "/"))).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(round(fanWeights(5, "<"))).toEqual([1, 0.75, 0.5, 0.25, 0]);
    expect(round(fanWeights(5, ">"))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(round(fanWeights(5, "><"))).toEqual([0, 0.5, 1, 0.5, 0]);
    expect(round(fanWeights(5, "<>"))).toEqual([1, 0.5, 0, 0.5, 1]);
  });

  it("边界：0 台为空，1 台直接取 B，2 台为两端", () => {
    expect(fanWeights(0, ">")).toEqual([]);
    expect(fanValues(1, 10, 80, "/")).toEqual([80]);
    expect(fanValues(2, 10, 80, ">")).toEqual([10, 80]);
    expect(fanValues(2, 10, 80, "<>")).toEqual([80, 80]);
  });

  it("过渡：正弦两端密、先慢后快、先快后慢；端点不变，正负号保留", () => {
    const sine = fanWeights(5, ">", "sine");
    expect(round([sine[0], sine[2], sine[4]])).toEqual([0, 0.5, 1]);
    expect(sine[1]).toBeLessThan(0.25);
    expect(fanWeights(5, ">", "slow")[1]).toBeCloseTo(0.0625);
    expect(fanWeights(5, ">", "fast")[1]).toBeCloseTo(0.4375);
    expect(fanWeights(5, "/", "slow")[0]).toBeCloseTo(-1);
    expect(fanWeights(5, "/", "slow")[1]).toBeCloseTo(-0.25);
  });

  it("写入编程器：强度夹在 0~100，属性跳过不支持的灯（但占位），色相保留饱和度与明度", () => {
    const ids = ["a", "b", "c"];
    let v = programFan({}, ids, "intensity", 20, 80, "/");
    // “/”：中间一台为 A，最后一台为 B，第一台是 2A − B = −40，夹到 0
    expect(ids.map((id) => v[id].intensity)).toEqual([fixed(0), fixed(20), fixed(80)]);

    v = programFan({}, ids, "pan", 0, 1, ">", "linear", (id) => id !== "b");
    expect(v.a.attrs?.pan).toEqual(fixed(0));
    expect(v.b).toBeUndefined();
    expect(v.c.attrs?.pan).toEqual(fixed(1));

    v = { a: { color: fixed({ kind: "rgb", rgb: [128, 0, 0], white: "off" }) } };
    v = programFan(v, ["a", "b"], "hue", 120, 240, ">");
    expect(v.a.color).toEqual(fixed({ kind: "rgb", rgb: [0, 128, 0], white: "off" }));
    expect(v.b.color).toEqual(fixed({ kind: "rgb", rgb: [0, 0, 255] }));
  });
});

describe("高亮（Highlight）", () => {
  it("满亮白光；标注了高亮值的属性写高亮值（反向通道换算）；像素只看自己的通道", () => {
    const model = {
      ...HEAD16,
      id: "hl",
      properties: [
        ...HEAD16.properties,
        { ...prop("Zoom", "zoom", 7), highlightValue: 51 },
        { ...prop("Frost", "frost", 8), highlightValue: 255, invert: true },
      ],
    };
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, model, 1);
      addFixtures(d, PIXEL_BAR, 1);
    });
    const [mover, bar] = p.fixtures.map((f) => f.id);
    expect(highlightLook(p, mover)).toEqual({
      intensity: fixed(100),
      color: fixed({ kind: "rgb", rgb: [255, 255, 255] }),
      attrs: { zoom: fixed(0.2), frost: fixed(0) },
    });
    expect(highlightLook(p, `${bar}#2`)).toEqual({ intensity: fixed(100), color: fixed({ kind: "rgb", rgb: [255, 255, 255] }) });
    expect(highlightLook(p, "nope")).toBeNull();
  });

  it("叠在编程器之后：颜色胜过编程器，没选灯时原样返回", () => {
    const p = rig();
    const [a, b] = p.fixtures.map((f) => f.id);
    expect(withHighlight(p, [])).toBe(p);
    const red = { [a]: { intensity: fixed(100), color: fixed({ kind: "rgb" as const, rgb: [255, 0, 0] as [number, number, number] }) } };
    const composed = withHighlight(withProgrammer(p, red), [a, b]);
    const colors = createPreviewEvaluator(composed, engine)(1000);
    expect(colors.get(a)).toEqual([255, 255, 255]);
    expect(colors.get(b)).toEqual([255, 255, 255]);
    expect(colors.get(p.fixtures[2].id)).toEqual([0, 0, 0]);
  });
});

describe("记录设置", () => {
  it("按拍换算长度（需要节拍），否则用毫秒；范围夹紧", () => {
    expect(recordLengthMs(DEFAULT_RECORD_PREFS, null)).toBe(2000);
    expect(recordLengthMs({ ...DEFAULT_RECORD_PREFS, unit: "beats", beats: 4 }, { bpm: 120 })).toBe(2000);
    expect(recordLengthMs({ ...DEFAULT_RECORD_PREFS, unit: "beats", beats: 4 }, null)).toBe(2000);
    expect(recordLengthMs({ ...DEFAULT_RECORD_PREFS, lengthMs: 5 }, null)).toBe(100);
  });

  it("读回时逐字段兜底", () => {
    expect(sanitizeRecordPrefs({ lengthMs: "x", unit: "bars", beats: 9999, fadeInMs: -3 }, DEFAULT_RECORD_PREFS)).toEqual({
      lengthMs: 2000,
      unit: "ms",
      beats: 1024,
      fadeInMs: 0,
    });
    expect(sanitizeRecordPrefs(null, DEFAULT_RECORD_PREFS)).toEqual(DEFAULT_RECORD_PREFS);
  });

  it("记录时带淡入，淡入不超过片段长度", () => {
    const p = rig();
    const v = programIntensity({}, [p.fixtures[0].id], 80);
    let id = "";
    const next = produce(p, (d) => {
      id = recordScene(d, v, 0, 1000, "场景", { fadeInMs: 5000 }).cueIds[0];
    });
    expect(next.cues.find((c) => c.id === id)?.fadeInMs).toBe(1000);
  });
});

describe("更新到所选片段（Update）", () => {
  it("外观片段合并 / 覆盖；场景片段按条目合并或换掉；锁定轨道跳过", () => {
    let look = "";
    let locked = "";
    let scene = "";
    const p = produce(rig(), (d) => {
      look = addLookCue(d, d.tracks[0].id, 0, { intensity: fixed(50), attrs: { pan: fixed(0.5) } }, 2000) ?? "";
      locked = addLookCue(d, d.tracks[1].id, 0, { intensity: fixed(50) }, 2000) ?? "";
      d.tracks[1].lock = true;
      scene = recordScene(d, programIntensity({}, [d.fixtures[2].id], 30), 0, 2000, "场景").cueIds[0];
    });
    const [a, b, c, e] = p.fixtures.map((f) => f.id);
    const values = {
      [a]: { color: fixed({ kind: "rgb" as const, rgb: [0, 0, 255] as [number, number, number] }) },
      [b]: { intensity: fixed(90) },
      [e]: { intensity: fixed(60) },
    };
    const members = (q: ShowProject) => (t: ShowProject["tracks"][number]) => trackFixtureIds(q, t);

    let n = 0;
    const merged = produce(p, (d) => {
      n = updateCuesFromProgrammer(d, values, [look, locked, scene], "merge", members(d));
    });
    expect(n).toBe(2);
    const lookCue = merged.cues.find((x) => x.id === look);
    expect(lookCue?.kind === "look" && lookCue.look).toEqual({
      intensity: fixed(50),
      attrs: { pan: fixed(0.5) },
      color: fixed({ kind: "rgb", rgb: [0, 0, 255] }),
    });
    expect(merged.cues.find((x) => x.id === locked)).toEqual(p.cues.find((x) => x.id === locked));
    const sceneCue = merged.cues.find((x) => x.id === scene);
    expect(sceneCue?.kind === "scene" && sceneCue.entries.map((x) => x.fixtureId)).toEqual([c, a, b, e]);

    const replaced = produce(p, (d) => {
      updateCuesFromProgrammer(d, values, [look, scene], "replace", members(d));
    });
    const lookR = replaced.cues.find((x) => x.id === look);
    expect(lookR?.kind === "look" && lookR.look).toEqual({ color: fixed({ kind: "rgb", rgb: [0, 0, 255] }) });
    const sceneR = replaced.cues.find((x) => x.id === scene);
    expect(sceneR?.kind === "scene" && sceneR.entries.map((x) => x.fixtureId)).toEqual([a, b, e]);
  });
});

describe("编程器撤销", () => {
  it("设值、清空都可以撤销 / 重做；上限 100 步；重置清掉历史", () => {
    const s = () => useProgrammerStore.getState();
    s().reset();
    s().setValues({ a: { intensity: fixed(10) } });
    s().setValues({ a: { intensity: fixed(20) } });
    s().clear();
    expect(s().values).toEqual({});
    s().undo();
    expect(s().values).toEqual({ a: { intensity: fixed(20) } });
    s().undo();
    expect(s().values).toEqual({ a: { intensity: fixed(10) } });
    s().redo();
    expect(s().values).toEqual({ a: { intensity: fixed(20) } });
    // 新的修改清掉重做栈
    s().setValues({ b: { intensity: fixed(5) } });
    expect(s().future).toEqual([]);

    for (let i = 0; i < PROGRAMMER_HISTORY_LIMIT + 20; i += 1) s().setValues({ x: { intensity: fixed(i) } });
    expect(s().past).toHaveLength(PROGRAMMER_HISTORY_LIMIT);
    s().reset();
    expect([s().past.length, s().future.length, s().highlight, s().live]).toEqual([0, 0, false, false]);
  });
});
