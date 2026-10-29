import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { clipCategory, clipFill, clipName, colorKeysGradient } from "../clipVisual";
import { addEffectCue, addLookCue, addStaticCue } from "../cueOps";
import { addEffectDefCue, BUILTIN_EFFECTS, defaultEffectParams, effectName, type EffectDef } from "../effectLibrary";
import { presetOf } from "../effectPresets";
import { addFixtures } from "../ops";
import { createEmptyProject, type Cue, type Preset, type Rgb, type ShowProject } from "../project";
import { RGBW } from "./testkit";

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

const def = (id: string): EffectDef => {
  const d = BUILTIN_EFFECTS.find((e) => e.id === id);
  if (!d) throw new Error(id);
  return d;
};

/**
 * 解析 `linear-gradient(90deg, rgb(r g b) p%, …)`（或按周期重复的 `repeating-linear-gradient`），
 * 取片段宽度 `x`% 处的颜色（同一位置两个色标为硬边）。
 */
function colorAt(css: string, xPct: number): Rgb {
  const stops = [...css.matchAll(/rgb\((\d+) (\d+) (\d+)\) (-?[\d.]+)%/g)].map((m) => ({
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])] as Rgb,
    at: Number(m[4]),
  }));
  let x = xPct;
  if (css.startsWith("repeating-") && stops.length > 1) {
    const [first, last] = [stops[0].at, stops[stops.length - 1].at];
    const period = last - first;
    if (period > 0) x = first + ((((x - first) % period) + period) % period);
  }
  let i = 0;
  while (i + 1 < stops.length && stops[i + 1].at <= x) i += 1;
  const a = stops[i];
  const b = stops[i + 1];
  if (!b || b.at <= a.at) return a.rgb;
  const f = (x - a.at) / (b.at - a.at);
  return a.rgb.map((v, c) => Math.round(v + (b.rgb[c] - v) * f)) as Rgb;
}

/** 一台 RGBW 灯（Gamma 1）上放一个内置属性特效，片段从 0 开始。 */
function withEffect(id: string): { p: ShowProject; cue: Cue } {
  let cueId: string | null = null;
  const p = produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 1);
    d.durationMs = 20_000;
    d.output.gamma = 1;
    cueId = addEffectDefCue(d, d.tracks[0].id, 0, def(id), defaultEffectParams(def(id)), effectName(def(id), "zh"));
  });
  const cue = p.cues.find((c) => c.id === cueId);
  if (!cue) throw new Error("没放下");
  return { p, cue };
}

/** 引擎在 `tMs` 时第一台灯的预览色。 */
function output(p: ShowProject, tMs: number): Rgb {
  const compiled = engine.compile(p);
  if (!compiled) throw new Error("引擎无法编译");
  const bytes = compiled.previewAt(tMs);
  compiled.dispose();
  return [bytes[0], bytes[1], bytes[2]];
}

