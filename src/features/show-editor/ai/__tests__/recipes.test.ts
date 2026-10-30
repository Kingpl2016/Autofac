import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { addFixtures, createGroup } from "../../lib/ops";
import { createEmptyProject, type LookClip, type ShowProject } from "../../lib/project";
import { DIMMER, HEAD16, RGBW } from "../../lib/__tests__/testkit";
import { buildAliases } from "../aliases";
import { planOps, type CompileEnv } from "../compile";
import { draftPlanToOps, draftSpans } from "../draft";
import { aiOpsSchema, draftPlanSchema } from "../opsSchema";
import { expandRecipe, isRecipeId, RECIPE_IDS, recipesVocab } from "../recipes";

const env: CompileEnv = { effects: BUILTIN_EFFECTS, templates: BUILTIN_TEMPLATES, libraryModels: [], lang: "zh", playheadMs: 0, selection: [] };

/** 4 台 RGBW + 2 台摇头灯（可选），120 BPM，两个段落。 */
function show(over: (d: ShowProject) => void = () => {}): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 4);
    addFixtures(d, HEAD16, 2);
    d.durationMs = 32_000;
    d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    d.sections = [
      { id: "s-verse", name: "主歌", startMs: 0, endMs: 16_000, color: [60, 180, 140] },
      { id: "s-chorus", name: "副歌", startMs: 16_000, endMs: 32_000, color: [235, 90, 70] },
    ];
    over(d);
  });
}

const parse = (ops: unknown[]) => aiOpsSchema.parse({ summary: "", ops }).ops;
const run = (p: ShowProject, ops: unknown[]) => planOps(p, parse(ops), env, buildAliases(p));
const fxOf = (p: ShowProject) => p.cues.map((c) => (c as LookClip).fx?.def.id);

describe("配方", () => {
  it("每个配方在有摇头灯、纯调光灯、没有节拍的工程里都能应用", () => {
    const shows = {
      mixed: show(),
      dimmer: produce(createEmptyProject("d"), (d) => {
        addFixtures(d, DIMMER, 4);
        d.durationMs = 20_000;
      }),
    };
    for (const id of RECIPE_IDS) {
      for (const [name, p] of Object.entries(shows)) {
        const r = run(p, [{ op: "applyRecipe", recipe: id, target: "all", from: "start", to: "16s", palette: "warm" }]);
        expect(r.issues.filter((i) => i.level === "error"), `${id} / ${name}`).toEqual([]);
        expect(r.next.cues.length, `${id} / ${name}`).toBeGreaterThan(0);
      }
    }
  });

  it("chorusBurst：灯光层用调色板的颜色，摇头灯加上扇形；同一段的结果完全确定", () => {
    const p = show();
    const ops = [{ op: "applyRecipe", recipe: "chorusBurst", target: "all", from: "S2", to: "S2:end", palette: "warm" }];
    const r = run(p, ops);
    expect(r.issues).toEqual([]);
    expect(fxOf(r.next)).toEqual(["colorChase", "fan"]);
    const light = r.next.cues[0] as LookClip;
    expect(light).toMatchObject({ startMs: 16_000, endMs: 32_000 });
    expect(light.fx?.params.period).toEqual({ kind: "beats", beats: 1 });
    // warm 的前三个颜色：orange、rose、amber
    expect(light.fx?.params.values?.colors).toEqual([[255, 96, 0], [255, 40, 90], [255, 150, 0]]);
    // 新建的 id（片段、分组轨道）每次不同，其余完全一致
    const shape = (q: ShowProject) => q.cues.map((c) => ({ ...c, id: "", trackId: "" }));
    expect(shape(run(p, ops).next)).toEqual(shape(r.next));
  });

  it("目标是分组时默认不动摇头灯，movers 为 true 时才加；没有摇头灯时给出警告", () => {
    const p = show((d) => void createGroup(d, "前排", d.fixtures.slice(0, 4).map((f) => f.id)));
    expect(fxOf(run(p, [{ op: "applyRecipe", recipe: "verseGroove", target: "G1", from: "S1", to: "S1:end" }]).next)).toEqual(["intensityWave"]);
    expect(fxOf(run(p, [{ op: "applyRecipe", recipe: "verseGroove", target: "G1", from: "S1", to: "S1:end", movers: true }]).next)).toEqual([
      "intensityWave",
      "circle",
    ]);
    const pars = produce(createEmptyProject("p"), (d) => {
      addFixtures(d, RGBW, 4);
      d.durationMs = 10_000;
    });
    const r = run(pars, [{ op: "applyRecipe", recipe: "dropHit", target: "all", from: "start", to: "end", movers: true }]);
    expect(fxOf(r.next)).toEqual(["hit"]);
    expect(r.issues).toEqual([{ index: 0, level: "warning", message: "there are no moving heads; the recipe's movement was skipped" }]);
  });

  it("不能变色的目标改用强度特效、不带颜色", () => {
    expect(expandRecipe(parse([{ op: "applyRecipe", recipe: "chorusBurst", target: "all", from: "S1", to: "S1:end", colors: ["blue"] }])[0] as never, { canColor: false, withMovers: false })).toEqual([
      expect.objectContaining({ op: "addEffect", effect: "intensityChase", colors: null, period: "1", spread: "full", fadeIn: "short" }),
    ]);
  });

  it("配方里的错误带上配方名回传给模型", () => {
    const r = run(show(), [{ op: "applyRecipe", recipe: "balladBed", target: "all", from: "S2", to: "S1" }]);
    expect(r.issues[0]).toMatchObject({ level: "error", message: expect.stringContaining("recipe 'balladBed':") });
  });

  it("配方列表与 id 判断", () => {
    expect(recipesVocab().split("\n")).toHaveLength(RECIPE_IDS.length);
    expect(isRecipeId("chorusBurst")).toBe(true);
    expect(isRecipeId("toString")).toBe(false);
  });

  it("草稿的 light 可以是配方：展开成 applyRecipe，动作仍按 move", () => {
    const p = show();
    const aliases = buildAliases(p);
    const plan = draftPlanSchema.parse({
      summary: "s",
      palette: "cool",
      items: [
        { section: "S1", energy: "mid", light: "verseGroove", colors: null, period: null, move: null },
        { section: "S2", energy: "high", light: "chorusBurst", colors: ["blue", "violet"], period: null, move: "ballyhoo" },
      ],
    });
    const ops = draftPlanToOps(plan, draftSpans(p, aliases, "zh"), p, env);
    expect(ops.ops).toMatchObject([
      { op: "applyRecipe", recipe: "verseGroove", movers: false, colors: ["blue", "cyan"] },
      { op: "applyRecipe", recipe: "chorusBurst", movers: false, colors: ["blue", "violet"] },
      { op: "addEffect", target: "movers", effect: "ballyhoo" },
    ]);
    const r = planOps(p, ops.ops, env, aliases);
    expect(r.issues).toEqual([]);
    expect(fxOf(r.next)).toEqual(["intensityWave", "colorChase", "ballyhoo"]);
  });
});
