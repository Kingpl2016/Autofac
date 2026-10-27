import { beforeEach, describe, expect, it } from "vitest";

import { addEffectCue, copyCues, pasteCues, updateEffectCues } from "../cueOps";
import { EFFECT_PRESETS, presetOf } from "../effectPresets";
import { addFixtures } from "../ops";
import { createEmptyProject, type EffectCue, type ShowProject } from "../project";
import { parseProject } from "../schema";
import { RGBW } from "./testkit";

let p: ShowProject;
let trackId: string;

beforeEach(() => {
  p = createEmptyProject("t");
  const [fixture] = addFixtures(p, RGBW, 1);
  // 添加灯具时可能已自动建轨道；没有的话补一条
  if (p.tracks.length === 0) {
    p.tracks.push({ id: "t1", target: { kind: "fixture", id: fixture }, mute: false, solo: false, lock: false });
  }
  trackId = p.tracks[0].id;
});

const effect = (id: string | null): EffectCue => {
  const cue = p.cues.find((c) => c.id === id);
  if (cue?.kind !== "effect") throw new Error("应是特效 Cue");
  return cue;
};

describe("预设", () => {
  it("覆盖全部 8 种特效，参数都在合法范围内", () => {
    expect(EFFECT_PRESETS.map((e) => e.effect).sort()).toEqual(
      ["breathe", "chase", "gradient", "pulse", "rainbow", "sparkle", "strobe", "wipe"].sort(),
    );
    for (const preset of EFFECT_PRESETS) {
      expect(preset.params.colors.length).toBeGreaterThanOrEqual(1);
      expect(preset.params.colors.length).toBeLessThanOrEqual(4);
      expect(preset.params.range[0]).toBeLessThanOrEqual(preset.params.range[1]);
      expect(preset.lengthMs).toBeGreaterThan(0);
    }
  });

  it("工程里放入每种预设后能通过结构校验（与后端 u32 种子约束一致）", () => {
    p.durationMs = 200_000;
    let start = 0;
    for (const preset of EFFECT_PRESETS) {
      expect(addEffectCue(p, trackId, start, preset)).not.toBeNull();
      start += preset.lengthMs;
    }
    const parsed = parseProject(JSON.stringify(p));
    expect(parsed.ok && parsed.project.cues).toHaveLength(8);
    const bad = JSON.parse(JSON.stringify(p)) as ShowProject;
    (bad.cues[0] as EffectCue).seed = -1;
    expect(parseProject(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe("addEffectCue", () => {
  it("按预设建出特效 Cue：起点对齐到帧、参数深拷贝、独立于预设", () => {
    const preset = presetOf("rainbow");
    const id = addEffectCue(p, trackId, 1010, preset);
    const cue = effect(id);
    expect(cue.startMs).toBe(1000);
    expect(cue.endMs - cue.startMs).toBe(preset.lengthMs);
    expect(cue.effect).toBe("rainbow");
    cue.colors.push([1, 2, 3]);
    expect(preset.params.colors).toHaveLength(1);
  });

  it("不越过后一个 Cue 与工程末尾；放不下返回 null；锁定轨道拒绝", () => {
    const preset = presetOf("pulse");
    expect(addEffectCue(p, trackId, 0, preset)).not.toBeNull();
    // 起点落在已有 Cue 内
    expect(addEffectCue(p, trackId, 1000, preset)).toBeNull();
    // 夹在后一个 Cue 之前
    const next = addEffectCue(p, trackId, 10_000, preset);
    const gapStart = effect(addEffectCue(p, trackId, 4000, preset, { lengthMs: 100_000 }));
    expect(gapStart.endMs).toBe(10_000);
    expect(next).not.toBeNull();
    const tail = effect(addEffectCue(p, trackId, p.durationMs - 1000, preset));
    expect(tail.endMs).toBe(p.durationMs);
    p.tracks[0].lock = true;
    expect(addEffectCue(p, trackId, 100_000, preset)).toBeNull();
    expect(addEffectCue(p, "ghost", 0, preset)).toBeNull();
  });
});

describe("updateEffectCues", () => {
  it("规整取值：周期、颜色、扩散、方向、范围、种子", () => {
    const id = addEffectCue(p, trackId, 0, presetOf("breathe"));
    updateEffectCues(p, [id ?? ""], {
      period: { kind: "ms", ms: 5 },
      colors: [[300, -5, 12.6], [1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]],
      phaseSpread: 3,
      direction: -1,
      range: [80, 20],
      seed: -12.7,
    });
    const cue = effect(id);
    expect(cue.period).toEqual({ kind: "ms", ms: 33 });
    expect(cue.colors).toHaveLength(4);
    expect(cue.colors[0]).toEqual([255, 0, 13]);
    expect(cue.phaseSpread).toBe(1);
    expect(cue.direction).toBe(-1);
    expect(cue.range).toEqual([20, 80]);
    expect(cue.seed).toBe(12);
    updateEffectCues(p, [id ?? ""], { period: { kind: "beats", beats: 0.001 } });
    expect(effect(id).period).toEqual({ kind: "beats", beats: 0.25 });
    updateEffectCues(p, [id ?? ""], { period: { kind: "beats", beats: 1.256 } });
    expect(effect(id).period).toEqual({ kind: "beats", beats: 1.26 });
    updateEffectCues(p, [id ?? ""], { period: { kind: "ms", ms: 9e9 } });
    expect(effect(id).period).toEqual({ kind: "ms", ms: 600_000 });
  });

  it("空颜色列表被忽略；换类型保留其他参数", () => {
    const id = addEffectCue(p, trackId, 0, presetOf("chase"));
    const before = effect(id).colors;
    updateEffectCues(p, [id ?? ""], { colors: [], effect: "strobe" });
    expect(effect(id).colors).toEqual(before);
    expect(effect(id).effect).toBe("strobe");
  });

  it("静态 Cue 与锁定轨道上的 Cue 不受影响，返回实际修改数", () => {
    p.cues.push({
      id: "s", trackId, kind: "static", startMs: 50_000, endMs: 51_000, brightness: 100,
      fadeInMs: 0, fadeOutMs: 0, easing: "linear", rgb: [1, 1, 1],
    });
    const id = addEffectCue(p, trackId, 0, presetOf("breathe"));
    expect(updateEffectCues(p, [id ?? "", "s"], { phaseSpread: 0.5 })).toBe(1);
    p.tracks[0].lock = true;
    expect(updateEffectCues(p, [id ?? ""], { phaseSpread: 0.9 })).toBe(0);
    expect(effect(id).phaseSpread).toBe(0.5);
  });
});

describe("复制粘贴", () => {
  it("特效 Cue 保留全部参数", () => {
    const id = addEffectCue(p, trackId, 0, presetOf("wipe")) ?? "";
    updateEffectCues(p, [id], { seed: 99, direction: -1 });
    const clip = copyCues(p, [id]);
    const created = pasteCues(p, clip, 20_000);
    expect(created).toHaveLength(1);
    const copy = effect(created[0]);
    expect(copy).toMatchObject({ kind: "effect", effect: "wipe", seed: 99, direction: -1, startMs: 20_000 });
    expect(copy.colors).toEqual(effect(id).colors);
    expect(copy.colors).not.toBe(effect(id).colors);
  });
});
