import { describe, expect, it } from "vitest";

import type { FixtureModel } from "@/features/fixtures";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { createPreviewEvaluator } from "../color";
import { collectSnapTargets } from "../snap";
import { createEmptyProject, type ShowProject } from "../project";
import { parseProject } from "../schema";

/** 大工程：100 台灯具各一条轨道，每条 20 个 Cue（共 2000 个，一半是特效），总长 10 分钟。 */
function bigProject(): ShowProject {
  const p = createEmptyProject("big");
  p.durationMs = 600_000;
  p.output.gamma = 2.2;
  for (let i = 0; i < 100; i += 1) {
    p.fixtures.push({ id: `f${i}`, name: `F${i}`, modelId: "m", universe: i % 4, address: 1 + (i % 100) * 3 });
    p.tracks.push({ id: `t${i}`, target: { kind: "fixture", id: `f${i}` }, mute: false, solo: false, lock: false });
    for (let k = 0; k < 20; k += 1) {
      const base = {
        id: `c${i}-${k}`,
        trackId: `t${i}`,
        startMs: k * 30_000,
        endMs: k * 30_000 + 20_000,
        brightness: 100,
        fadeInMs: 500,
        fadeOutMs: 500,
        easing: "sCurve" as const,
      };
      p.cues.push(
        k % 2 === 0
          ? { ...base, kind: "static", rgb: [200, 100, 50] }
          : {
              ...base,
              kind: "effect",
              effect: "breathe",
              colors: [[255, 0, 0]],
              period: { kind: "ms", ms: 2000 },
              phaseSpread: 0,
              direction: 1,
              range: [0, 100],
              seed: 1,
            },
      );
    }
  }
  return p;
}

/** 像素灯条模型：总调光 + 16 个 RGB 像素（49 通道）。 */
const PIXELS = 16;
function pixelModel(): FixtureModel {
  const prop = (code: string, fn: "dimmer" | "red" | "green" | "blue", channel: number, head?: number) => ({
    name: code,
    code,
    function: fn,
    channel,
    width: 1 as const,
    bigEndian: true,
    defaultValue: 0,
    valueDesc: "",
    description: "",
    ...(head ? { head } : {}),
  });
  return {
    id: "bar",
    name: "bar",
    system: "",
    productType: "",
    builtin: false,
    matrix: { cols: PIXELS, rows: 1 },
    properties: [
      prop("Dim", "dimmer", 1),
      ...Array.from({ length: PIXELS }, (_, i) => i + 1).flatMap((h) =>
        (["red", "green", "blue"] as const).map((fn, k) => prop(`${fn}${h}`, fn, 2 + (h - 1) * 3 + k, h)),
      ),
    ],
  };
}

/** 32 台像素灯条（每个 Universe 10 台）：每台一条整灯颜色轨道，再加一个 512 个像素的分组追逐轨道。 */
function pixelProject(): ShowProject {
  const p = createEmptyProject("pixels");
  p.durationMs = 60_000;
  p.output.gamma = 2.2;
  p.fixtureModels = [pixelModel()];
  const base = { brightness: 100, fadeInMs: 0, fadeOutMs: 0, easing: "linear" as const, startMs: 0, endMs: 60_000 };
  for (let i = 0; i < 32; i += 1) {
    p.fixtures.push({ id: `f${i}`, name: `F${i}`, modelId: "bar", universe: Math.floor(i / 10), address: 1 + (i % 10) * 49 });
    p.tracks.push({ id: `t${i}`, target: { kind: "fixture", id: `f${i}` }, mute: false, solo: false, lock: false });
    p.cues.push({
      ...base,
      id: `c${i}`,
      trackId: `t${i}`,
      kind: "look",
      look: { color: { kind: "value", value: { kind: "rgb", rgb: [255, 80, 0] } } },
    });
  }
  const refs = p.fixtures.flatMap((f) => Array.from({ length: PIXELS }, (_, h) => `${f.id}#${h + 1}`));
  p.groups.push({ id: "g", name: "G", fixtureIds: refs });
  p.tracks.push({ id: "tg", target: { kind: "group", id: "g" }, mute: false, solo: false, lock: false });
  p.cues.push({
    ...base,
    id: "chase",
    trackId: "tg",
    kind: "look",
    look: { intensity: { kind: "curve", curve: { shape: "square", from: 0, to: 100, cycles: 60, phase: 0, duty: 0.25 } } },
    spread: { values: { phase: { from: 0, to: 1 } } },
  });
  return p;
}

describe("大工程性能（回归保护）", () => {
  it("预览求值：编译一次，之后每帧远小于 33 ms 的帧预算", () => {
    const p = bigProject();
    expect(p.cues).toHaveLength(2000);
    const engine = loadTestEngine();
    p.fixtureModels = [
      {
        id: "m",
        name: "m",
        system: "",
        productType: "",
        builtin: false,
        properties: (["red", "green", "blue"] as const).map((fn, i) => ({
          name: fn,
          code: fn,
          function: fn,
          channel: i + 1,
          width: 1 as const,
          bigEndian: true,
          defaultValue: 0,
          valueDesc: "",
          description: "",
        })),
      },
    ];
    const started = performance.now();
    const evaluate = createPreviewEvaluator(p, engine);
    const compiled = performance.now();
    for (let frame = 0; frame < 300; frame += 1) evaluate(frame * 33);
    const perFrame = (performance.now() - compiled) / 300;
    expect(compiled - started).toBeLessThan(500);
    expect(perFrame).toBeLessThan(8);
  });

  it("像素灯：32 台 × 16 像素，像素分组追逐叠加整灯颜色，每帧仍远小于帧预算", () => {
    const p = pixelProject();
    const engine = loadTestEngine();
    const started = performance.now();
    const evaluate = createPreviewEvaluator(p, engine);
    const compiled = performance.now();
    for (let frame = 0; frame < 300; frame += 1) evaluate(frame * 33);
    const perFrame = (performance.now() - compiled) / 300;
    // 编译后每台灯拆成整灯本体 + 16 个像素成员，预览色也按成员给出
    expect(evaluate(1000).get("f0#16")).toBeDefined();
    expect(compiled - started).toBeLessThan(500);
    expect(perFrame).toBeLessThan(8);
  });

  it("吸附目标收集和工程校验在大工程上仍然够快", () => {
    const p = bigProject();
    let t = performance.now();
    const targets = collectSnapTargets(p, 1000);
    // 各轨道的起止时刻相同，去重后约 40 个不同的时间点
    expect(targets.length).toBeGreaterThan(30);
    expect(performance.now() - t).toBeLessThan(100);
    // 校验要求模型存在：这里只测解析耗时，不要求通过
    t = performance.now();
    parseProject(JSON.stringify(p));
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
