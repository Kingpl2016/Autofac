import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type LookClip, type ShowProject } from "../../lib/project";
import { HEAD16, RGBW } from "../../lib/__tests__/testkit";
import { buildAliases } from "../aliases";
import { listChanges } from "../changes";
import { planOps, type CompileEnv } from "../compile";
import { stageText } from "../context";
import { aiOpsSchema, type AiOp } from "../opsSchema";

const env = (over: Partial<CompileEnv> = {}): CompileEnv => ({
  effects: BUILTIN_EFFECTS,
  templates: BUILTIN_TEMPLATES,
  libraryModels: [RGBW, HEAD16],
  lang: "zh",
  playheadMs: 0,
  selection: [],
  ...over,
});

/** 4 台 RGBW + 2 台摇头灯，120 BPM，12×8 m 舞台。 */
function show(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 4);
    addFixtures(d, HEAD16, 2);
    d.durationMs = 32_000;
    d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
  });
}

const parse = (ops: unknown[]): AiOp[] => aiOpsSchema.parse({ summary: "", ops }).ops;
const run = (p: ShowProject, ops: unknown[], e = env()) => planOps(p, parse(ops), e, buildAliases(p), { effects: true });

describe("自定义特效 / 模板 / 灯具模型", () => {
  it("defineEffect 编译成可换色的特效，同一批里 addEffect 可以用；save 时写进库，否则只在片段里", () => {
    const p = show();
    const ops = [
      { op: "defineEffect", id: "ocean-wave", name: "海浪", period: "8", intensity: { shape: "sine", low: 20, high: 100 }, colors: ["blue", "cyan"], spread: "full" },
      { op: "addEffect", target: "all", from: "b1", to: "b5", effect: "ocean-wave" },
    ];
    const r = run(p, ops);
    expect(r.issues).toEqual([]);
    const cue = r.next.cues[0] as LookClip;
    expect(cue.fx?.def).toMatchObject({ id: "ocean-wave", name: "海浪", scale: "percent", spread: 1, look: { intensity: { shape: "sine", lo: 0.2, hi: 1 }, color: { colors: "$colors" } } });
    expect(r.library.effects).toEqual([]);
    expect(r.sensitive).toBe(false);
    // 拒绝定义会连带拒绝用它的操作
    expect(r.effects?.[1].deps).toEqual([0]);

    const saved = run(p, [{ ...ops[0], save: true }, ops[1]]);
    expect(saved.library.effects.map((e) => e.id)).toEqual(["ocean-wave"]);
    expect(saved.sensitive).toBe(true);
    expect(listChanges(p, saved.next, "zh", saved.library).some((c) => c.collection === "libEffects" && c.label === "海浪")).toBe(true);
  });

  it("defineEffect：动作用位置幅度；与内置 id 冲突、已存在且不替换时报错", () => {
    const p = show();
    const r = run(p, [
      { op: "defineEffect", id: "slow-nod", name: "点头", period: "4", tilt: { shape: "sine", center: 0.5 }, size: "small" },
      { op: "addEffect", target: "movers", from: "b1", to: "b3", effect: "slow-nod" },
    ]);
    expect(r.issues).toEqual([]);
    expect((r.next.cues[0] as LookClip).fx?.def).toMatchObject({ scale: "fraction", look: { attrs: { tilt: { shape: "sine", center: 0.5, amp: 1 } } } });
    expect(run(p, [{ op: "defineEffect", id: "breathe", name: "x", period: "4" }]).issues[0].message).toMatch(/built-in/);
    const mine = { ...BUILTIN_EFFECTS[0], id: "mine", builtin: false };
    const e = env({ effects: [...BUILTIN_EFFECTS, mine] });
    expect(run(p, [{ op: "defineEffect", id: "mine", name: "x", period: "4" }], e).issues[0].message).toMatch(/already has/);
    const replaced = run(p, [{ op: "defineEffect", id: "mine", name: "x", period: "4", save: true }], e);
    expect(replaced.failed).toBe(false);
    expect(replaced.issues[0]).toMatchObject({ level: "warning" });
  });

  it("saveTemplate 把刚放的片段存成模板，同一批里可以再放", () => {
    const p = show();
    const r = run(p, [
      { op: "addEffect", target: "all", from: "b1", to: "b3", effect: "rainbow" },
      { op: "saveTemplate", clip: "last", name: "我的彩虹" },
      { op: "applyTemplate", target: "all", from: "b3", to: "b5", template: "ai-1" },
    ]);
    expect(r.issues).toEqual([]);
    expect(r.library.templates).toHaveLength(1);
    expect(r.library.templates[0]).toMatchObject({ id: "ai-1", name: "我的彩虹", group: "custom", kind: "effect" });
    expect(r.next.cues).toHaveLength(2);
    expect(r.effects?.[1].deps).toEqual([0]);
    expect(run(p, [{ op: "saveTemplate", clip: "last", name: "x" }]).issues[0].message).toMatch(/no clip/);
  });

  it("defineFixtureModel 按通道顺序建模型（16 位占两个通道），addFixtures 用它；是敏感改动并写进灯具库", () => {
    const p = show();
    const r = run(p, [
      {
        op: "defineFixtureModel",
        as: "new_spot",
        name: "Mini Spot",
        channels: [{ function: "pan", fine: true }, { function: "tilt", fine: true }, { function: "dimmer" }, { function: "red" }, { function: "green" }, { function: "blue" }],
        panRange: 540,
      },
      { op: "addFixtures", model: "new_spot", count: 2, as: "new_spots" },
      { op: "placeFixtures", fixtures: ["new_spots"], layout: "line", x: 0, y: 6, width: 4, z: 5, hanging: true },
    ]);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.sensitive).toBe(true);
    const model = r.library.models[0];
    expect(model.properties.map((x) => [x.function, x.channel, x.width])).toEqual([
      ["pan", 1, 2],
      ["tilt", 3, 2],
      ["dimmer", 5, 1],
      ["red", 6, 1],
      ["green", 7, 1],
      ["blue", 8, 1],
    ]);
    expect(model.physical?.panRangeDeg).toBe(540);
    const added = r.next.fixtures.slice(-2);
    expect(added.map((f) => f.stage)).toEqual([
      { x: -2, y: 6, z: 5, hanging: true },
      { x: 2, y: 6, z: 5, hanging: true },
    ]);
  });
});

