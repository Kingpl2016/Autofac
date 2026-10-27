import { describe, expect, it } from "vitest";

import {
  gapsOf,
  MIN_SEGMENT_US,
  normalizeSegments,
  previewJumpTarget,
  removeSegment,
  setInPoint,
  setOutPoint,
  splitAt,
  totalDuration,
  trimSegment,
  type Segment,
} from "../segments";

const seg = (id: string, startUs: number, endUs: number): Segment => ({ id, startUs, endUs });
const spans = (s: readonly { startUs: number; endUs: number }[]) => s.map((x) => [x.startUs, x.endUs]);

describe("规整片段（与后端 normalize_segments 共用用例）", () => {
  it.each([
    [[[500, 900], [0, 100], [80, 200], [950, 2000], [300, 300]], 1000, [[0, 200], [500, 900], [950, 1000]]],
    [[[0, 100], [100, 200]], 1000, [[0, 200]]],
    [[[1500, 2000]], 1000, []],
    [[], 1000, []],
  ])("%j / 时长 %d → %j", (input, duration, expected) => {
    const out = normalizeSegments(input.map(([startUs, endUs]) => ({ startUs, endUs })), duration);
    expect(spans(out)).toEqual(expected);
  });
});

describe("片段编辑", () => {
  const d = 10_000_000;
  const base = [seg("a", 0, d)];

  it("切割：一分为二；离端点太近不切", () => {
    const { segments, rightId } = splitAt(base, 4_000_000);
    expect(spans(segments)).toEqual([[0, 4_000_000], [4_000_000, d]]);
    expect(rightId).toBe(segments[1].id);
    expect(splitAt(base, MIN_SEGMENT_US / 2).rightId).toBeNull();
  });

  it("删除片段留下间隙，结果时长随之减少；只剩一个片段时不删", () => {
    const { segments } = splitAt(splitAt(base, 3_000_000).segments, 6_000_000);
    const removed = removeSegment(segments, segments[1].id);
    expect(spans(removed)).toEqual([[0, 3_000_000], [6_000_000, d]]);
    expect(totalDuration(removed)).toBe(7_000_000);
    expect(spans(gapsOf(removed, d))).toEqual([[3_000_000, 6_000_000]]);
    expect(removeSegment(base, "a")).toHaveLength(1);
  });

  it("修剪不越过相邻片段，也不短于最短长度", () => {
    const two = [seg("a", 0, 3_000_000), seg("b", 5_000_000, d)];
    expect(trimSegment(two, "b", "start", 1_000_000, d)[1].startUs).toBe(3_000_000);
    expect(trimSegment(two, "a", "end", 9_000_000, d)[0].endUs).toBe(5_000_000);
    expect(trimSegment(two, "a", "end", 0, d)[0].endUs).toBe(MIN_SEGMENT_US);
    expect(trimSegment(two, "b", "end", 99_000_000, d)[1].endUs).toBe(d);
  });

  it("入点 / 出点裁掉两端，跨过的片段被删掉", () => {
    const two = [seg("a", 0, 3_000_000), seg("b", 5_000_000, d)];
    expect(spans(setInPoint(two, 4_000_000))).toEqual([[5_000_000, d]]);
    expect(spans(setInPoint(two, 1_000_000))).toEqual([[1_000_000, 3_000_000], [5_000_000, d]]);
    expect(spans(setOutPoint(two, 6_000_000))).toEqual([[0, 3_000_000], [5_000_000, 6_000_000]]);
    // 会把内容全部裁掉时保持原样
    expect(spans(setOutPoint(two, 0))).toEqual(spans(two));
  });

  it("预览跳转：间隙里跳到下一片段，末尾回到第一片段", () => {
    const two = [seg("a", 1_000_000, 3_000_000), seg("b", 5_000_000, 8_000_000)];
    expect(previewJumpTarget(two, 2_000_000)).toBeNull();
    expect(previewJumpTarget(two, 3_000_000)).toBe(5_000_000);
    expect(previewJumpTarget(two, 0)).toBe(1_000_000);
    expect(previewJumpTarget(two, 8_000_000)).toBe(1_000_000);
  });
});
