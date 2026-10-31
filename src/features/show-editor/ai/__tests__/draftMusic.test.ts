import { produce } from "immer";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { LoadedModel } from "@/features/ai";
import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { mapAnalysis } from "../../lib/mediaAnalysis";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { testAnalysis } from "../../lib/__tests__/analysisKit";
import { RGBW } from "../../lib/__tests__/testkit";
import { buildAliases } from "../aliases";
import { planOps } from "../compile";
import { draftAccentOps, draftSpans, spansText, withAnalysedEnergy } from "../draft";
import type { EditorSnapshot } from "../env";
import { draftPlanSchema } from "../opsSchema";
import { runDraft } from "../runtime";

vi.mock("@/features/ai", () => ({}));

const analysis = mapAnalysis({
  media: { id: "m", name: "song.mp3" },
  clip: null,
  audio: testAnalysis(),
  tags: { roles: { "16000": "chorus" } },
});
const bare: ShowProject = produce(createEmptyProject("t"), (d) => {
  addFixtures(d, RGBW, 4);
  d.durationMs = 64_000;
  d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
});

const snapshot = (p: ShowProject = bare): EditorSnapshot => ({
  project: p,
  aliases: buildAliases(p),
  env: { effects: BUILTIN_EFFECTS, templates: BUILTIN_TEMPLATES, libraryModels: [], lang: "zh", playheadMs: 0, selection: [], analysis },
  summary: { playheadMs: 0, selection: [], analysis },
});

describe("按音乐分析生成草稿", () => {
  it("工程没有段落时按分析出的段落切分，名字取角色或结构标签", () => {
    const spans = draftSpans(bare, buildAliases(bare), "zh", analysis);
    expect(spans.map((s) => [s.alias, s.name, s.from, s.to, s.virtual])).toEqual([
      ["S1", "段落 A 1", "start", "16s", true],
      ["S2", "副歌", "16s", "48s", true],
      ["S3", "段落 A 2", "48s", "end", true],
    ]);
    // 没有分析时仍按 8 小节切
    expect(draftSpans(bare, buildAliases(bare), "zh")).toHaveLength(4);
  });

  it("段落表带上分析出的能量与标签；计划的能量以分析为准；节奏重音只放有事件的地方", () => {
    const spans = draftSpans(bare, buildAliases(bare), "zh", analysis);
    const text = spansText(spans, bare, analysis);
    expect(text).toContain('S2 "副歌" 0:16.0 (b9) → 0:48.0 (b25) (proposed) analysed energy high (9/9), density 6/9, label B, role chorus');
    const plan = draftPlanSchema.parse({
      summary: "s",
      palette: "warm",
      items: spans.map((s) => ({ section: s.alias, energy: "mid", light: "breathe", colors: null, period: null, move: null })),
    });
    expect(withAnalysedEnergy(plan, spans, analysis).items.map((i) => i.energy)).toEqual(["low", "high", "low"]);
    const accents = draftAccentOps(spans, analysis, bare);
    expect(accents.map((o) => (o.op === "placeAccents" ? [o.events, o.from, o.to] : null))).toEqual([
      ["builds", "start", "end"],
      ["drops", "start", "end"],
      ["hits", "16s", "48s"],
    ]);
    expect(draftAccentOps(spans, null, bare)).toEqual([]);
  });

  it("草稿请求带上分析，打开节奏重音时结果里有重音层；能应用", async () => {
    const plan = {
      summary: "s",
      palette: "warm",
      items: [
        { section: "S1", energy: "mid", light: "balladBed", colors: null, period: null, move: null },
        { section: "S2", energy: "mid", light: "chorusBurst", colors: null, period: null, move: null },
        { section: "S3", energy: "mid", light: "finaleFade", colors: null, period: null, move: null },
      ],
    };
    const text = (t: string) => ({
      content: [{ type: "text" as const, text: t }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    });
    const model = new MockLanguageModelV4({ doGenerate: [text(JSON.stringify(plan))] });
    const loaded = { model, settings: { temperature: 0 }, profile: { id: "p" } } as unknown as LoadedModel;
    const s = snapshot();
    const r = await runDraft({ loaded, snapshot: s, prompt: "", palette: null, accents: true });
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain("analysed energy high (9/9)");
    expect(r.plan.items.map((i) => i.energy)).toEqual(["low", "high", "low"]);
    expect(r.ops.ops.filter((o) => o.op === "placeAccents")).toHaveLength(3);
    const applied = planOps(s.project, r.ops.ops, s.env, s.aliases);
    expect(applied.failed).toBe(false);
    expect(applied.next.tracks.some((t) => t.role === "accent")).toBe(true);
    expect(applied.next.sections.map((x) => x.name)).toEqual(["段落 A 1", "副歌", "段落 A 2"]);
  });
});