describe("舞台布置", () => {
  it("placeFixtures 排成直线 / 弧线 / 圆，夹在舞台范围内；只改摆位时清单列为“摆位”", () => {
    const p = show();
    const line = run(p, [{ op: "placeFixtures", fixtures: ["F1", "F2", "F3", "F4"], layout: "line", x: 0, y: 1, width: 6, rotation: 0, z: 4 }]);
    expect(line.issues).toEqual([]);
    expect(line.next.fixtures.slice(0, 4).map((f) => [f.stage?.x, f.stage?.y, f.stage?.z])).toEqual([
      [-3, 1, 4],
      [-1, 1, 4],
      [1, 1, 4],
      [3, 1, 4],
    ]);
    const changes = listChanges(p, line.next, "zh");
    expect(changes.every((c) => c.collection === "placements")).toBe(true);
    // 摇头灯被固定在原来的自动位置上，看起来没动，不列出
    expect(changes).toHaveLength(4);

    const arc = run(p, [{ op: "placeFixtures", fixtures: ["all"], layout: "arc", x: 0, y: 6, width: 8, sweep: 90 }]);
    const ys = arc.next.fixtures.map((f) => f.stage!.y);
    // 两端朝观众（y 更小），中间靠后
    expect(ys[0]).toBeLessThan(Math.max(...ys));
    expect(ys[0]).toBeCloseTo(ys[ys.length - 1], 3);
    const wide = run(p, [{ op: "placeFixtures", fixtures: ["F1", "F2"], layout: "line", x: 0, y: 2, width: 60 }]);
    // 12 m 宽的舞台最多到 ±7 m（允许超出边缘一米）
    expect(wide.next.fixtures[0].stage?.x).toBe(-7);
  });

  it("setPlacement：一台给坐标，多台只能平移；setStage、布景物件增删", () => {
    const p = show();
    expect(run(p, [{ op: "setPlacement", fixtures: ["F1", "F2"], x: 1 }]).issues[0].message).toMatch(/one fixture/);
    const r = run(p, [
      { op: "setPlacement", fixtures: ["F1"], x: 2, y: 3, rotation: 45 },
      { op: "setStage", width: 16, depth: 10 },
      { op: "addStageObject", kind: "truss", x: 0, y: 6, width: 10, label: "后桁架" },
    ]);
    expect(r.issues).toEqual([]);
    expect(r.next.fixtures[0].stage).toMatchObject({ x: 2, y: 3, rotation: 45 });
    expect(r.next.stage).toMatchObject({ width: 16, depth: 10 });
    expect(r.next.stage.objects[0]).toMatchObject({ kind: "truss", x: 0, y: 6, w: 10, label: "后桁架" });
    const kinds = listChanges(p, r.next, "zh").map((c) => c.collection);
    expect(kinds).toEqual(expect.arrayContaining(["placements", "stage", "stageObjects"]));

    expect(stageText(r.next, buildAliases(r.next))).toMatch(/O1 truss "后桁架" x=0 y=6 10×0\.3 m/);
    const removed = run(r.next, [{ op: "removeStageObjects", objects: ["O1"] }]);
    expect(removed.next.stage.objects).toEqual([]);
    expect(run(r.next, [{ op: "removeStageObjects", objects: ["O9"] }]).issues[0].message).toMatch(/no set piece/);
  });

  it("get_stage 的文字：舞台尺寸、灯具位置（自动排布的标 auto）", () => {
    const p = show();
    const text = stageText(p, buildAliases(p));
    expect(text).toMatch(/^Stage 12 m wide × 8 m deep\./);
    expect(text).toMatch(/F1 ".+" x=-?\d+(\.\d+)? y=\d+(\.\d+)? auto/);
    expect(text).toContain("No set pieces.");
  });
});
