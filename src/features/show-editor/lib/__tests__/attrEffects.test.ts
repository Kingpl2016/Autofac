import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { ATTR_EFFECT_DEFAULTS, ATTR_EFFECTS, buildAttrEffect, flashRateHz, unsafeFlash } from "../attrEffects";
import { createPreviewEvaluator } from "../color";
import { addLookCue } from "../cueOps";
import { addFixtures, createGroup } from "../ops";
import { createEmptyProject } from "../project";
import { projectIntegrityIssues } from "../schema";
import { RGBW } from "./testkit";

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

const tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };

describe("属性特效", () => {
  it("按拍换算循环次数；分组轨道按成员错开相位", () => {
    const circle = buildAttrEffect("circle", { ...ATTR_EFFECT_DEFAULTS.circle, lengthMs: 8000, members: 4 }, tempo);
    // 4 拍 @120BPM = 2 秒一圈，8 秒 4 圈
    expect(circle.look.attrs?.pan).toMatchObject({ kind: "curve", curve: { shape: "sine", cycles: 4, phase: 0 } });
    expect(circle.look.attrs?.tilt).toMatchObject({ kind: "curve", curve: { phase: 0.25 } });
    expect(circle.spread).toEqual({ values: { phase: { from: 0, to: -0.75 } } });
    expect(buildAttrEffect("circle", { ...ATTR_EFFECT_DEFAULTS.circle, lengthMs: 8000, members: 1 }, tempo).spread).toBeUndefined();
    const chase = buildAttrEffect("intensityChase", { ...ATTR_EFFECT_DEFAULTS.intensityChase, lengthMs: 4000, members: 4 }, tempo);
    expect(chase.look.intensity).toMatchObject({ kind: "curve", curve: { shape: "square", duty: 0.25, cycles: 8 } });
  });

  it("每种特效都能放进工程并通过完整性校验", () => {
    for (const id of ATTR_EFFECTS) {
      const p = produce(createEmptyProject("t"), (d) => {
        addFixtures(d, RGBW, 3);
        d.durationMs = 20_000;
        const { look, spread } = buildAttrEffect(id, { ...ATTR_EFFECT_DEFAULTS[id], lengthMs: 8000, members: 3 }, tempo);
        expect(addLookCue(d, d.tracks[0].id, 0, look, 8000, spread)).not.toBeNull();
      });
      expect(projectIntegrityIssues(p)).toEqual([]);
    }
  });

  it("强度追逐在分组成员之间轮流点亮（引擎求值）", () => {
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 4);
      d.durationMs = 10_000;
      d.output.gamma = 1;
      createGroup(d, "排", d.fixtures.map((f) => f.id));
      const { look, spread } = buildAttrEffect("intensityChase", { period: { kind: "ms", ms: 1000 }, size: 100, lengthMs: 4000, members: 4 }, null);
      look.color = { kind: "value", value: { kind: "rgb", rgb: [255, 255, 255] } };
      addLookCue(d, d.tracks.at(-1)!.id, 0, look, 4000, spread);
    });
    const evaluate = createPreviewEvaluator(p, engine);
    const lit = (t: number) => p.fixtures.map((f, i) => ((evaluate(t).get(f.id)?.[0] ?? 0) > 0 ? i : -1)).filter((i) => i >= 0);
    expect(lit(100)).toEqual([0]);
    expect(lit(350)).toEqual([1]);
    expect(lit(600)).toEqual([2]);
    expect(lit(850)).toEqual([3]);
  });

  it("频闪安全：超过建议频率时提示", () => {
    const strobe = buildAttrEffect("strobe", { period: { kind: "ms", ms: 50 }, size: 100, lengthMs: 2000, members: 1 }, null);
    expect(flashRateHz(strobe.look, 2000)).toBe(20);
    expect(unsafeFlash(strobe.look, 2000)).toBe(true);
    const slow = buildAttrEffect("strobe", { period: { kind: "ms", ms: 500 }, size: 100, lengthMs: 2000, members: 1 }, null);
    expect(unsafeFlash(slow.look, 2000)).toBe(false);
    expect(flashRateHz({ intensity: { kind: "value", value: 1 } }, 1000)).toBe(0);
  });
});

describe("旧特效迁移", () => {
  it("呼吸 / 追逐换成等价的外观片段，时间与亮度不变；擦除不能转换", async () => {
    const { addEffectCue, replaceWithLook } = await import("../cueOps");
    const { presetOf } = await import("../effectPresets");
    const { lookFromLegacyEffect } = await import("../attrEffects");
    let breathe = "";
    let wipe = "";
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 4);
      d.durationMs = 30_000;
      createGroup(d, "排", d.fixtures.map((f) => f.id));
      breathe = addEffectCue(d, d.tracks.at(-1)!.id, 0, presetOf("breathe")) ?? "";
      wipe = addEffectCue(d, d.tracks[0].id, 0, presetOf("wipe")) ?? "";
    });
    const source = p.cues.find((c) => c.id === breathe);
    if (source?.kind !== "effect") throw new Error("应为特效");
    const converted = lookFromLegacyEffect(source, 4, null);
    expect(converted).not.toBeNull();
    const w = p.cues.find((c) => c.id === wipe);
    expect(w?.kind === "effect" && lookFromLegacyEffect(w, 1, null)).toBeNull();
    const next = produce(p, (d) => {
      expect(replaceWithLook(d, breathe, converted!.look, converted!.spread)).toBe(true);
    });
    const cue = next.cues.find((c) => c.id === breathe);
    expect(cue).toMatchObject({ kind: "look", startMs: 0, endMs: 8000 });
    expect(cue?.kind === "look" && cue.look.intensity).toMatchObject({ kind: "curve", curve: { shape: "sine", from: 10, to: 100, cycles: 2 } });
    expect(cue?.kind === "look" && cue.spread).toEqual({ values: { phase: { from: 0, to: -0.3 } } });
    expect(projectIntegrityIssues(next)).toEqual([]);
  });
});
