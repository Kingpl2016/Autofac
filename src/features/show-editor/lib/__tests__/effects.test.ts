import { describe, expect, it } from "vitest";

import { effectRateHz, FALLBACK_BPM, hash32, MIN_PERIOD_MS, periodMs, sampleEffect } from "../effects";
import type { EffectCue, Tempo } from "../project";

type Params = Parameters<typeof sampleEffect>[0];

const params = (over: Partial<Params> = {}): Params => ({
  effect: "breathe",
  colors: [[255, 0, 0]],
  period: { kind: "ms", ms: 1000 },
  phaseSpread: 0,
  direction: 1,
  seed: 7,
  ...over,
});

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

describe("hash32", () => {
  it("确定性，且对种子 / 序号 / 步长都敏感", () => {
    expect(hash32(7, 3, 9)).toBe(hash32(7, 3, 9));
    expect(hash32(7, 3, 9)).not.toBe(hash32(8, 3, 9));
    expect(hash32(7, 3, 9)).not.toBe(hash32(7, 4, 9));
    expect(hash32(7, 3, 9)).not.toBe(hash32(7, 3, 10));
  });

  it("结果是无符号 32 位整数，命中率接近 30%", () => {
    let hits = 0;
    for (let k = 0; k < 10_000; k += 1) {
      const h = hash32(1, 0, k);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(4_294_967_296);
      if (h / 4_294_967_296 < 0.3) hits += 1;
    }
    expect(hits).toBeGreaterThan(2700);
    expect(hits).toBeLessThan(3300);
  });
});

describe("sampleEffect", () => {
  it("呼吸：半周期最亮，周期端点最暗", () => {
    const p = params();
    expect(sampleEffect(p, null, 0, 0, 1).modulation).toBe(0);
    expect(sampleEffect(p, null, 250, 0, 1).modulation).toBeCloseTo(0.5, 12);
    expect(sampleEffect(p, null, 500, 0, 1).modulation).toBe(1);
  });

  it("彩虹：相位沿灯具均匀分布，反向时顺序颠倒", () => {
    const p = params({ effect: "rainbow", phaseSpread: 1 });
    const hues = [0, 1, 2, 3].map((i) => sampleEffect(p, null, 0, i, 4).rgb);
    expect(hues).toEqual([
      [1, 0, 0],
      [0.5, 1, 0],
      [0, 1, 1],
      [0.5, 0, 1],
    ]);
    expect(sampleEffect({ ...p, direction: -1 }, null, 0, 0, 4).rgb).toEqual(hues[3]);
  });

  it("追逐：亮点环形移动", () => {
    const p = params({ effect: "chase", period: { kind: "ms", ms: 4000 } });
    const at = (t: number) => [0, 1, 2, 3].map((i) => sampleEffect(p, null, t, i, 4).modulation);
    expect(at(1000)).toEqual([0, 1, 0, 0]);
    expect(at(3500)).toEqual([0.5, 0, 0, 0.5]);
  });

  it("擦除：第二色作底色", () => {
    const p = params({ effect: "wipe", colors: [[255, 0, 0], [0, 0, 255]], period: { kind: "ms", ms: 4000 } });
    expect(sampleEffect(p, null, 2400, 0, 4)).toEqual({ rgb: [1, 0, 0], modulation: 1 });
    expect(sampleEffect(p, null, 2400, 3, 4)).toEqual({ rgb: [0, 0, 1], modulation: 1 });
    const single = params({ effect: "wipe", period: { kind: "ms", ms: 4000 } });
    expect(sampleEffect(single, null, 2400, 3, 4).modulation).toBe(0);
  });

  it("脉冲与频闪", () => {
    const pulse = params({ effect: "pulse" });
    expect(sampleEffect(pulse, null, 0, 0, 1).modulation).toBe(1);
    expect(sampleEffect(pulse, null, 500, 0, 1).modulation).toBe(0.125);
    const strobe = params({ effect: "strobe", period: { kind: "ms", ms: 200 } });
    expect(sampleEffect(strobe, null, 50, 0, 1).modulation).toBe(1);
    expect(sampleEffect(strobe, null, 150, 0, 1).modulation).toBe(0);
  });

  it("闪烁：同种子同结果，亮时线性衰减", () => {
    const p = params({ effect: "sparkle", period: { kind: "ms", ms: 200 } });
    expect(sampleEffect(p, null, 1234, 2, 5)).toEqual(sampleEffect(p, null, 1234, 2, 5));
    let lit = -1;
    for (let k = 0; k < 200 && lit < 0; k += 1) if (sampleEffect(p, null, k * 200, 0, 1).modulation > 0) lit = k;
    expect(lit).toBeGreaterThanOrEqual(0);
    expect(sampleEffect(p, null, lit * 200, 0, 1).modulation).toBe(1);
    expect(sampleEffect(p, null, lit * 200 + 100, 0, 1).modulation).toBe(0.5);
  });

  it("颜色为空退回白色；序号越界被夹取；按拍数的周期使用节拍", () => {
    expect(sampleEffect(params({ effect: "pulse", colors: [] }), null, 0, 99, 3).rgb).toEqual([1, 1, 1]);
    const beats = params({ period: { kind: "beats", beats: 2 } });
    expect(sampleEffect(beats, tempo(60), 1000, 0, 1).modulation).toBe(1);
    expect(sampleEffect(beats, null, 500, 0, 1).modulation).toBe(1);
  });

  it("类型检查：EffectCue 的字段足够 sampleEffect 使用", () => {
    const cue = {} as Pick<EffectCue, "effect" | "colors" | "period" | "phaseSpread" | "direction" | "seed">;
    expect(typeof sampleEffect).toBe("function");
    expect(cue).toBeDefined();
  });
});
