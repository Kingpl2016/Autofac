import { describe, expect, it } from "vitest";

import { createPreviewEvaluator } from "../color";
import { createEmptyProject, type Cue, type EffectId, type Easing, type Rgb, type ShowProject } from "../project";
import golden from "./golden/show-eval.json";

/**
 * 黄金向量：与 Rust `show-engine/tests/golden.rs` 读取同一份 JSON。
 * TS 预览只模拟 RGB 灯的颜色，所以只校验 `tsPreview !== false` 的用例。
 */

interface GoldenCue {
  track?: number;
  startMs: number;
  endMs: number;
  rgb?: [number, number, number];
  brightness?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  easing?: Easing;
  /** 有 `effect` 的是特效 Cue */
  effect?: EffectId;
  colors?: Rgb[];
  periodMs?: number;
  beats?: number;
  phaseSpread?: number;
  direction?: 1 | -1;
  range?: [number, number];
  seed?: number;
}

interface GoldenCase {
  name: string;
  tsPreview?: boolean;
  gamma: number;
  fixtures: { model: string; universe: number; address: number }[];
  tempo?: { bpm: number };
  /** `fixtures` 是分组轨道的成员（按数组顺序），`fixture` 是单灯轨道 */
  tracks?: { fixture?: number; fixtures?: number[]; mute?: boolean; solo?: boolean }[];
  cues: GoldenCue[];
  samples: { t: number; universe: number; expect: Record<string, number> }[];
}

function buildProject(c: GoldenCase): ShowProject {
  const p = createEmptyProject(c.name);
  p.output.gamma = c.gamma;
  p.fixtures = c.fixtures.map((f, i) => ({
    id: `f${i}`,
    name: `F${i}`,
    modelId: f.model,
    universe: f.universe,
    address: f.address,
  }));
  const trackSpecs: NonNullable<GoldenCase["tracks"]> =
    c.tracks ?? c.fixtures.map((_, i) => ({ fixture: i }));
  if (c.tempo) p.tempo = { bpm: c.tempo.bpm, offsetMs: 0, beatsPerBar: 4 };
  p.tracks = trackSpecs.map((t, i) => {
    if (t.fixtures) {
      p.groups.push({ id: `g${i}`, name: `G${i}`, fixtureIds: t.fixtures.map((n) => `f${n}`) });
    }
    return {
      id: `t${i}`,
      target: t.fixtures ? { kind: "group", id: `g${i}` } : { kind: "fixture", id: `f${t.fixture}` },
      mute: t.mute ?? false,
      solo: t.solo ?? false,
      lock: false,
    };
  });
  p.cues = c.cues.map((q, i): Cue => {
    const base = {
      id: `c${i}`,
      trackId: `t${q.track ?? 0}`,
      startMs: q.startMs,
      endMs: q.endMs,
      brightness: q.brightness ?? 100,
      fadeInMs: q.fadeInMs ?? 0,
      fadeOutMs: q.fadeOutMs ?? 0,
      easing: q.easing ?? "linear" as Easing,
    };
    if (q.effect) {
      return {
        ...base,
        kind: "effect",
        effect: q.effect,
        colors: q.colors ?? [[255, 0, 0]],
        period: q.beats !== undefined ? { kind: "beats", beats: q.beats } : { kind: "ms", ms: q.periodMs ?? 1000 },
        phaseSpread: q.phaseSpread ?? 0,
        direction: q.direction ?? 1,
        range: q.range ?? [0, 100],
        seed: q.seed ?? 7,
      };
    }
    return { ...base, kind: "static", rgb: q.rgb ?? [0, 0, 0] };
  });
  return p;
}

const cases = (golden.cases as unknown as GoldenCase[]).filter((c) => c.tsPreview !== false);

describe("预览颜色与 Rust 黄金向量一致", () => {
  it("至少包含若干 RGB 用例", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const project = buildProject(c);
    const evaluate = createPreviewEvaluator(project);
    for (const s of c.samples) {
      const colors = evaluate(s.t);
      for (const [chText, want] of Object.entries(s.expect)) {
        const ch = Number(chText);
        const idx = project.fixtures.findIndex(
          (f) => f.universe === s.universe && ch >= f.address && ch < f.address + 3,
        );
        expect(idx, `通道 ${ch} 应属于某台 RGB 灯`).toBeGreaterThanOrEqual(0);
        const rgb = colors.get(`f${idx}`);
        expect(rgb?.[ch - project.fixtures[idx].address], `t=${s.t} 通道 ${ch}`).toBe(want);
      }
    }
  });
});
