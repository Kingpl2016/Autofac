import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";

import { mergeNodes } from "../mergeNodes";

const node = (id: string, x: number, y: number, extra: Partial<Node> = {}): Node => ({
  id,
  position: { x, y },
  data: {},
  ...extra,
});

describe("mergeNodes", () => {
  it("没拖拽过的节点跟随新布局（来源增减时整列下移）", () => {
    const prev = [node("a", 0, 0), node("b", 0, 96)];
    const next = [node("new", 0, 0), node("a", 0, 96), node("b", 0, 192)];
    const merged = mergeNodes(prev, next, {});
    expect(merged.map((n) => n.position.y)).toEqual([0, 96, 192]);
  });

  it("拖拽过的节点保持用户放的位置", () => {
    const prev = [node("a", 10, 10)];
    const next = [node("a", 0, 0), node("b", 0, 96)];
    const merged = mergeNodes(prev, next, { a: { x: 300, y: 200 } });
    expect(merged[0].position).toEqual({ x: 300, y: 200 });
    expect(merged[1].position).toEqual({ x: 0, y: 96 });
  });

  it("保留已测量的尺寸，避免重复测量", () => {
    const prev = [node("a", 0, 0, { measured: { width: 224, height: 64 }, width: 224, height: 64 })];
    const merged = mergeNodes(prev, [node("a", 0, 0)], {});
    expect(merged[0].measured).toEqual({ width: 224, height: 64 });
    expect(merged[0].width).toBe(224);
  });

  it("新节点没有旧尺寸；被移除的节点不再出现；不修改入参", () => {
    const prev = [node("gone", 0, 0)];
    const next = [node("fresh", 5, 5)];
    const merged = mergeNodes(prev, next, {});
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("fresh");
    expect(merged[0].measured).toBeUndefined();
    expect(next[0].position).toEqual({ x: 5, y: 5 });
  });

  it("新节点如果在拖拽记录里，也使用记录的位置", () => {
    const merged = mergeNodes([], [node("a", 0, 0)], { a: { x: 9, y: 9 } });
    expect(merged[0].position).toEqual({ x: 9, y: 9 });
  });
});