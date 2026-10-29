import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { createPreviewEvaluator } from "../color";
import { addLookCue } from "../cueOps";
import { blankEffect, effectFromClip, effectPreview, PREVIEW_MEMBERS, validateEffect } from "../effectDraft";
import { addEffectDefCue, BUILTIN_EFFECTS, buildEffectLook, defaultEffectParams, type EffectDef } from "../effectLibrary";
import { addFixtures, createGroup } from "../ops";
import { createEmptyProject, type LookClip } from "../project";
import { RGBW } from "./testkit";

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

const def = (id: string): EffectDef => BUILTIN_EFFECTS.find((e) => e.id === id)!;
const tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };

describe("新建与校验", () => {
  it("空白特效合法，标识不与已有的重复", () => {
    const blank = blankEffect([{ id: "my-effect-1" }], "新特效");
    expect(blank.id).toBe("my-effect-2");
    expect(validateEffect(blank)).toMatchObject({ ok: true, def: { id: "my-effect-2", name: "新特效" } });
  });

  it("问题给出字段路径与原因；运行时标记不影响校验", () => {
    const empty = { ...blankEffect([], "x"), look: {} };
    const r = validateEffect(empty);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("look");
    const badRef = { ...blankEffect([], "x"), look: { intensity: { shape: "sine" as const, lo: "$nope" as const } } };
    expect(validateEffect(badRef)).toMatchObject({ ok: false });
    expect(validateEffect({ ...def("sparkle"), builtin: true }).ok).toBe(true);
  });
});

describe("从片段创建特效", () => {
  it("特效片段：取快照，当前参数成为新的默认值", () => {
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 3);
      d.durationMs = 30_000;
      addEffectDefCue(d, d.tracks[0].id, 0, def("sparkle"), {
        ...defaultEffectParams(def("sparkle")),
        period: { kind: "ms", ms: 400 },
        values: { density: 0.7 },
      });
    });
    const cue = p.cues[0] as LookClip;
    const made = effectFromClip(cue, { members: 3, tempo, existing: BUILTIN_EFFECTS, name: "我的闪烁" });
    expect(made).toMatchObject({ id: "my-effect-1", name: "我的闪烁", group: "custom", period: { kind: "ms", ms: 400 } });
    expect(made.params?.find((d) => d.id === "density")?.default).toBe(0.7);
    expect(validateEffect(made).ok).toBe(true);
  });

  it("普通外观片段：曲线成为波形层（速度换成倍数），颜色序列成为色表，相位分布换成扩散", () => {
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 4);
      d.durationMs = 30_000;
      createGroup(d, "排", d.fixtures.map((f) => f.id));
      addLookCue(
        d,
        d.tracks.at(-1)!.id,
        0,
        {
          intensity: { kind: "curve", curve: { shape: "square", from: 0, to: 80, cycles: 1, phase: 0, duty: 0.25, period: { kind: "beats", beats: 1 } } },
          color: {
            kind: "cycle",
            cycle: { colors: [{ kind: "rgb", rgb: [255, 0, 0] }, { kind: "kelvin", kelvin: 3200 }], blend: "step", cycles: 1, phase: 0, period: { kind: "beats", beats: 2 } },
          },
          attrs: { pan: { kind: "curve", curve: { shape: "sine", from: 0.2, to: 0.8, cycles: 1, phase: 0.25, period: { kind: "beats", beats: 0.5 } } } },
        },
        8000,
        { values: { phase: { from: 0, to: -0.75 } } },
      );
    });
    const cue = p.cues[0] as LookClip;
    const made = effectFromClip(cue, { members: 4, tempo, existing: [], name: "反推" });
    expect(made.period).toEqual({ kind: "beats", beats: 1 });
    expect(made.look.intensity).toEqual({ shape: "square", lo: 0, hi: 0.8, duty: 0.25 });
    expect(made.look.attrs?.pan).toEqual({ shape: "sine", lo: 0.2, hi: 0.8, cycles: 2, phase: 0.25 });
    expect(made.look.color).toMatchObject({ blend: "step", colors: [[255, 0, 0], expect.any(Array)] });
    expect(made).toMatchObject({ spreadBy: "phase", spread: 1 });
    expect(validateEffect(made).ok).toBe(true);
    // 用反推出的特效重新生成：强度曲线与原片段一致
    const rebuilt = buildEffectLook(made, defaultEffectParams(made), { members: 4, tempo });
    expect(rebuilt.look.intensity).toEqual(cue.look.intensity);
    expect(rebuilt.spread).toEqual(cue.spread);
  });

  it("关键帧取第一帧；没有任何层时给一个固定强度层", () => {
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
      d.durationMs = 30_000;
      addLookCue(d, d.tracks[0].id, 0, { intensity: { kind: "keys", keys: [{ tMs: 0, value: 40, curve: "linear" }, { tMs: 1000, value: 100, curve: "linear" }] } }, 4000);
      addLookCue(d, d.tracks[0].id, 5000, {}, 4000);
    });
    expect(effectFromClip(p.cues[0] as LookClip, { members: 1, tempo: null, existing: [], name: "a" }).look.intensity).toEqual({ value: 0.4 });
    expect(effectFromClip(p.cues[1] as LookClip, { members: 1, tempo: null, existing: [], name: "b" }).look).toEqual({ intensity: { value: 1 } });
  });
});

describe("预览", () => {
  it("8 台虚拟灯：颜色序列沿成员错开（引擎求值）；没有颜色层时为白光", () => {
    const preview = effectPreview(def("colorChase"), defaultEffectParams(def("colorChase")), tempo);
    expect(preview.fixtureIds).toHaveLength(PREVIEW_MEMBERS);
    const colors = createPreviewEvaluator(preview.project, engine)(100);
    const distinct = new Set(preview.fixtureIds.map((id) => (colors.get(id) ?? []).join(",")));
    expect(distinct.size).toBeGreaterThan(1);
    const chase = effectPreview(def("intensityChase"), defaultEffectParams(def("intensityChase")), tempo);
    const lit = createPreviewEvaluator(chase.project, engine)(10);
    expect([...lit.values()].some((rgb) => rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255)).toBe(true);
    // 用到的属性有通道
    expect(effectPreview(def("zoomBreathe")).offsets.has("zoom")).toBe(true);
  });
});