describe("片段主体填充与实际输出一致", () => {
  for (const id of ["rainbow", "twoColor", "colorChase"]) {
    it(`属性特效 ${id}：颜色序列铺成按周期重复的渐变，各时刻与引擎输出相同`, () => {
      const { p, cue } = withEffect(id);
      const fill = clipFill(cue, [], { tempo: p.tempo, members: 1, gamma: 1 });
      expect(fill.neutral).toBe(false);
      expect(fill.background).toContain("linear-gradient(90deg");
      const length = cue.endMs - cue.startMs;
      // 避开硬边的瞬间（两侧颜色不同），取各段中间附近的时刻
      for (const t of [137, 911, 1777, 2610, 3333, 4321, 5555, 6789, 7600]) {
        if (t >= length) continue;
        const want = output(p, t);
        const got = colorAt(fill.background ?? "", (t / length) * 100);
        for (let c = 0; c < 3; c += 1) expect(Math.abs(got[c] - want[c]), `${id} t=${t} 通道 ${c}`).toBeLessThanOrEqual(2);
      }
    });
  }

  it("没有颜色层的属性特效（强度追逐、画圆）为中性；固定颜色为纯色；静态片段为纯色", () => {
    expect(clipFill(withEffect("intensityChase").cue, [], { tempo: null, members: 1, gamma: 1 })).toEqual({ background: null, neutral: true });
    expect(clipFill(withEffect("circle").cue, [], { tempo: null, members: 1, gamma: 1 }).neutral).toBe(true);
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
      d.durationMs = 10_000;
      addStaticCue(d, d.tracks[0].id, 0, { lengthMs: 1000, rgb: [1, 2, 3] });
      addLookCue(d, d.tracks[0].id, 2000, { color: { kind: "value", value: { kind: "rgb", rgb: [9, 8, 7] } } }, 1000);
    });
    const ctx = { tempo: null, members: 1, gamma: 2.2 };
    expect(clipFill(p.cues[0], [], ctx)).toEqual({ background: "rgb(1 2 3)", neutral: false });
    expect(clipFill(p.cues[1], [], ctx)).toEqual({ background: "rgb(9 8 7)", neutral: false });
  });

  it("关键帧渐变：保持为硬边，线性为平滑；首帧之前、末帧之后保持", () => {
    const keys = [
      { tMs: 250, value: { kind: "rgb" as const, rgb: [255, 0, 0] as Rgb }, curve: "hold" as const },
      { tMs: 500, value: { kind: "rgb" as const, rgb: [0, 0, 255] as Rgb }, curve: "linear" as const },
      { tMs: 750, value: { kind: "rgb" as const, rgb: [0, 255, 0] as Rgb }, curve: "linear" as const },
    ];
    expect(colorKeysGradient(keys, 1000, 1)).toBe(
      "linear-gradient(90deg, rgb(255 0 0) 0%, rgb(255 0 0) 25%, rgb(255 0 0) 50%, rgb(0 0 255) 50%, rgb(0 255 0) 75%, rgb(0 255 0) 100%)",
    );
    expect(colorKeysGradient(keys.slice(0, 1), 1000, 1)).toBe("rgb(255 0 0)");
  });

  it("预设：按预设的颜色层；场景：第一个带颜色的条目", () => {
    const presets: Preset[] = [{ id: "pr", name: "暖橙", group: "color", look: { color: { kind: "value", value: { kind: "rgb", rgb: [255, 128, 0] } } } }];
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 10_000;
      d.presets = presets;
      addLookCue(d, d.tracks[0].id, 0, { presetId: "pr" }, 1000);
    });
    expect(clipFill(p.cues[0], presets, { tempo: null, members: 1, gamma: 1 }).background).toBe("rgb(255 128 0)");
    const scene: Cue = {
      id: "s",
      kind: "scene",
      trackId: "x",
      startMs: 0,
      endMs: 1000,
      brightness: 100,
      fadeInMs: 0,
      fadeOutMs: 0,
      easing: "linear",
      entries: [
        { fixtureId: "a", look: { intensity: { kind: "value", value: 50 } } },
        { fixtureId: "b", look: { color: { kind: "value", value: { kind: "rgb", rgb: [0, 10, 20] } } } },
      ],
    };
    expect(clipFill(scene, [], { tempo: null, members: 1, gamma: 1 }).background).toBe("rgb(0 10 20)");
    expect(clipFill({ ...scene, entries: [] }, [], { tempo: null, members: 1, gamma: 1 }).neutral).toBe(true);
  });
});

describe("片段类别与名称", () => {
  it("类别：颜色 / 特效 / 预设 / 场景（旧片段按内容推断）", () => {
    const presets: Preset[] = [{ id: "pr", name: "暖橙", group: "color", look: {} }];
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
      d.durationMs = 30_000;
      d.presets = presets;
      addStaticCue(d, d.tracks[0].id, 0, { lengthMs: 1000 });
      addLookCue(d, d.tracks[0].id, 2000, { intensity: { kind: "value", value: 100 } }, 1000);
      addLookCue(d, d.tracks[0].id, 4000, { presetId: "pr" }, 1000);
      addEffectCue(d, d.tracks[0].id, 6000, presetOf("chase"));
      addLookCue(d, d.tracks[0].id, 25_000, { intensity: { kind: "curve", curve: { shape: "sine", from: 0, to: 100, cycles: 2, phase: 0 } } }, 1000);
    });
    expect(p.cues.map((c) => clipCategory(c, presets))).toEqual(["color", "color", "preset", "effect", "effect"]);
    expect(clipCategory(withEffect("rainbow").cue, [])).toBe("effect");
  });

  it("名称：片段名称 → 预设名 → 经典特效名 → 空", () => {
    const presets: Preset[] = [{ id: "pr", name: "暖橙", group: "color", look: {} }];
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
      d.durationMs = 30_000;
      addStaticCue(d, d.tracks[0].id, 0, { lengthMs: 1000 });
      addLookCue(d, d.tracks[0].id, 2000, { presetId: "pr" }, 1000);
      addEffectCue(d, d.tracks[0].id, 4000, presetOf("wipe"));
    });
    const effectName = (e: string) => `特效:${e}`;
    expect(p.cues.map((c) => clipName(c, presets, effectName))).toEqual(["", "暖橙", "特效:wipe"]);
    // 属性特效放下时写入特效名
    expect(clipName(withEffect("twoColor").cue, [], effectName)).toBe("双色交替");
  });
});
