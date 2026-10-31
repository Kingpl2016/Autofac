import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { createPreviewEvaluator } from "../../lib/color";
import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { mapAnalysis, type TimelineAnalysis } from "../../lib/mediaAnalysis";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type LookClip, type ShowProject } from "../../lib/project";
import { projectSchema } from "../../lib/schema";
import { testAnalysis } from "../../lib/__tests__/analysisKit";
import { RGBW } from "../../lib/__tests__/testkit";
import { buildAliases } from "../aliases";
import { planOps, type CompileEnv } from "../compile";
import { aiOpsSchema } from "../opsSchema";

const analysis = mapAnalysis({ media: { id: "m", name: "song.mp3" }, clip: null, audio: testAnalysis() });
const env = (a: TimelineAnalysis | null = analysis): CompileEnv => ({
  effects: BUILTIN_EFFECTS,
  templates: BUILTIN_TEMPLATES,
  libraryModels: [],
  lang: "zh",
  playheadMs: 0,
  selection: [],
  analysis: a,
});

/** 4 台 RGBW，120 BPM，两个段落：主歌 0~16 秒、副歌 16~48 秒。 */
const show = (): ShowProject =>
  produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 4);
    d.output.gamma = 1;
    d.durationMs = 64_000;
    d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    d.sections = [
      { id: "s1", name: "主歌", startMs: 0, endMs: 16_000, color: [60, 180, 140] },
      { id: "s2", name: "副歌", startMs: 16_000, endMs: 48_000, color: [235, 90, 70] },
    ];
  });

const run = (p: ShowProject, ops: unknown[], e = env()) => planOps(p, aiOpsSchema.parse({ summary: "", ops }).ops, e, buildAliases(p));
const accentTrack = (p: ShowProject) => p.tracks.find((t) => t.role === "accent");
const onAccent = (p: ShowProject) => p.cues.filter((c) => c.trackId === accentTrack(p)?.id).sort((a, b) => a.startMs - b.startMs);

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

