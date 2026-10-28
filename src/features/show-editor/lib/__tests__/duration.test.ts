import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { addStaticCue } from "../cueOps";
import { contentEndMs, fitDurationToContent, hasOverflow, MIN_SHOW_MS, normalizeDuration, overflowAt, setShowDuration } from "../duration";
import { addFixtures, MAX_DURATION_MS } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { RGBW } from "./testkit";

function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 1);
    d.durationMs = 60_000;
    const track = d.tracks[0].id;
    addStaticCue(d, track, 1000, { lengthMs: 4000, fadeOutMs: 2000 });
    addStaticCue(d, track, 9000, { lengthMs: 4000 });
    addStaticCue(d, track, 20_000, { lengthMs: 4000 });
    d.markers.push({ id: "m1", timeMs: 3000, label: "a" }, { id: "m2", timeMs: 15_000, label: "b" });
    d.sections.push({ id: "s", name: "x", startMs: 0, endMs: 30_000, color: [0, 0, 0] });
    d.media.push({ id: "a", kind: "audio", path: "a.mp3", name: "a", durationMs: 60_000 });
    d.mediaTracks.push({ id: "mt", kind: "audio", name: "1", mute: false, solo: false, lock: false, volume: 1 });
    d.mediaClips.push({ id: "c", trackId: "mt", mediaId: "a", startMs: 0, inMs: 0, durationMs: 25_000, volume: 1, fadeInMs: 0, fadeOutMs: 0 });
    d.loopRange = { startMs: 8000, endMs: 22_000 };
  });
}

describe("节目时长", () => {
  it("规整：对齐到帧，夹在 1 秒 ~ 24 小时", () => {
    expect(normalizeDuration(12_345)).toBe(12_333);
    expect(normalizeDuration(10)).toBe(MIN_SHOW_MS);
    expect(normalizeDuration(9e12)).toBeLessThanOrEqual(MAX_DURATION_MS);
  });

  it("统计缩短的影响；内容结尾", () => {
    const p = base();
    expect(contentEndMs(p)).toBe(30_000);
    expect(hasOverflow(overflowAt(p, 30_000))).toBe(false);
    expect(overflowAt(p, 10_000)).toEqual({ trimmedCues: 1, removedCues: 1, mediaClips: 1, markers: 1, sections: 1 });
  });

  it("缩短：裁短跨过结尾的片段（淡出收紧），删除结尾之后的内容，循环区间夹到范围内", () => {
    const p = produce(base(), (d) => void setShowDuration(d, 10_000));
    expect(p.durationMs).toBe(10_000);
    expect(p.cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [1000, 5000],
      [9000, 10_000],
    ]);
    expect(p.mediaClips[0].durationMs).toBe(10_000);
    expect(p.markers.map((m) => m.id)).toEqual(["m1"]);
    expect(p.sections[0].endMs).toBe(10_000);
    expect(p.loopRange).toEqual({ startMs: 8000, endMs: 10_000 });
    // 延长不动任何内容
    const b = base();
    const q = produce(b, (d) => void setShowDuration(d, 120_000));
    expect(q.cues).toBe(b.cues);
    expect(q.markers).toBe(b.markers);
  });

  it("适配内容：设到最后一个内容的结尾", () => {
    const p = produce(base(), (d) => void fitDurationToContent(d));
    expect(p.durationMs).toBe(30_000);
    expect(p.cues).toHaveLength(3);
    const empty = createEmptyProject("e");
    expect(produce(empty, (d) => void fitDurationToContent(d)).durationMs).toBe(empty.durationMs);
  });
});
