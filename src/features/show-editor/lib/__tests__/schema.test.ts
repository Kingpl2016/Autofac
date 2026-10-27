import { describe, expect, it } from "vitest";

import { addFixtures, createGroup } from "../ops";
import { createEmptyProject, type Cue, type ShowProject } from "../project";
import { parseProject, projectIntegrityIssues } from "../schema";
import { produce } from "immer";
import { RGBW } from "./testkit";

function sample(): ShowProject {
  return produce(createEmptyProject("演出"), (d) => {
    const ids = addFixtures(d, RGBW, 3);
    createGroup(d, "舞台", ids);
    d.markers.push({ id: "m1", timeMs: 1000, label: "副歌" });
    d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    d.media.push({ id: "a1", kind: "audio", path: "D:\\music\\a.mp3", name: "a.mp3", durationMs: 90_000, offsetMs: 0 });
  });
}

const staticCue = (over: Partial<Cue> = {}): Cue =>
  ({
    id: "c1",
    trackId: "",
    kind: "static",
    startMs: 0,
    endMs: 2000,
    brightness: 100,
    fadeInMs: 500,
    fadeOutMs: 500,
    easing: "easeInOut",
    rgb: [255, 128, 0],
    ...over,
  }) as Cue;

describe("parseProject", () => {
  it("往返：序列化后再解析得到同样的工程", () => {
    const project = sample();
    const result = parseProject(JSON.stringify(project));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project).toEqual(project);
  });

  it("包含静态与特效 Cue 的工程可以通过", () => {
    const base = sample();
    const trackId = base.tracks[0].id;
    const project = produce(base, (d) => {
      d.cues.push(staticCue({ trackId }));
      d.cues.push({
        id: "e1",
        trackId,
        kind: "effect",
        effect: "rainbow",
        colors: [[255, 0, 0]],
        period: { kind: "beats", beats: 4 },
        phaseSpread: 0.5,
        direction: 1,
        range: [0, 100],
        seed: 7,
        startMs: 3000,
        endMs: 9000,
        brightness: 80,
        fadeInMs: 0,
        fadeOutMs: 0,
        easing: "linear",
      });
    });
    expect(parseProject(JSON.stringify(project)).ok).toBe(true);
  });

  it("不是 JSON", () => {
    expect(parseProject("{坏的")).toMatchObject({ ok: false, reason: "invalidJson" });
  });

  it("版本不对或字段缺失", () => {
    const project = { ...sample(), version: 2 };
    expect(parseProject(JSON.stringify(project))).toMatchObject({ ok: false, reason: "invalidShape" });
    const { name: _name, ...noName } = sample();
    expect(parseProject(JSON.stringify(noName))).toMatchObject({ ok: false, reason: "invalidShape" });
  });

  it("数值越界被拒绝：地址、亮度、颜色分量、Gamma", () => {
    const base = sample();
    const badAddress = produce(base, (d) => {
      d.fixtures[0].address = 600;
    });
    expect(parseProject(JSON.stringify(badAddress))).toMatchObject({ ok: false, reason: "invalidShape" });
    const badUniverse = produce(base, (d) => {
      d.fixtures[0].universe = 3000;
    });
    expect(parseProject(JSON.stringify(badUniverse)).ok).toBe(false);
    const badGamma = produce(base, (d) => {
      d.output.gamma = 5;
    });
    expect(parseProject(JSON.stringify(badGamma)).ok).toBe(false);
    const trackId = base.tracks[0].id;
    const badBrightness = produce(base, (d) => {
      d.cues.push(staticCue({ trackId, brightness: 120 }));
    });
    expect(parseProject(JSON.stringify(badBrightness)).ok).toBe(false);
    const badColor = produce(base, (d) => {
      d.cues.push(staticCue({ trackId, rgb: [256, 0, 0] } as Partial<Cue>));
    });
    expect(parseProject(JSON.stringify(badColor)).ok).toBe(false);
  });

  it("未知的 Cue 种类被拒绝", () => {
    const base = sample();
    const raw = JSON.parse(JSON.stringify(base)) as { cues: unknown[] };
    raw.cues.push({ ...staticCue({ trackId: base.tracks[0].id }), kind: "mystery" });
    expect(parseProject(JSON.stringify(raw)).ok).toBe(false);
  });
});

describe("projectIntegrityIssues", () => {
  it("完整的工程没有问题", () => {
    expect(projectIntegrityIssues(sample())).toEqual([]);
  });

  it("发现缺失的模型 / 灯具 / 分组 / 轨道", () => {
    const base = sample();
    expect(
      projectIntegrityIssues(produce(base, (d) => { d.fixtureModels = []; })).map((i) => i.code),
    ).toContain("missingModel");
    expect(
      projectIntegrityIssues(produce(base, (d) => { d.groups[0].fixtureIds.push("ghost"); })).map((i) => i.code),
    ).toContain("missingFixture");
    expect(
      projectIntegrityIssues(produce(base, (d) => { d.groups = []; })).map((i) => i.code),
    ).toContain("missingGroup");
    expect(
      projectIntegrityIssues(produce(base, (d) => { d.cues.push(staticCue({ trackId: "ghost" })); })).map((i) => i.code),
    ).toContain("missingTrack");
  });

  it("重复的 id 与非法的 Cue 时间范围", () => {
    const base = sample();
    const dup = produce(base, (d) => {
      d.fixtures[1].id = d.fixtures[0].id;
    });
    expect(projectIntegrityIssues(dup).map((i) => i.code)).toContain("duplicateId");
    const trackId = base.tracks[0].id;
    const reversed = produce(base, (d) => {
      d.cues.push(staticCue({ trackId, startMs: 2000, endMs: 1000 }));
    });
    expect(projectIntegrityIssues(reversed).map((i) => i.code)).toContain("badCueRange");
    const fadesTooLong = produce(base, (d) => {
      d.cues.push(staticCue({ trackId, startMs: 0, endMs: 1000, fadeInMs: 700, fadeOutMs: 700 }));
    });
    expect(projectIntegrityIssues(fadesTooLong).map((i) => i.code)).toContain("badCueRange");
  });

  it("引用不完整的工程在解析时被拒绝", () => {
    const broken = produce(sample(), (d) => {
      d.fixtureModels = [];
    });
    expect(parseProject(JSON.stringify(broken))).toMatchObject({ ok: false, reason: "integrity" });
  });
});
