import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { mapAnalysis } from "../../lib/mediaAnalysis";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { testAnalysis } from "../../lib/__tests__/analysisKit";
import { RGBW } from "../../lib/__tests__/testkit";
import { buildAliases } from "../aliases";
import { summarizeProject } from "../context";
import { analysisDetail, musicLines } from "../music";

const project = produce(createEmptyProject("t"), (d) => {
  addFixtures(d, RGBW, 4);
  d.durationMs = 64_000;
  d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
  d.sections = [
    { id: "s1", name: "主歌", startMs: 0, endMs: 16_000, color: [60, 180, 140] },
    { id: "s2", name: "副歌", startMs: 16_000, endMs: 48_000, color: [60, 180, 140] },
  ];
});
const analysis = mapAnalysis({ media: { id: "m", name: "song.mp3" }, clip: null, audio: testAnalysis() });

describe("给模型看的音乐分析", () => {
  it("按工程段落逐行列出特征与标签；事件给数量与位置；结果确定", () => {
    const aliases = buildAliases(project);
    const lines = musicLines(project, aliases, analysis);
    expect(lines[0]).toContain("120 BPM, beat confidence 90%");
    // S1 含 4 小节渐强（0.2~0.5），平均能量 0.21 → 2
    expect(lines[1]).toBe("  S1 energy low(2) bright 3 bass 2 density 2 label A");
    expect(lines[2]).toBe("  S2 energy high(9) bright 7 bass 8 density 6 label B");
    expect(lines).toContain("  builds (1): 0:08.0 (b5)→0:16.0 (b9)");
    expect(lines).toContain("  drops (1): 0:16.0 (b9)");
    expect(lines.some((l) => l.startsWith("  hits (16): 0:16.0 (b9), 0:18.0 (b10)") && l.endsWith("… 4 more"))).toBe(true);
    expect(musicLines(project, aliases, analysis)).toEqual(lines);
    expect(musicLines(project, aliases, null)).toEqual([]);
  });

  it("工程没有段落时列出分析出的段落；摘要里出现 Music 一节", () => {
    const bare = produce(project, (d) => void (d.sections = []));
    const lines = musicLines(bare, buildAliases(bare), analysis);
    expect(lines[1]).toBe("  (the show has no sections; analysed parts:)");
    expect(lines[2]).toBe("  0:00.0 (b1) → 0:16.0 (b9) energy low(2) bright 3 bass 2 density 2 label A");
    const summary = summarizeProject(project, buildAliases(project), { playheadMs: 0, selection: [], analysis });
    expect(summary).toContain("Music analysis of the main media");
    expect(summarizeProject(project, buildAliases(project), { playheadMs: 0, selection: [] })).not.toContain("Music analysis");
  });

  it("范围内逐小节的特征与事件", () => {
    const text = analysisDetail(project, analysis, { startMs: 14_000, endMs: 18_000 });
    expect(text.split("\n").slice(1, 3)).toEqual(["  0:14.0 (b8) e5 b3 l2 d2 -18dB", "  0:16.0 (b9) e9 b7 l8 d6 -6dB"]);
    expect(text).toContain("drops (1): 0:16.0 (b9)");
    expect(analysisDetail(project, null, { startMs: 0, endMs: 1 })).toContain("No music analysis");
  });
});
