import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { addEffectCue } from "../cueOps";
import { effectBackground } from "../cueTemplates";
import { presetOf } from "../effectPresets";
import { addFixtures, createGroup } from "../ops";
import { createEmptyProject, type EffectCue, type Rgb, type ShowProject } from "../project";
import { RGBW } from "./testkit";

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

/** 解析 `repeating-linear-gradient` 的色标，按位置（片段宽度百分比）插值出颜色。 */
function colorAt(css: string, pct: number): Rgb {
  const stops = [...css.matchAll(/rgb\((\d+) (\d+) (\d+)\) (-?[\d.]+)%/g)].map((m) => ({
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])] as Rgb,
    at: Number(m[4]),
  }));
  const first = stops[0].at;
  const span = stops[stops.length - 1].at - first;
  const x = first + ((((pct - first) % span) + span) % span);
  const i = stops.findIndex((s, k) => k > 0 && s.at >= x);
  const a = stops[i - 1];
  const b = stops[i];
  const f = (x - a.at) / (b.at - a.at);
  return a.rgb.map((v, c) => Math.round(v + (b.rgb[c] - v) * f)) as Rgb;
}

/** 放一个特效（多台灯时放在它们的分组轨道上）；gamma 设为 1，DMX 字节即特效的意图色。 */
function show(effect: "rainbow" | "gradient", patch: Partial<EffectCue>, fixtures = 1): { p: ShowProject; cue: EffectCue } {
  let id = "";
  const p = produce(createEmptyProject("t"), (d) => {
    const ids = addFixtures(d, RGBW, fixtures);
    d.durationMs = 20_000;
    d.output.gamma = 1;
    if (fixtures > 1) createGroup(d, "排", ids);
    id = addEffectCue(d, d.tracks.at(-1)!.id, 0, presetOf(effect)) ?? "";
    const c = d.cues.find((x) => x.id === id);
    if (c?.kind === "effect") Object.assign(c, patch);
  });
  const cue = p.cues.find((c) => c.id === id);
  if (cue?.kind !== "effect") throw new Error("应为特效");
  return { p, cue };
}

/** 引擎在 `tMs` 时第一台灯的 RGB（RGBW 灯的前三个通道）。 */
function output(p: ShowProject, tMs: number): Rgb {
  const compiled = engine.compile(p);
  if (!compiled) throw new Error("引擎无法编译");
  compiled.previewAt(tMs);
  const data = compiled.frame(0);
  compiled.dispose();
  if (!data) throw new Error("没有 DMX 帧");
  return [data[0], data[1], data[2]];
}

describe("时间线上彩虹 / 渐变特效的填充与实际输出一致", () => {
  it("彩虹：周期 6000 ms、片段 9467 ms，填充按周期重复，各时刻颜色与引擎输出相同", () => {
    const { p, cue } = show("rainbow", { startMs: 0, endMs: 9467, period: { kind: "ms", ms: 6000 }, colors: [[255, 0, 0]] });
    const css = effectBackground(cue, { tempo: p.tempo, members: 1 });
    expect(css).toContain("repeating-linear-gradient");
    for (const t of [0, 500, 1500, 2999, 4200, 6000, 7500, 9400]) {
      const want = output(p, t);
      const got = colorAt(css, (t / 9467) * 100);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(got[c] - want[c]), `t=${t} 通道 ${c}`).toBeLessThanOrEqual(2);
    }
  });

  it("渐变：多色循环，含相位扩散与反向时第一台灯的相位", () => {
    const { p, cue } = show(
      "gradient",
      { startMs: 0, endMs: 8000, period: { kind: "ms", ms: 3000 }, colors: [[255, 0, 0], [0, 0, 255], [0, 255, 0]], phaseSpread: 0.6, direction: -1 },
      3,
    );
    const css = effectBackground(cue, { tempo: p.tempo, members: 3 });
    for (const t of [0, 700, 2100, 5000, 7900]) {
      const want = output(p, t);
      const got = colorAt(css, (t / 8000) * 100);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(got[c] - want[c]), `t=${t} 通道 ${c}`).toBeLessThanOrEqual(2);
    }
  });

  it("其它特效仍是纯色或横向渐变", () => {
    const { cue } = show("rainbow", {});
    expect(effectBackground({ ...cue, effect: "pulse", colors: [[10, 20, 30]] })).toBe("rgb(10 20 30)");
    expect(effectBackground({ ...cue, effect: "wipe", colors: [[1, 2, 3], [4, 5, 6]] })).toBe("linear-gradient(90deg, rgb(1 2 3), rgb(4 5 6))");
  });
});
