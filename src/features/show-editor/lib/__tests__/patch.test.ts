import { describe, expect, it } from "vitest";

import { analyzePatch, footprintOf, nextFreeSlot, usedUniverses } from "../patch";
import type { FixtureInstance } from "../project";
import { DIMMER, HEAD16, RGBW } from "./testkit";

const fx = (id: string, modelId: string, universe: number, address: number): FixtureInstance => ({
  id,
  name: id,
  modelId,
  universe,
  address,
});

const models = [RGBW, DIMMER, HEAD16];

describe("footprintOf", () => {
  it("取模型占用的通道数，缺失时按 1", () => {
    expect(footprintOf(RGBW)).toBe(4);
    expect(footprintOf(HEAD16)).toBe(16);
    expect(footprintOf(undefined)).toBe(1);
  });

  it("按灯具选用的通道模式计算，模式不存在时按 1", () => {
    const twoModes = {
      ...RGBW,
      modes: [{ id: "8ch", name: "8ch", properties: [{ ...RGBW.properties[0], channel: 8 }] }],
    };
    expect(footprintOf(twoModes)).toBe(4);
    expect(footprintOf(twoModes, "8ch")).toBe(8);
    expect(footprintOf(twoModes, "ghost")).toBe(1);
  });
});

describe("analyzePatch", () => {
  it("相邻不重叠的灯具没有冲突", () => {
    const status = analyzePatch({
      fixtureModels: models,
      fixtures: [fx("a", RGBW.id, 0, 1), fx("b", RGBW.id, 0, 5)],
    });
    expect(status.get("a")?.range).toEqual({ universe: 0, start: 1, end: 4 });
    expect(status.get("a")?.conflictsWith).toEqual([]);
    expect(status.get("b")?.range).toEqual({ universe: 0, start: 5, end: 8 });
  });

  it("同一 Universe 内重叠的灯具互相标记冲突，不同 Universe 不算", () => {
    const status = analyzePatch({
      fixtureModels: models,
      fixtures: [fx("a", RGBW.id, 0, 1), fx("b", RGBW.id, 0, 3), fx("c", RGBW.id, 1, 3)],
    });
    expect(status.get("a")?.conflictsWith).toEqual(["b"]);
    expect(status.get("b")?.conflictsWith).toEqual(["a"]);
    expect(status.get("c")?.conflictsWith).toEqual([]);
  });

  it("一个灯具可以同时与多个灯具冲突", () => {
    const status = analyzePatch({
      fixtureModels: models,
      fixtures: [fx("big", HEAD16.id, 0, 1), fx("x", DIMMER.id, 0, 2), fx("y", DIMMER.id, 0, 10)],
    });
    expect(status.get("big")?.conflictsWith.sort()).toEqual(["x", "y"]);
  });

  it("超出 512 通道标记越界，缺少模型标记缺失", () => {
    const status = analyzePatch({
      fixtureModels: models,
      fixtures: [fx("a", RGBW.id, 0, 510), fx("b", "9.9.9.9", 0, 1)],
    });
    expect(status.get("a")?.overflow).toBe(true);
    expect(status.get("b")?.missingModel).toBe(true);
    expect(status.get("b")?.range).toBeNull();
  });
});

describe("nextFreeSlot", () => {
  it("空工程从 Universe 0 的地址 1 开始", () => {
    expect(nextFreeSlot({ fixtures: [], fixtureModels: [] }, 4)).toEqual({ universe: 0, address: 1 });
  });

  it("接在已有灯具之后", () => {
    expect(nextFreeSlot({ fixtureModels: models, fixtures: [fx("a", RGBW.id, 0, 1)] }, 4)).toEqual({
      universe: 0,
      address: 5,
    });
  });

  it("优先填补中间的空隙", () => {
    const project = { fixtureModels: models, fixtures: [fx("a", RGBW.id, 0, 1), fx("b", RGBW.id, 0, 9)] };
    expect(nextFreeSlot(project, 4)).toEqual({ universe: 0, address: 5 });
    // 空隙只有 4 个通道，放不下 5 个时跳到末尾
    expect(nextFreeSlot(project, 5)).toEqual({ universe: 0, address: 13 });
  });

  it("当前 Universe 放不下时进入下一个", () => {
    // 32 台 16 通道摇头灯正好占满 Universe 0 的 512 个通道
    const fixtures = Array.from({ length: 32 }, (_, i) => fx(`h${i}`, HEAD16.id, 0, i * 16 + 1));
    expect(nextFreeSlot({ fixtureModels: models, fixtures }, 1)).toEqual({ universe: 1, address: 1 });
    // 末尾剩 8 个通道：放得下 4 个，放不下 16 个
    const tail = fixtures.slice(0, 31);
    const partial = { fixtureModels: models, fixtures: [...tail, fx("t", RGBW.id, 0, 497)] };
    expect(nextFreeSlot(partial, 4)).toEqual({ universe: 0, address: 501 });
    expect(nextFreeSlot(partial, 16)).toEqual({ universe: 1, address: 1 });
  });

  it("所有 Universe 都放不下时返回 null", () => {
    // 只在最后一个 Universe 能放下的请求：从它开始搜索，且它已被占满
    const full = Array.from({ length: 32 }, (_, i) => fx(`h${i}`, HEAD16.id, 2047, i * 16 + 1));
    expect(nextFreeSlot({ fixtureModels: models, fixtures: full }, 1, 2047)).toBeNull();
  });

  it("从指定 Universe 开始搜索", () => {
    expect(nextFreeSlot({ fixtures: [], fixtureModels: [] }, 4, 3)).toEqual({ universe: 3, address: 1 });
  });

  it("非法的占用数返回 null", () => {
    expect(nextFreeSlot({ fixtures: [], fixtureModels: [] }, 0)).toBeNull();
    expect(nextFreeSlot({ fixtures: [], fixtureModels: [] }, 513)).toBeNull();
  });
});

describe("usedUniverses", () => {
  it("升序去重", () => {
    expect(usedUniverses([fx("a", RGBW.id, 3, 1), fx("b", RGBW.id, 1, 1), fx("c", RGBW.id, 3, 9)])).toEqual([1, 3]);
  });
});
