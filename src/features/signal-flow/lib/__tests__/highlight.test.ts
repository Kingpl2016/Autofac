import { describe, expect, it } from "vitest";

import { relatedTo } from "../highlight";

// S1 -> U1 -> D1
// S1 -> U2 -> D1
// S2 -> U2
// U2 -> D2
const graph = {
  nodes: ["S1", "S2", "U1", "U2", "D1", "D2", "Lone"].map((id) => ({ id })),
  edges: [
    { id: "S1>U1", source: "S1", target: "U1" },
    { id: "S1>U2", source: "S1", target: "U2" },
    { id: "S2>U2", source: "S2", target: "U2" },
    { id: "U1>D1", source: "U1", target: "D1" },
    { id: "U2>D1", source: "U2", target: "D1" },
    { id: "U2>D2", source: "U2", target: "D2" },
  ],
};

const ids = (s: ReadonlySet<string>) => [...s].sort();

describe("relatedTo 节点", () => {
  it("中间节点：全部上游来源与下游目的地，以及它们之间的边", () => {
    const r = relatedTo(graph, { kind: "node", id: "U2" });
    expect(ids(r.nodes)).toEqual(["D1", "D2", "S1", "S2", "U2"]);
    expect(ids(r.edges)).toEqual(["S1>U2", "S2>U2", "U2>D1", "U2>D2"]);
  });

  it("不会把兄弟路径带进来", () => {
    const r = relatedTo(graph, { kind: "node", id: "U1" });
    expect(ids(r.nodes)).toEqual(["D1", "S1", "U1"]);
    expect(r.edges.has("S1>U2")).toBe(false);
    expect(r.edges.has("U2>D1")).toBe(false);
  });

  it("来源节点：它能流到的所有下游", () => {
    const r = relatedTo(graph, { kind: "node", id: "S2" });
    expect(ids(r.nodes)).toEqual(["D1", "D2", "S2", "U2"]);
    expect(ids(r.edges)).toEqual(["S2>U2", "U2>D1", "U2>D2"]);
  });

  it("目的地节点：流向它的所有上游", () => {
    const r = relatedTo(graph, { kind: "node", id: "D2" });
    expect(ids(r.nodes)).toEqual(["D2", "S1", "S2", "U2"]);
    expect(ids(r.edges)).toEqual(["S1>U2", "S2>U2", "U2>D2"]);
  });

  it("孤立节点只有自己", () => {
    const r = relatedTo(graph, { kind: "node", id: "Lone" });
    expect(ids(r.nodes)).toEqual(["Lone"]);
    expect(r.edges.size).toBe(0);
  });
});

describe("relatedTo 边", () => {
  it("取起点的上游、终点的下游和这条边本身", () => {
    const r = relatedTo(graph, { kind: "edge", id: "U2>D2" });
    expect(ids(r.nodes)).toEqual(["D2", "S1", "S2", "U2"]);
    expect(ids(r.edges)).toEqual(["S1>U2", "S2>U2", "U2>D2"]);
  });

  it("不含起点的其它下游（同级兄弟边）", () => {
    const r = relatedTo(graph, { kind: "edge", id: "S1>U1" });
    expect(ids(r.nodes)).toEqual(["D1", "S1", "U1"]);
    expect(r.edges.has("S1>U2")).toBe(false);
  });

  it("边不存在时只返回该 id，不抛错", () => {
    const r = relatedTo(graph, { kind: "edge", id: "nope" });
    expect(r.nodes.size).toBe(0);
    expect(ids(r.edges)).toEqual(["nope"]);
  });
});