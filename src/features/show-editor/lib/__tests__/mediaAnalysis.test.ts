import { describe, expect, it } from "vitest";

import { eventsIn, featuresIn, mapAnalysis } from "../mediaAnalysis";
import { testAnalysis } from "./analysisKit";

const media = { id: "m1", name: "song.mp3" };

describe("分析结果换算到时间线", () => {
  it("没有片段时按 0 点；片段起点 − 入点平移，只保留片段范围内的部分", () => {
    const at0 = mapAnalysis({ media, clip: null, audio: testAnalysis() })!;
    expect(at0.sections.map((s) => [s.startMs, s.endMs, s.label])).toEqual([
      [0, 16_000, "A"],
      [16_000, 48_000, "B"],
      [48_000, 64_000, "A"],
    ]);
    expect(at0.events.filter((e) => e.kind === "hit")).toHaveLength(16);

    // 素材从 10 秒处开始用，放在时间线 4 秒处，用 30 秒：时间线 4~34 秒 ↔ 素材 10~40 秒
    const moved = mapAnalysis({ media, clip: { startMs: 4000, inMs: 10_000, durationMs: 30_000 }, audio: testAnalysis() })!;
    expect(moved.sections.map((s) => [s.startMs, s.endMs, s.label])).toEqual([
      [4000, 10_000, "A"],
      [10_000, 34_000, "B"],
    ]);
    expect(moved.events.find((e) => e.kind === "drop")?.atMs).toBe(10_000);
    // 渐强在素材 8 秒 = 时间线 2 秒，早于片段起点：丢掉
    expect(moved.events.some((e) => e.kind === "build")).toBe(false);
    expect(moved.events.every((e) => e.atMs >= 4000 && e.atMs < 34_000)).toBe(true);
    expect(moved.beatsMs[0]).toBe(4000);
    // 第一拍偏移规整到一小节内：素材 0 点的强拍在时间线 −6 秒，即 2 秒（模 2 秒为 0）
    expect(moved.offsetMs).toBe(0);
  });

  it("用户改过的标签以用户的为准；标签不可信时不给角色", () => {
    const audio = testAnalysis();
    audio.sections[2] = { ...audio.sections[2], labelConfidence: 0.2 };
    const mapped = mapAnalysis({
      media,
      clip: null,
      audio,
      prefs: { sensitivity: 1, labels: { "0": "前奏" } },
      tags: { roles: { "0": "intro", "16000": "chorus", "48000": "outro" } },
    })!;
    expect(mapped.sections.map((s) => [s.label, s.edited, s.role])).toEqual([
      ["前奏", true, "intro"],
      ["B", false, "chorus"],
      ["A", false, undefined],
    ]);
  });

  it("视频的切镜与镜头也换算到时间线；只有视频分析时也能用", () => {
    const mapped = mapAnalysis({
      media,
      clip: { startMs: 1000, inMs: 0, durationMs: 10_000 },
      audio: null,
      video: { cuts: [{ atMs: 3000, strength: 1 }, { atMs: 20_000, strength: 1 }], shots: [{ startMs: 0, endMs: 3000, rgb: [255, 0, 0], brightness: 0.5 }] },
    })!;
    expect(mapped.events).toEqual([{ kind: "cut", atMs: 4000, strength: 1 }]);
    expect(mapped.shots[0]).toMatchObject({ startMs: 1000, endMs: 4000, rgb: [255, 0, 0] });
    expect(mapAnalysis({ media, clip: null, audio: null })).toBeNull();
  });

  it("范围内的特征按重叠时长加权，标签取重叠最多的段落；范围内的事件", () => {
    const mapped = mapAnalysis({ media, clip: null, audio: testAnalysis() })!;
    const chorus = featuresIn(mapped, 16_000, 48_000)!;
    expect(chorus).toMatchObject({ energy: 1, label: "B", confident: true });
    const mixed = featuresIn(mapped, 12_000, 20_000)!;
    // 第 7、8 小节（渐强中 0.4、0.5）+ 第 9、10 小节（1、1）
    expect(mixed.energy).toBeCloseTo(0.725);
    expect(featuresIn(mapped, 100_000, 120_000)).toBeNull();
    expect(eventsIn(mapped, ["drop", "break"], 0, 64_000).map((e) => e.atMs)).toEqual([16_000, 48_000]);
  });
});
