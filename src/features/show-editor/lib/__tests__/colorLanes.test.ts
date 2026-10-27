import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import { compileCached } from "../../engine/compiledCache";
import type { CompiledShow, Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { MAX_LANE_COLUMNS, sampleLanes, stripGradient } from "../colorLanes";
import { addStaticCue } from "../cueOps";
import { addFixtures } from "../ops";
import { createEmptyProject } from "../project";
import { RGBW } from "./testkit";

let engine: Engine;
beforeAll(async () => {
  engine = await loadTestEngine();
});

/** 两台 RGBW：灯 1 在 1~2 秒红色，灯 2 在 0~4 秒蓝色。 */
function sample() {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    d.durationMs = 4000;
    addStaticCue(d, d.tracks[0].id, 1000, { lengthMs: 1000, rgb: [255, 0, 0] });
    addStaticCue(d, d.tracks[1].id, 0, { lengthMs: 4000, rgb: [0, 0, 255] });
  });
}

describe("sampleLanes", () => {
  it("每列一次求值，得到每台灯具的实际输出色", () => {
    const p = sample();
    const lanes = sampleLanes(compileCached(engine, p), 0, 4000, 500);
    expect(lanes.columns).toBe(8);
    const red = lanes.colors.get(p.fixtures[0].id) ?? [];
    expect(red[0]).toEqual([0, 0, 0]);
    expect(red[2][0]).toBeGreaterThan(200);
    expect(red[2][2]).toBe(0);
    expect(red[5]).toEqual([0, 0, 0]);
    const blue = lanes.colors.get(p.fixtures[1].id) ?? [];
    expect(blue.every((c) => c[2] > 200 && c[0] === 0)).toBe(true);
  });

  it("引擎未就绪时为空；列数有上限", () => {
    expect(sampleLanes(null, 0, 1000, 10).columns).toBe(0);
    const calls: number[] = [];
    const fake = {
      fixtureIds: ["f"],
      previewAt: (t: number) => {
        calls.push(t);
        return new Uint8Array([1, 2, 3]);
      },
    } as unknown as CompiledShow;
    const lanes = sampleLanes(fake, 0, 1_000_000, 1);
    expect(lanes.columns).toBe(MAX_LANE_COLUMNS);
    expect(calls).toHaveLength(MAX_LANE_COLUMNS);
  });

  it("工程快照不变时复用编译结果", () => {
    const p = sample();
    expect(compileCached(engine, p)).toBe(compileCached(engine, p));
    expect(compileCached(engine, produce(p, (d) => void (d.name = "x")))).not.toBe(compileCached(engine, p));
    expect(compileCached(null, p)).toBeNull();
  });
});

describe("stripGradient", () => {
  it("截取片段范围内的列，硬边色块；多台灯具取平均", () => {
    const p = sample();
    const lanes = sampleLanes(compileCached(engine, p), 0, 4000, 500);
    const strip = stripGradient(lanes, [p.fixtures[0].id], 1000, 2000) ?? "";
    expect(strip.startsWith("linear-gradient(to right, ")).toBe(true);
    // 1~2 秒覆盖第 2、3 列，两列都是红色
    expect(strip.match(/rgb\(/g)).toHaveLength(2);
    expect(strip).toContain("0.00%");
    expect(strip).toContain("100.00%");
    const mixed = stripGradient(lanes, [p.fixtures[0].id, p.fixtures[1].id], 1000, 1500) ?? "";
    const [r, , b] = (mixed.match(/rgb\((\d+) (\d+) (\d+)\)/) ?? []).slice(1).map(Number);
    expect(r).toBeGreaterThan(100);
    expect(b).toBeGreaterThan(100);
  });

  it("太窄时合并相邻列；没有采样或没有灯具时为 null", () => {
    const p = sample();
    const lanes = sampleLanes(compileCached(engine, p), 0, 4000, 10);
    expect(stripGradient(lanes, [p.fixtures[1].id], 0, 4000, 4)?.match(/rgb\(/g)).toHaveLength(4);
    expect(stripGradient(lanes, ["ghost"], 0, 1000)).toBeNull();
    expect(stripGradient(sampleLanes(null, 0, 1000, 10), [p.fixtures[0].id], 0, 1000)).toBeNull();
  });
});
