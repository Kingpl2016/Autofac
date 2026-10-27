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
    d.media.push({ id: "a1", kind: "audio", path: "D:\\music\\a.mp3", name: "a.mp3", durationMs: 90_000 });
    d.mediaTracks.push({ id: "mt", kind: "audio", name: "音频 1", mute: false, solo: false, lock: false, volume: 0.8, height: "tall" });
    d.mediaClips.push({ id: "mc", trackId: "mt", mediaId: "a1", startMs: 500, inMs: 1000, durationMs: 60_000, volume: 1, fadeInMs: 200, fadeOutMs: 0 });
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
    expect(parseProject(JSON.stringify({ ...sample(), version: 99 }))).toMatchObject({ ok: false, reason: "tooNew" });
    expect(parseProject(JSON.stringify({ ...sample(), version: "2" }))).toMatchObject({ ok: false, reason: "invalidShape" });
    expect(parseProject(JSON.stringify({ ...sample(), version: 0 }))).toMatchObject({ ok: false, reason: "invalidShape" });
    const { name: _name, ...noName } = sample();
    expect(parseProject(JSON.stringify(noName))).toMatchObject({ ok: false, reason: "invalidShape" });
  });

  it("v2 工程升级到 v3：每个素材的偏移变成自己轨道上的一个片段（负偏移裁掉开头）", () => {
    const current = sample();
    const v2: Record<string, unknown> = {
      ...current,
      version: 2,
      media: [
        { id: "a", kind: "audio", path: "a.mp3", name: "a.mp3", durationMs: 60_000, offsetMs: 1500 },
        { id: "v", kind: "video", path: "v.mp4", name: "v.mp4", durationMs: 10_000, offsetMs: -2000 },
        { id: "gone", kind: "audio", path: "g.mp3", name: "g.mp3", durationMs: 1000, offsetMs: -5000 },
      ],
    };
    delete v2.mediaTracks;
    delete v2.mediaClips;
    const parsed = parseProject(JSON.stringify(v2));
    expect(parsed).toMatchObject({ ok: true, migratedFrom: 2 });
    if (!parsed.ok) return;
    const p = parsed.project;
    expect(p.version).toBe(3);
    expect(p.media[0]).toEqual({ id: "a", kind: "audio", path: "a.mp3", name: "a.mp3", durationMs: 60_000 });
    expect(p.mediaTracks.map((t) => [t.kind, t.name])).toEqual([
      ["audio", "a.mp3"],
      ["video", "v.mp4"],
      ["audio", "g.mp3"],
    ]);
    expect(p.mediaClips.map((c) => [c.mediaId, c.startMs, c.inMs, c.durationMs])).toEqual([
      ["a", 1500, 0, 60_000],
      ["v", 0, 2000, 8000],
    ]);
  });

  it("媒体片段的引用完整性：轨道 / 素材存在、类型一致、不超出素材、淡入淡出不超长", () => {
    const base = sample();
    const bad = (fn: (d: ShowProject) => void, code: string) =>
      expect(parseProject(JSON.stringify(produce(base, fn)))).toMatchObject({ ok: false, reason: "integrity", detail: expect.stringContaining(code) });
    bad((d) => void (d.mediaClips[0].trackId = "nope"), "missingTrack");
    bad((d) => void (d.mediaClips[0].mediaId = "nope"), "missingMedia");
    bad((d) => void (d.mediaTracks[0].kind = "video"), "badMediaClip");
    bad((d) => void (d.mediaClips[0].durationMs = 89_500), "badMediaClip");
    bad((d) => void (d.mediaClips[0].fadeOutMs = 59_900), "badMediaClip");
    bad((d) => void d.mediaClips.push({ ...d.mediaClips[0] }), "duplicateId");
  });

  it("v1 工程无损升级到当前版本：旧 Cue 保留，新字段补默认值", () => {
    const current = sample();
    // 模拟 v1 文件：没有 v2 / v3 新增的字段
    const v1: Record<string, unknown> = { ...current, version: 1 };
    for (const key of ["presets", "sections", "loopRange", "stage", "mediaTracks", "mediaClips"]) delete v1[key];
    v1.media = current.media.map((m) => ({ ...m, offsetMs: 0 }));
    const output = { ...current.output } as Record<string, unknown>;
    for (const key of ["universes", "sync", "park"]) delete output[key];
    v1.output = output;
    const parsed = parseProject(JSON.stringify(v1));
    expect(parsed).toMatchObject({ ok: true, migratedFrom: 1 });
    if (!parsed.ok) return;
    expect(parsed.project.version).toBe(3);
    expect(parsed.project.mediaClips).toHaveLength(1);
    expect(parsed.project.cues).toEqual(current.cues);
    expect(parsed.project.presets).toEqual([]);
    expect(parsed.project.output.park).toEqual([]);
    expect(parsed.project.output.sync).toEqual({ artSync: false, sacnSyncUniverse: null });
    expect(parsed.project.stage.width).toBeGreaterThan(0);
    expect(parseProject(JSON.stringify(current))).toMatchObject({ ok: true, migratedFrom: null });
  });

  it("v2 片段：外观 / 场景、关键帧、分布、预设引用的结构与引用完整性", () => {
    const base = sample();
    const trackId = base.tracks[0].id;
    const look = produce(base, (d) => {
      d.presets.push({ id: "p", name: "红", group: "color", look: { color: { kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } } } });
      d.cues.push({
        ...staticCue({ trackId }),
        kind: "look",
        look: {
          presetId: "p",
          intensity: { kind: "curve", curve: { shape: "sine", from: 0, to: 100, cycles: 2, phase: 0 } },
          attrs: { pan: { kind: "keys", keys: [{ tMs: 0, value: 0, curve: "linear" }, { tMs: 500, value: 1, curve: "hold" }] } },
        },
        spread: { values: { pan: { from: 0, to: 1 } }, delay: { fromMs: 0, toMs: 200 }, wings: 2 },
      } as Cue);
      d.tracks.push({ id: "ts", target: { kind: "scene" }, mute: false, solo: false, lock: false, name: "场景" });
      d.cues.push({
        ...staticCue({ trackId: "ts" }),
        id: "scene1",
        kind: "scene",
        entries: [{ fixtureId: d.fixtures[0].id, look: { color: { kind: "value", value: { kind: "kelvin", kelvin: 3200 } } } }],
      } as Cue);
    });
    expect(parseProject(JSON.stringify(look))).toMatchObject({ ok: true });

    const missingPreset = produce(look, (d) => {
      d.presets = [];
    });
    expect(parseProject(JSON.stringify(missingPreset))).toMatchObject({ ok: false, reason: "integrity", detail: expect.stringContaining("missingPreset") });
    const sceneOnFixtureTrack = produce(look, (d) => {
      const scene = d.cues.find((c) => c.kind === "scene");
      if (scene) scene.trackId = trackId;
    });
    expect(parseProject(JSON.stringify(sceneOnFixtureTrack))).toMatchObject({ ok: false, detail: expect.stringContaining("badCueTrack") });
    const badAttr = produce(look, (d) => {
      const c = d.cues.find((x) => x.kind === "look");
      if (c?.kind === "look") c.look.attrs = { pan: { kind: "value", value: 2 } };
    });
    expect(parseProject(JSON.stringify(badAttr))).toMatchObject({ ok: false, reason: "invalidShape" });
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
