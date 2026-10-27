import { describe, expect, it } from "vitest";

import {
  activityAsOverview,
  axisSpanUs,
  collapseRows,
  dataWidth,
  decodeActivity,
  headX,
  mergeActivity,
} from "../recordTimeline";
import type { ActivityDto } from "../types";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

const dto = (over: Partial<ActivityDto> = {}): ActivityDto => ({
  generation: 0,
  bucketUs: 250_000,
  len: 3,
  from: 0,
  universes: [1, 2],
  change: [b64([1, 2, 3]), b64([0, 0, 9])],
  level: [b64([10, 20, 30]), b64([0, 0, 90])],
  partStartsUs: [0],
  ...over,
});

describe("decodeActivity / mergeActivity", () => {
  it("全量解码并把行补齐到总桶数", () => {
    const a = decodeActivity(dto({ len: 4 }));
    expect(a.len).toBe(4);
    expect([...a.change[0]]).toEqual([1, 2, 3, 0]);
    expect([...a.level[1]]).toEqual([0, 0, 90, 0]);
  });

  it("同代次增量从 from 处覆盖到末尾，前面的桶保持不变", () => {
    const base = decodeActivity(dto());
    const next = mergeActivity(
      base,
      dto({ from: 2, len: 5, change: [b64([7, 8, 9]), b64([1, 1, 1])], level: [b64([5, 6, 7]), b64([4, 4, 4])], partStartsUs: [0, 500_000] }),
    )!;
    expect([...next.change[0]]).toEqual([1, 2, 7, 8, 9]);
    expect([...next.level[1]]).toEqual([0, 0, 4, 4, 4]);
    expect(next.partStartsUs).toEqual([0, 500_000]);
    // 不修改原对象
    expect(base.len).toBe(3);
  });

  it("from = 0 总是全量替换（新录制 / 后端合并过桶）", () => {
    const base = decodeActivity(dto());
    const next = mergeActivity(base, dto({ generation: 3, bucketUs: 2_000_000, len: 1, change: [b64([4]), b64([5])], level: [b64([6]), b64([7])] }))!;
    expect(next.generation).toBe(3);
    expect(next.len).toBe(1);
  });

  it("无法合并时返回 null：本地为空、代次不一致或 Universe 集合变化", () => {
    const base = decodeActivity(dto());
    expect(mergeActivity(null, dto({ from: 1 }))).toBeNull();
    expect(mergeActivity(base, dto({ from: 1, generation: 1 }))).toBeNull();
    expect(mergeActivity(base, dto({ from: 1, universes: [1, 3] }))).toBeNull();
    expect(mergeActivity(base, dto({ from: 9, len: 10 }))).toBeNull();
  });
});

describe("时间轴与录制头", () => {
  it("时间轴按 1 / 5 / 10 / 30 / 60 分钟分档，之后按整小时递增", () => {
    const min = 60_000_000;
    expect(axisSpanUs(0)).toBe(min);
    expect(axisSpanUs(59 * 1_000_000)).toBe(min);
    expect(axisSpanUs(min)).toBe(5 * min);
    expect(axisSpanUs(7 * min)).toBe(10 * min);
    expect(axisSpanUs(29 * min)).toBe(30 * min);
    expect(axisSpanUs(45 * min)).toBe(60 * min);
    expect(axisSpanUs(61 * min)).toBe(120 * min);
  });

  it("录制头与数据宽度按轴长换算像素", () => {
    expect(headX(30_000_000, 600, 60_000_000)).toBe(300);
    const a = decodeActivity(dto({ len: 40 })); // 40 × 0.25s = 10s
    expect(dataWidth(a, 600, 60_000_000)).toBe(100);
    expect(dataWidth(null, 600, 60_000_000)).toBe(0);
    expect(dataWidth(decodeActivity(dto({ len: 1000 })), 600, 60_000_000)).toBe(600);
  });

  it("活动时间线可当作概览复用热力图；多行可合成一行", () => {
    const o = activityAsOverview(decodeActivity(dto()));
    expect(o.buckets).toBe(3);
    expect(o.durationUs).toBe(750_000);
    const merged = collapseRows([Float32Array.from([0.1, 0.9]), Float32Array.from([0.5, 0.2])]);
    expect(merged).toHaveLength(1);
    expect([...merged[0]].map((v) => Math.round(v * 10) / 10)).toEqual([0.5, 0.9]);
    expect(collapseRows([])).toEqual([]);
  });
});
