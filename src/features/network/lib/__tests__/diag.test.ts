import { describe, expect, it } from "vitest";

import { diagNeedsAttention, heapContiguity, pushSample, sortTasks, sparkPoints, stackLevel, toSample } from "../diag";
import type { Diag, TaskDiag } from "../types";

const task = (name: string, stackMin: number, cpu: number | null): TaskDiag => ({
  name,
  prio: 1,
  stackMin,
  core: 0,
  runtime: 0,
  cpuPermille: cpu,
});

describe("diag", () => {
  it("toSample 不统计 IDLE 任务，且上限 1000", () => {
    const diag = {
      heap: { free: 100, minFree: 50, largestBlock: 80, psramFree: 0 },
      tasks: [task("IDLE0", 5000, 500), task("a", 5000, 30), task("b", 5000, null), task("c", 5000, 20)],
      dmxUart: null,
      player: { state: 0, badFrames: 0 },
    } satisfies Diag;
    expect(toSample(diag, 7)).toEqual({ at: 7, heapFree: 100, cpuPermille: 50 });
    const huge = { ...diag, tasks: [task("x", 1, 900), task("y", 1, 900)] };
    expect(toSample(huge, 0).cpuPermille).toBe(1000);
  });

  it("pushSample 只保留最近 max 条且不修改原数组", () => {
    const base = [1, 2, 3].map((n) => ({ at: n, heapFree: n, cpuPermille: 0 }));
    const next = pushSample(base, { at: 4, heapFree: 4, cpuPermille: 0 }, 3);
    expect(next.map((s) => s.at)).toEqual([2, 3, 4]);
    expect(base).toHaveLength(3);
  });

  it("stackLevel 阈值", () => {
    expect(stackLevel(500)).toBe("danger");
    expect(stackLevel(1023)).toBe("danger");
    expect(stackLevel(1024)).toBe("low");
    expect(stackLevel(2047)).toBe("low");
    expect(stackLevel(2048)).toBe("ok");
  });

  it("sortTasks 栈余量升序，同余量 CPU 高的在前", () => {
    const sorted = sortTasks([task("a", 3000, 5), task("b", 500, 1), task("c", 500, 9), task("d", 1500, null)]);
    expect(sorted.map((t) => t.name)).toEqual(["c", "b", "d", "a"]);
  });

  it("heapContiguity 夹在 0~1", () => {
    expect(heapContiguity(100, 50)).toBe(0.5);
    expect(heapContiguity(100, 200)).toBe(1);
    expect(heapContiguity(0, 0)).toBe(1);
  });

  it("sparkPoints 生成按范围归一的点串", () => {
    expect(sparkPoints([1], 100, 10)).toBe("");
    expect(sparkPoints([0, 10], 100, 20)).toBe("0.0,20.0 100.0,0.0");
    expect(sparkPoints([5, 5, 5], 100, 10)).toBe("0.0,10.0 50.0,10.0 100.0,10.0");
    expect(sparkPoints([0, 500], 100, 10, 0, 1000)).toBe("0.0,10.0 100.0,5.0");
  });
});

describe("diagNeedsAttention", () => {
  const diag = (over: Partial<Diag> = {}): Diag => ({
    heap: { free: 100_000, minFree: 50_000, largestBlock: 80_000, psramFree: 1_000_000 },
    tasks: [task("main", 4096, 10)],
    dmxUart: { ports: 2, txTimeouts: 0 },
    player: { state: 0, badFrames: 0 },
    ...over,
  });

  it("一切正常时为 false", () => {
    expect(diagNeedsAttention(diag())).toBe(false);
    expect(diagNeedsAttention(diag({ dmxUart: null }))).toBe(false);
  });

  it("UART 发送超时或任务栈危险时为 true；栈偏低不算", () => {
    expect(diagNeedsAttention(diag({ dmxUart: { ports: 2, txTimeouts: 1 } }))).toBe(true);
    expect(diagNeedsAttention(diag({ tasks: [task("dmx", 512, 5)] }))).toBe(true);
    expect(diagNeedsAttention(diag({ tasks: [task("dmx", 1500, 5)] }))).toBe(false);
  });
});
