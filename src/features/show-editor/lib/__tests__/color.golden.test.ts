import { describe, expect, it } from "vitest";

import { loadTestEngine } from "../../engine/__tests__/testEngine";
import type { ChannelFunction, FixtureModel } from "@/features/fixtures";
import { createEmptyProject, type Cue, type EffectId, type Easing, type Rgb, type ShowProject } from "../project";
import golden from "./golden/show-eval.json";

/**
 * 黄金向量：与 Rust `show-engine/tests/golden.rs` 读取同一份 JSON。
 *
 * 前端经 WASM 调用同一份 Rust 求值器，所以这里校验的是**完整的 DMX 输出**（全部用例，
 * 包括 RGBW / 色温 / 调光 / 默认值）。它同时守护 WASM 产物没有过期：改了 show-engine
 * 却忘了 `npm run build:wasm` 时，这里会和 Rust 测试给出不同结果。
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
  gamma: number;
  /** 模型简写：通道功能按顺序排布，可写 `name:默认值` */
  models: Record<string, string[]>;
  fixtures: { model: string; universe: number; address: number }[];
  tempo?: { bpm: number };
  /** `fixtures` 是分组轨道的成员（按数组顺序），`fixture` 是单灯轨道 */
  tracks?: { fixture?: number; fixtures?: number[]; mute?: boolean; solo?: boolean }[];
  cues: GoldenCue[];
  samples: { t: number; universe: number; expect: Record<string, number> }[];
}

function buildModels(models: GoldenCase["models"]): FixtureModel[] {
  return Object.entries(models).map(([id, specs]) => ({
    id,
    name: id,
    system: "",
    productType: "",
    builtin: false,
    properties: specs.map((spec, i) => {
      const [name, def] = spec.split(":");
      return {
        name,
        code: `${name}${i + 1}`,
        function: name as ChannelFunction,
        channel: i + 1,
        width: 1 as const,
        bigEndian: true,
        defaultValue: Number(def ?? 0),
        valueDesc: "",
        description: "",
      };
    }),
  }));
}

function buildProject(c: GoldenCase): ShowProject {
  const p = createEmptyProject(c.name);
  p.durationMs = 10_000;
  p.output.gamma = c.gamma;
  p.fixtureModels = buildModels(c.models);
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
      easing: q.easing ?? ("linear" as Easing),
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

const cases = golden.cases as unknown as GoldenCase[];

describe("WASM 求值与 Rust 黄金向量一致", () => {
  it("用例数量", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const compiled = loadTestEngine().compile(buildProject(c));
    expect(compiled, "工程应能编译").not.toBeNull();
    if (!compiled) return;
    expect(compiled.warnings).toEqual([]);
    for (const s of c.samples) {
      compiled.previewAt(s.t);
      const frame = compiled.frame(compiled.universes.indexOf(s.universe));
      expect(frame, `缺少 Universe ${s.universe}`).not.toBeNull();
      for (const [ch, want] of Object.entries(s.expect)) {
        expect(frame?.[Number(ch) - 1], `t=${s.t} universe=${s.universe} 通道 ${ch}`).toBe(want);
      }
    }
    compiled.dispose();
  });
});
