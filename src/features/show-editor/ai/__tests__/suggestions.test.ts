import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }),
}));

import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { mapAnalysis, type TimelineAnalysis } from "../../lib/mediaAnalysis";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject, type StaticCue } from "../../lib/project";
import { testAnalysis } from "../../lib/__tests__/analysisKit";
import { RGBW } from "../../lib/__tests__/testkit";
import { acceptSuggestion, planSuggestion } from "../../stores/useAiSuggestionStore";
import { useProjectStore } from "../../stores/useProjectStore";
import type { CompileEnv } from "../compile";
import { recipeForEnergy, suggestTimeline, visibleSuggestions } from "../suggestions";

const analysis = mapAnalysis({ media: { id: "m", name: "song.mp3" }, clip: null, audio: testAnalysis() })!;
const env = (a: TimelineAnalysis | null = analysis): CompileEnv => ({
  effects: BUILTIN_EFFECTS,
  templates: BUILTIN_TEMPLATES,
  libraryModels: [],
  lang: "zh",
  playheadMs: 0,
  selection: [],
  analysis: a,
});

/** 4 台 RGBW，64 秒，120 BPM。 */
const show = (edit: (d: ShowProject) => void = () => undefined): ShowProject =>
  produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 4);
    d.durationMs = 64_000;
    d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    edit(d);
  });

const staticCue = (trackId: string, id: string, startMs: number, endMs: number): StaticCue => ({
  id,
  kind: "static",
  trackId,
  startMs,
  endMs,
  brightness: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  easing: "linear",
  rgb: [255, 0, 0],
});

describe("主动建议", () => {
  it("空段落按能量建议配方；同样的输入总是同样的建议", () => {
    const p = show();
    const list = suggestTimeline(p, analysis, []);
    expect(list.map((s) => [s.rule, s.startMs, (s.ops[0] as { recipe?: string }).recipe])).toEqual([
      ["fillSection", 0, "balladBed"],
      ["fillSection", 16_000, "chorusBurst"],
      ["fillSection", 48_000, "balladBed"],
    ]);
    expect(suggestTimeline(p, analysis, [])).toEqual(list);
    expect(recipeForEnergy(0.5)).toBe("verseGroove");
    // 每条都能经编译器试运行
    for (const s of list) expect(planSuggestion(p, s, env())?.cues.length).toBeGreaterThan(0);
  });

  it("高能段落有冲击但没有重音：建议放重音（会新建重音轨道）；忽略过的不再出现", () => {
    const p = show((d) => {
      d.cues.push(staticCue(d.tracks[0].id, "c1", 16_000, 48_000));
    });
    const list = suggestTimeline(p, analysis, []);
    const accent = list.find((s) => s.rule === "accentHits")!;
    expect(accent).toMatchObject({ startMs: 16_000, endMs: 48_000, ops: [{ op: "placeAccents", events: "hits" }] });
    expect(list.some((s) => s.rule === "fillSection" && s.startMs === 16_000)).toBe(false);
    const plan = planSuggestion(p, accent, env())!;
    expect(plan.newTracks).toBeGreaterThanOrEqual(1);
    expect(plan.next.tracks.some((t) => t.role === "accent")).toBe(true);
    expect(plan.cues.length).toBeGreaterThanOrEqual(16);
    expect(suggestTimeline(p, analysis, [accent.id]).some((s) => s.id === accent.id)).toBe(false);
  });

  it("视频切换处没有变化：建议跟着换色", () => {
    const withVideo = mapAnalysis({
      media: { id: "m", name: "clip.mp4" },
      clip: null,
      audio: testAnalysis(),
      video: {
        cuts: [4000, 8000, 12_000].map((atMs) => ({ atMs, strength: 1 })),
        shots: [0, 4000, 8000, 12_000].map((startMs, i) => ({ startMs, endMs: startMs + 4000, rgb: [i * 60, 0, 255 - i * 60] as [number, number, number], brightness: 0.5 })),
      },
    })!;
    const p = show((d) => {
      d.cues.push(staticCue(d.tracks[0].id, "c1", 0, 16_000));
    });
    const cuts = suggestTimeline(p, withVideo, []).find((s) => s.rule === "colorCuts")!;
    expect(cuts).toMatchObject({ startMs: 4000, ops: [{ op: "placeAccents", events: "cuts", fromVideo: true }] });
    expect(planSuggestion(p, cuts, env(withVideo))).not.toBeNull();
    // 切换处已经有片段开始：不再建议
    const covered = produce(p, (d) => {
      for (const at of [4000, 8000, 12_000]) d.cues.push(staticCue(d.tracks[1].id, `k${at}`, at, at + 1000));
    });
    expect(suggestTimeline(covered, withVideo, []).some((s) => s.rule === "colorCuts")).toBe(false);
  });

  it("连续一样的片段：交替调暗（片段换成别名后经编译器执行）", () => {
    const p = show((d) => {
      const tr = d.tracks[0].id;
      d.cues.push(staticCue(tr, "a", 0, 2000), staticCue(tr, "b", 2000, 4000), staticCue(tr, "c", 4000, 6000), staticCue(tr, "d", 8000, 9000));
    });
    const vary = suggestTimeline(p, null, []);
    expect(vary).toHaveLength(1);
    expect(vary[0]).toMatchObject({ rule: "varyLooks", trackId: p.tracks[0].id, startMs: 0, endMs: 6000, ops: [{ op: "editCues", cues: ["b"], brightness: 60 }] });
    const plan = planSuggestion(p, vary[0], env(null))!;
    expect(plan.next.cues.find((c) => c.id === "b")?.brightness).toBe(60);
    expect(plan.next.cues.find((c) => c.id === "a")?.brightness).toBe(100);
  });

  it("画面上最多 3 条，离播放头近的优先", () => {
    const p = show();
    const many = [0, 10_000, 20_000, 30_000, 40_000].map((startMs) => ({ ...suggestTimeline(p, analysis, [])[0], id: `x${startMs}`, startMs, endMs: startMs + 5000 }));
    expect(visibleSuggestions(many, 0, 60_000, 41_000).map((s) => s.startMs)).toEqual([20_000, 30_000, 40_000]);
    expect(visibleSuggestions(many, 0, 12_000, 0).map((s) => s.startMs)).toEqual([0, 10_000]);
  });
});

describe("采纳建议", () => {
  beforeEach(() => {
    useProjectStore.getState().load(show());
  });

  it("一步写入、一步撤销", () => {
    const before = useProjectStore.getState().project;
    const s = suggestTimeline(before, analysis, [])[0];
    expect(acceptSuggestion(s)).toBe(true);
    expect(useProjectStore.getState().project.cues.length).toBeGreaterThan(0);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project.cues).toEqual(before.cues);
  });
});
