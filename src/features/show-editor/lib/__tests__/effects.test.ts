import { describe, expect, it } from "vitest";

import { effectRateHz, FALLBACK_BPM, MIN_PERIOD_MS, periodMs } from "../effects";
import type { Tempo } from "../project";

// 特效的逐灯具求值只在 Rust（show-engine/src/effects.rs）里实现与测试；
// 前端经 WASM 调用，由 color.golden.test.ts 校验整条求值链路。

const tempo = (bpm: number): Tempo => ({ bpm, offsetMs: 0, beatsPerBar: 4 });

describe("periodMs", () => {
  it("毫秒原样返回，有下限，非法值按下限", () => {
    expect(periodMs({ kind: "ms", ms: 800 }, null)).toBe(800);
    expect(periodMs({ kind: "ms", ms: 1 }, null)).toBe(MIN_PERIOD_MS);
    expect(periodMs({ kind: "ms", ms: Number.NaN }, null)).toBe(MIN_PERIOD_MS);
  });

  it("按拍数换算：有节拍用节拍，没有或非法时按 120 BPM", () => {
    expect(periodMs({ kind: "beats", beats: 2 }, null)).toBe(1000);
    expect(periodMs({ kind: "beats", beats: 2 }, tempo(60))).toBe(2000);
    expect(periodMs({ kind: "beats", beats: 1 }, tempo(0))).toBe(60_000 / FALLBACK_BPM);
  });

  it("换算成频率", () => {
    expect(effectRateHz({ kind: "ms", ms: 100 }, null)).toBe(10);
    expect(effectRateHz({ kind: "beats", beats: 1 }, tempo(120))).toBe(2);
  });
});
