import { beforeAll, describe, expect, it } from "vitest";
import { produce } from "immer";

import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { unsafeFlash } from "../attrEffects";
import { applyDraft, DEFAULT_DRAFT, DRAFT_PALETTES, moverIds, planDraft } from "../autoDraft";
import { createPreviewEvaluator } from "../color";
import { addFixtures } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { parseProject } from "../schema";
import { TIER_COLORS } from "../sections";
import { HEAD16, RGBW } from "./testkit";

let engine: ReturnType<typeof loadTestEngine>;
beforeAll(() => {
  engine = loadTestEngine();
});

const NAMES = { all: "全部灯具", movers: "摇头灯" };

function base(over: (d: ShowProject) => void = () => {}): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 4);
    addFixtures(d, HEAD16, 2);
    d.durationMs = 64_000;
    d.output.gamma = 1;
    d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    over(d);
  });
}

describe("一键草稿", () => {
  it("没有节拍时不出计划", () => {
    expect(planDraft(base((d) => void (d.tempo = null)), DEFAULT_DRAFT)).toEqual([]);
  });

  it("按段落编排：档位来自段落颜色，同档位相邻段落交替方式，颜色依次取配色", () => {
    const p = base((d) => {
      d.sections = [
        { id: "a", name: "前奏", startMs: 0, endMs: 8000, color: [...TIER_COLORS.low] },
        { id: "b", name: "主歌", startMs: 8000, endMs: 24_000, color: [...TIER_COLORS.mid] },
        { id: "c", name: "副歌", startMs: 24_000, endMs: 40_000, color: [...TIER_COLORS.high] },
        { id: "d", name: "主歌 2", startMs: 40_000, endMs: 48_000, color: [...TIER_COLORS.mid] },
        { id: "e", name: "副歌 2", startMs: 48_000, endMs: 64_000, color: [...TIER_COLORS.high] },
      ];
    });
    const plan = planDraft(p, { ...DEFAULT_DRAFT, palette: "cool" });
    expect(plan.map((i) => [i.tier, i.light, i.move])).toEqual([
      ["low", "wash", "none"],
      ["mid", "wave", "sweep"],
      ["high", "chase", "circle"],
      ["mid", "chase", "sweep"],
      ["high", "rainbow", "circle"],
    ]);
    expect(plan.map((i) => i.color)).toEqual([...DRAFT_PALETTES.cool, DRAFT_PALETTES.cool[0]]);
    expect(planDraft(p, { ...DEFAULT_DRAFT, movement: false }).every((i) => i.move === "none")).toBe(true);
  });

  it("没有段落：按 8 小节（16 s）切分并按位置起伏", () => {
    const plan = planDraft(base(), DEFAULT_DRAFT);
    expect(plan.map((i) => [i.startMs, i.endMs])).toEqual([
      [0, 16_000],
      [16_000, 32_000],
      [32_000, 48_000],
      [48_000, 64_000],
    ]);
    expect(plan[0].tier).toBe("low");
    expect(plan.at(-1)?.tier).toBe("low");
    expect(plan.some((i) => i.tier === "high")).toBe(true);
  });

  it("写入：全部灯具分组（从左到右）+ 摇头灯分组，片段不重叠、频闪安全，工程合法且有实际输出", () => {
    const p = base((d) => {
      d.fixtures.forEach((f, i) => (f.stage = { x: 5 - i * 2, y: 4 }));
    });
    expect(moverIds(p)).toEqual(p.fixtures.slice(4).map((f) => f.id));
    const plan = planDraft(p, DEFAULT_DRAFT);
    let result: ReturnType<typeof applyDraft> = { cueIds: [], groupIds: [] };
    const q = produce(p, (d) => {
      result = applyDraft(d, plan, DEFAULT_DRAFT, NAMES);
    });
    expect(q.groups.map((g) => g.name)).toEqual(["全部灯具", "摇头灯"]);
    // 从左到右：x 最小的是最后一台
    expect(q.groups[0].fixtureIds).toEqual([...p.fixtures].reverse().map((f) => f.id));
    const moves = plan.filter((i) => i.move !== "none").length;
    expect(result.cueIds).toHaveLength(plan.length + moves);
    for (const id of result.cueIds) {
      const cue = q.cues.find((c) => c.id === id)!;
      expect(cue.kind).toBe("look");
      if (cue.kind === "look") expect(unsafeFlash(cue.look, cue.endMs - cue.startMs)).toBe(false);
    }
    // 动作片段只有位置层
    const moverTrack = q.tracks.find((t) => t.target.kind === "group" && t.target.id === q.groups[1].id)!;
    for (const c of q.cues.filter((x) => x.trackId === moverTrack.id)) {
      expect(c.kind === "look" && c.look.intensity).toBeUndefined();
    }
    expect(parseProject(JSON.stringify(q)).ok).toBe(true);
    const evaluate = createPreviewEvaluator(q, engine);
    // 开头是安静段的静态铺色：60% 亮度的配色第一色（淡入之后）
    const [r, g, b] = evaluate(4000).get(q.fixtures[0].id)!;
    expect(r).toBeGreaterThan(100);
    expect(g + b).toBeGreaterThan(0);
  });

  it("亮度上限作用于特效；只有一台灯时用它自己的轨道", () => {
    const one = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
      d.durationMs = 16_000;
      d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    });
    const opts = { ...DEFAULT_DRAFT, intensity: 50 };
    const q = produce(one, (d) => void applyDraft(d, planDraft(one, opts), opts, NAMES));
    expect(q.groups).toEqual([]);
    expect(q.cues).toHaveLength(1);
    expect(q.cues[0]).toMatchObject({ trackId: one.tracks[0].id });
    // 只有一段（中等能量）：波浪，强度曲线上限 = 亮度上限
    expect(q.cues[0].kind === "look" && q.cues[0].look.intensity).toMatchObject({ kind: "curve", curve: { shape: "sine", to: 50 } });
  });
});
