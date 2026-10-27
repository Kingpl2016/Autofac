import { describe, expect, it } from "vitest";

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

describe("大工程性能（回归保护）", () => {
  it("预览求值：编译一次，之后每帧远小于 33 ms 的帧预算", () => {
    const p = bigProject();
    expect(p.cues).toHaveLength(2000);
    const started = performance.now();
    const evaluate = createPreviewEvaluator(p);
    const compiled = performance.now();
    for (let frame = 0; frame < 300; frame += 1) evaluate(frame * 33);
    const perFrame = (performance.now() - compiled) / 300;
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
