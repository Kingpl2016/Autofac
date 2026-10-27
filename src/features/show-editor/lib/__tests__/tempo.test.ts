import { describe, expect, it } from "vitest";

import type { Tempo } from "../project";
import {
  beatDurationMs,
  beatsBetween,
  beatsToMs,
  MAX_BPM,
  MIN_BPM,
  tapTempo,
} from "../tempo";

const tempo = (over: Partial<Tempo> = {}): Tempo => ({ bpm: 120, offsetMs: 0, beatsPerBar: 4, ...over });

describe("beatsBetween", () => {
  it("120 BPM 每 500ms 一拍，每 4 拍一个小节线", () => {
    const beats = beatsBetween(tempo(), 0, 2000);
    expect(beats.map((b) => b.timeMs)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(beats.map((b) => b.isBar)).toEqual([true, false, false, false, true]);
    expect(beats.map((b) => b.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("偏移让第一拍后移，偏移之前的拍点也会补出来（序号为负）", () => {
    const beats = beatsBetween(tempo({ offsetMs: 300 }), 0, 1500);
    expect(beats.map((b) => b.timeMs)).toEqual([300, 800, 1300]);
    const early = beatsBetween(tempo({ offsetMs: 1200 }), 0, 1500);
    expect(early.map((b) => [b.timeMs, b.index, b.isBar])).toEqual([
      [200, -2, false],
      [700, -1, false],
      [1200, 0, true],
    ]);
  });

  it("只返回区间内且不小于 0 的拍点；区间外为空", () => {
    expect(beatsBetween(tempo(), 750, 1250).map((b) => b.timeMs)).toEqual([1000]);
    expect(beatsBetween(tempo(), -1000, 400).map((b) => b.timeMs)).toEqual([0]);
    expect(beatsBetween(tempo(), 5000, 4000)).toEqual([]);
  });

  it("限制最大数量，避免缩得很小时生成海量线条", () => {
    expect(beatsBetween(tempo({ bpm: 300 }), 0, 3_600_000, 100)).toHaveLength(100);
  });

  it("每小节拍数影响小节线", () => {
    const beats = beatsBetween(tempo({ beatsPerBar: 3 }), 0, 3000);
    expect(beats.filter((b) => b.isBar).map((b) => b.timeMs)).toEqual([0, 1500, 3000]);
  });
});

describe("tapTempo", () => {
  it("按平均间隔估算 BPM", () => {
    expect(tapTempo([0, 500, 1000, 1500])).toBe(120);
    expect(tapTempo([0, 600, 1200])).toBe(100);
  });

  it("不足两次敲击没有结果", () => {
    expect(tapTempo([])).toBeNull();
    expect(tapTempo([1000])).toBeNull();
  });

  it("超过 2 秒的间隔视为重新开始", () => {
    expect(tapTempo([0, 300, 600, 5000, 5500, 6000])).toBe(120);
    expect(tapTempo([0, 5000])).toBeNull();
  });

  it("只看最近 8 次；结果夹在合法范围并保留一位小数", () => {
    const slowThenFast = [0, 1000, 2000, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500];
    expect(tapTempo(slowThenFast)).toBe(120);
    expect(tapTempo([0, 10, 20])).toBe(MAX_BPM);
    expect(tapTempo([0, 1999, 3998])).toBe(30);
    expect(tapTempo([0, 1000, 2000])).toBeGreaterThanOrEqual(MIN_BPM);
    expect(tapTempo([0, 480, 960, 1440])).toBe(125);
    expect(tapTempo([0, 333, 666])).toBe(180.2);
  });

  it("时间不前进的敲击没有结果", () => {
    expect(tapTempo([1000, 1000])).toBeNull();
  });
});

describe("拍数换算", () => {
  it("一拍时长与拍数转毫秒", () => {
    expect(beatDurationMs(120)).toBe(500);
    expect(beatsToMs(2, 120)).toBe(1000);
    expect(beatsToMs(0.5, 90)).toBe(333);
  });
});