describe("placeAccents", () => {
  it("冲击放在每个重拍上，在主轨道下面的重音层里；只加强度，颜色仍是下面的片段的", () => {
    const base = [{ op: "addLook", target: "all", from: "S2", to: "S2:end", color: "blue", intensity: 30 }];
    const r = run(show(), [...base, { op: "placeAccents", events: "hits", target: "all", from: "S2", to: "S2:end" }]);
    expect(r.issues).toEqual([]);
    const tracks = r.next.tracks;
    const main = tracks.findIndex((t) => t.target.kind === "group" && !t.role);
    expect(tracks[main + 1]).toMatchObject({ role: "accent", target: tracks[main].target });
    const hits = onAccent(r.next);
    expect(hits.map((c) => c.startMs)).toEqual(Array.from({ length: 16 }, (_, i) => 16_000 + i * 2000));
    expect(hits.every((c) => c.endMs - c.startMs === 2000 && (c as LookClip).fx?.def.id === "hit")).toBe(true);
    expect(hits.every((c) => c.kind === "look" && !c.look.color)).toBe(true);
    expect(projectSchema.safeParse(r.next).success).toBe(true);

    // 引擎求值：重拍刚开始时满亮，随后衰减回 30%；颜色一直是蓝色
    const evaluate = createPreviewEvaluator(r.next, engine);
    const [first] = r.next.fixtures;
    const atHit = evaluate(16_050).get(first.id)!;
    const later = evaluate(17_900).get(first.id)!;
    expect(atHit[0]).toBe(0);
    expect(atHit[1]).toBe(0);
    expect(atHit[2]).toBeGreaterThan(200);
    expect(later[2]).toBeLessThan(atHit[2]);
    expect(later[2]).toBeGreaterThanOrEqual(70);
    expect(later[0] + later[1]).toBe(0);
  });

  it("每隔几个取一个；重复放置时先清掉重音层上这段原有的片段；结果确定", () => {
    const op = { op: "placeAccents", events: "hits", target: "all", from: "S2", to: "S2:end", every: "2" };
    const once = run(show(), [op]);
    expect(onAccent(once.next)).toHaveLength(8);
    const twice = run(once.next, [op]);
    expect(onAccent(twice.next)).toHaveLength(8);
    expect(twice.next.tracks.filter((t) => t.role === "accent")).toHaveLength(1);
    const shape = (p: ShowProject) => onAccent(p).map((c) => [c.startMs, c.endMs, c.brightness]);
    expect(shape(run(show(), [op]).next)).toEqual(shape(once.next));
  });

  it("渐强铺满渐强的区间；爆点只冲一次；亮度档位", () => {
    const r = run(show(), [
      { op: "placeAccents", events: "builds", target: "all", from: "start", to: "end" },
    ]);
    expect(onAccent(r.next).map((c) => [c.startMs, c.endMs, (c as LookClip).fx?.def.id])).toEqual([[8000, 16_000, "fadeIn"]]);
    const drop = run(show(), [{ op: "placeAccents", events: "drops", target: "all", from: "start", to: "end", strength: "subtle" }]);
    expect(onAccent(drop.next).map((c) => [c.startMs, c.endMs, c.brightness])).toEqual([[16_000, 18_000, 50]]);
  });

  it("切镜换色：按给的颜色轮流，或按画面主色；没有切镜或没有画面时报错", () => {
    const withVideo = mapAnalysis({
      media: { id: "m", name: "mv.mp4" },
      clip: null,
      audio: testAnalysis(),
      video: {
        cuts: [{ atMs: 4000, strength: 1 }, { atMs: 9000, strength: 1 }],
        shots: [
          { startMs: 0, endMs: 4000, rgb: [10, 10, 10], brightness: 0.1 },
          { startMs: 4000, endMs: 9000, rgb: [250, 20, 20], brightness: 0.6 },
          { startMs: 9000, endMs: 64_000, rgb: [20, 20, 250], brightness: 0.6 },
        ],
      },
    });
    const given = run(show(), [{ op: "placeAccents", events: "cuts", target: "all", from: "S1", to: "S1:end", colors: ["red", "cyan"] }], env(withVideo));
    expect(given.issues).toEqual([]);
    const clips = onAccent(given.next) as LookClip[];
    expect(clips.map((c) => [c.startMs, c.endMs])).toEqual([[4000, 9000], [9000, 16_000]]);
    expect(clips.map((c) => c.look.color)).toEqual([
      { kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } },
      { kind: "value", value: { kind: "rgb", rgb: [0, 255, 255] } },
    ]);
    const video = run(show(), [{ op: "placeAccents", events: "cuts", target: "all", from: "S1", to: "S1:end", fromVideo: true }], env(withVideo));
    const rgb = (onAccent(video.next) as LookClip[]).map((c) => (c.look.color?.kind === "value" && c.look.color.value.kind === "rgb" ? c.look.color.value.rgb : null));
    expect(rgb[0]![0]).toBeGreaterThan(200);
    expect(rgb[1]![2]).toBeGreaterThan(200);

    expect(run(show(), [{ op: "placeAccents", events: "cuts", target: "all", from: "S1", to: "S1:end", colors: ["red"] }]).issues[0].message).toContain("no video cuts");
    expect(run(show(), [{ op: "placeAccents", events: "cuts", target: "all", from: "S1", to: "S1:end" }], env(withVideo)).issues[0].message).toContain("give colors");
  });

  it("没有分析、范围里没有事件时把原因回传给模型", () => {
    expect(run(show(), [{ op: "placeAccents", events: "hits", target: "all", from: "S2", to: "S2:end" }], env(null)).issues[0]).toMatchObject({
      level: "error",
      message: expect.stringContaining("no music analysis"),
    });
    expect(run(show(), [{ op: "placeAccents", events: "hits", target: "all", from: "S1", to: "S1:end" }]).issues[0].message).toContain("no hits in that range");
  });

  it("普通片段仍放在主轨道上，不会落到重音层", () => {
    const r = run(show(), [
      { op: "placeAccents", events: "hits", target: "all", from: "S2", to: "S2:end" },
      { op: "addEffect", target: "all", from: "S1", to: "S1:end", effect: "breathe" },
    ]);
    const breathe = r.next.cues.find((c) => (c as LookClip).fx?.def.id === "breathe")!;
    expect(r.next.tracks.find((t) => t.id === breathe.trackId)?.role).toBeUndefined();
  });
});
