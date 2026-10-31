import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { mapAnalysis } from "../../lib/mediaAnalysis";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { testAnalysis } from "../../lib/__tests__/analysisKit";
import { RGBW } from "../../lib/__tests__/testkit";
import { quickPrompts, scopeNote, scopeOf, scopeRange } from "../askScope";

const analysis = mapAnalysis({ media: { id: "m", name: "song.mp3" }, clip: null, audio: testAnalysis() });

/** 2 台 RGBW，两个段落：主歌 0~16 秒、副歌 16~48 秒，一个片段在副歌里。 */
const show = (): ShowProject =>
  produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    d.durationMs = 64_000;
    d.sections = [
      { id: "s1", name: "主歌", startMs: 0, endMs: 16_000, color: [60, 180, 140] },
      { id: "s2", name: "副歌", startMs: 16_000, endMs: 48_000, color: [235, 90, 70] },
    ];
    d.cues.push({ id: "c1", kind: "static", trackId: d.tracks[0].id, startMs: 20_000, endMs: 24_000, fadeInMs: 0, fadeOutMs: 0, values: {} } as never);
  });

const ui = { selectedCueIds: [] as string[], timeRange: null, playheadMs: 3000 };
const keys = (list: { key: string }[]) => list.map((p) => p.key.replace("editor.askAi.quick.", ""));

describe("问 AI 的范围", () => {
  it("右键目标 → 范围：片段沿用多选，空白处带轨道，标尺取时刻", () => {
    expect(scopeOf({ kind: "cue", id: "c1" }, ui)).toEqual({ kind: "clips", ids: ["c1"] });
    expect(scopeOf({ kind: "cue", id: "c1" }, { ...ui, selectedCueIds: ["c0", "c1"] })).toEqual({ kind: "clips", ids: ["c0", "c1"] });
    expect(scopeOf({ kind: "empty", trackId: "t1", timeMs: 500 }, ui)).toEqual({ kind: "point", timeMs: 500, trackId: "t1" });
    expect(scopeOf({ kind: "range", timeMs: 1 }, { ...ui, timeRange: { startMs: 0, endMs: 4000 } } as never)).toEqual({ kind: "range", startMs: 0, endMs: 4000 });
    expect(scopeOf({ kind: "section", id: "s2" }, ui)).toEqual({ kind: "section", id: "s2" });
  });

  it("范围的时间区间与说明", () => {
    const p = show();
    expect(scopeRange({ kind: "section", id: "s2" }, p)).toEqual({ startMs: 16_000, endMs: 48_000 });
    expect(scopeRange({ kind: "clips", ids: ["c1"] }, p)).toEqual({ startMs: 20_000, endMs: 24_000 });
    expect(scopeRange({ kind: "track", id: p.tracks[0].id }, p)).toBeNull();
    expect(scopeNote({ kind: "section", id: "s2" }, p)).toMatchObject({ key: "editor.askAi.scope.section", args: { name: "副歌" } });
    expect(scopeNote({ kind: "clips", ids: ["c1"] }, p)).toEqual({ key: "editor.askAi.scope.clips", args: { count: 1 } });
    expect(scopeNote({ kind: "point", timeMs: 0, trackId: null }, p).key).toBe("editor.askAi.scope.point");
  });

  it("快捷建议按范围与音乐事件给出，同样的位置总是同样的建议", () => {
    const p = show();
    // 副歌里有爆点与冲击，标签可信
    expect(keys(quickPrompts({ kind: "section", id: "s2" }, p, analysis))).toEqual(["byMusic", "addHits", "sameAsLabel"]);
    // 没有分析：只有通用建议
    expect(keys(quickPrompts({ kind: "section", id: "s2" }, p, null))).toEqual(["fillSection"]);
    // 片段在冲击上：多一条“跟着节拍走”
    expect(keys(quickPrompts({ kind: "clips", ids: ["c1"] }, p, analysis))).toEqual(["cooler", "faster", "followBeat", "softer"]);
    // 主歌 0~16 秒有渐强，没有冲击
    expect(keys(quickPrompts({ kind: "range", startMs: 0, endMs: 15_000 }, p, analysis))).toEqual(["fillRange", "followBuild"]);
    expect(quickPrompts({ kind: "point", timeMs: 0, trackId: null }, p, analysis)).toEqual(quickPrompts({ kind: "point", timeMs: 0, trackId: null }, p, analysis));
    for (const scope of [{ kind: "track", id: "x" }, { kind: "point", timeMs: 0, trackId: null }] as const) {
      expect(quickPrompts(scope, p, analysis).length).toBeLessThanOrEqual(4);
    }
  });
});
