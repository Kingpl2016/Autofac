import { describe, expect, it } from "vitest";
import { produce } from "immer";

import type { BeatAnalysis } from "../mediaApi";
import { createEmptyProject } from "../project";
import {
  addSection,
  applyBeatPlan,
  energyTier,
  MIN_SECTION_MS,
  planFromAnalysis,
  removeSection,
  sectionAt,
  TIER_COLORS,
  updateSection,
} from "../sections";

const NAMES = { low: "安静段", mid: "主段", high: "高潮" };

const analysis = (over: Partial<BeatAnalysis> = {}): BeatAnalysis => ({
  bpm: 120,
  offsetMs: 300,
  beatsPerBar: 4,
  beatsMs: [300, 800, 1300],
  confidence: 0.9,
  durationMs: 60_000,
  sections: [
    { startMs: 0, endMs: 16_300, energy: 0.1 },
    { startMs: 16_300, endMs: 40_300, energy: 1 },
    { startMs: 40_300, endMs: 60_000, energy: 0.5 },
  ],
  ...over,
});

describe("段落", () => {
  it("新建：到下一个段落开头为止；落在已有段落里或太短时不建；按起点排序", () => {
    let a: string | null = null;
    let b: string | null = null;
    const p = produce(createEmptyProject("t"), (d) => {
      d.durationMs = 60_000;
      a = addSection(d, 10_000, 8000, "B");
      b = addSection(d, 4000, 8000, "A");
    });
    expect(a && b).toBeTruthy();
    expect(p.sections.map((s) => [s.name, s.startMs, s.endMs])).toEqual([
      ["A", 4000, 10_000],
      ["B", 10_000, 18_000],
    ]);
    expect(sectionAt(p, 12_000)?.name).toBe("B");
    expect(sectionAt(p, 30_000)).toBeUndefined();
    expect(produce(p, (d) => void addSection(d, 12_000, 8000, "x"))).toBe(p);
    expect(produce(p, (d) => void addSection(d, 10_000 - MIN_SECTION_MS / 2, 8000, "x")).sections).toHaveLength(2);
    const q = produce(p, (d) => {
      updateSection(d, p.sections[0].id, { name: "前奏" });
      removeSection(d, p.sections[1].id);
    });
    expect(q.sections.map((s) => s.name)).toEqual(["前奏"]);
  });

  it("能量分档", () => {
    expect([0, 0.33, 0.34, 0.66, 0.67, 1].map(energyTier)).toEqual(["low", "low", "mid", "mid", "high", "high"]);
  });

  it("分析结果换算到时间线：按片段位置平移，强拍偏移规整到一小节内，段落裁到片段范围并按档位命名", () => {
    // 片段从时间线 5 s 开始，素材入点 1 s → 素材内时刻 t 在时间线上是 t + 4 s
    const plan = planFromAnalysis(analysis(), { startMs: 5000, inMs: 1000, durationMs: 50_000 }, NAMES);
    expect(plan.tempo).toEqual({ bpm: 120, offsetMs: (300 + 4000) % 2000, beatsPerBar: 4 });
    expect(plan.sections.map((s) => [s.name, s.startMs, s.endMs])).toEqual([
      ["安静段 1", 5000, 20_300],
      ["高潮 1", 20_300, 44_300],
      ["主段 1", 44_300, 55_000],
    ]);
    expect(plan.sections[1].color).toEqual(TIER_COLORS.high);
    // 没有片段：素材从 0 点算
    const raw = planFromAnalysis(analysis(), null, NAMES);
    expect(raw.tempo.offsetMs).toBe(300);
    expect(raw.sections[0]).toMatchObject({ startMs: 0, endMs: 16_300 });
  });

  it("负方向平移时偏移仍落在一小节内", () => {
    const plan = planFromAnalysis(analysis({ offsetMs: 100 }), { startMs: 0, inMs: 1500, durationMs: 10_000 }, NAMES);
    expect(plan.tempo.offsetMs).toBe(600);
  });

  it("应用：只设速度，或连同段落一起替换（超出节目的裁掉）", () => {
    const base = produce(createEmptyProject("t"), (d) => {
      d.durationMs = 30_000;
      addSection(d, 0, 5000, "旧");
    });
    const plan = planFromAnalysis(analysis(), null, NAMES);
    const tempoOnly = produce(base, (d) => applyBeatPlan(d, plan, false));
    expect(tempoOnly.tempo).toEqual({ bpm: 120, offsetMs: 300, beatsPerBar: 4 });
    expect(tempoOnly.sections.map((s) => s.name)).toEqual(["旧"]);
    const all = produce(base, (d) => applyBeatPlan(d, plan, true));
    expect(all.sections.map((s) => [s.name, s.startMs, s.endMs])).toEqual([
      ["安静段 1", 0, 16_300],
      ["高潮 1", 16_300, 30_000],
    ]);
  });
});
