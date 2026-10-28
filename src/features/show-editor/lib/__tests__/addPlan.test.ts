import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { applyAddPlan, formatFixtureName, MAX_ADD_COUNT, planAddFixtures } from "../addPlan";
import { addFixtures } from "../ops";
import { analyzePatch } from "../patch";
import { createEmptyProject, MAX_UNIVERSE } from "../project";
import { DIMMER, RGBW } from "./testkit";

describe("批量添加计划", () => {
  it("自动地址：接着已有灯具排，合并成连续区间", () => {
    const p = produce(createEmptyProject("t"), (d) => void addFixtures(d, RGBW, 3));
    const plan = planAddFixtures(p, RGBW, { count: 4 });
    expect(plan.items.map((i) => i.address)).toEqual([13, 17, 21, 25]);
    expect(plan.items.map((i) => i.name)).toEqual(["RGBW全彩灯 4", "RGBW全彩灯 5", "RGBW全彩灯 6", "RGBW全彩灯 7"]);
    expect(plan.ranges).toEqual([{ universe: 0, start: 13, end: 28 }]);
    expect(plan.shifted).toBe(false);
  });

  it("给定起点被占用时顺延到其后的空位，并标记 shifted", () => {
    const p = produce(createEmptyProject("t"), (d) => void addFixtures(d, RGBW, 2));
    const plan = planAddFixtures(p, RGBW, { count: 2, start: { universe: 0, address: 3 } });
    expect(plan.items.map((i) => i.address)).toEqual([9, 13]);
    expect(plan.shifted).toBe(true);
    const free = planAddFixtures(p, RGBW, { count: 1, start: { universe: 1, address: 100 } });
    expect(free.items[0]).toMatchObject({ universe: 1, address: 100 });
    expect(free.shifted).toBe(false);
  });

  it("间隔、名称模板与跨 Universe", () => {
    const p = createEmptyProject("t");
    const plan = planAddFixtures(p, RGBW, { count: 3, gap: 2, nameTemplate: "前排 {n}" });
    expect(plan.items.map((i) => i.address)).toEqual([1, 7, 13]);
    expect(plan.items.map((i) => i.name)).toEqual(["前排 1", "前排 2", "前排 3"]);
    expect(plan.ranges).toHaveLength(3);
    const wrap = planAddFixtures(p, RGBW, { count: 2, start: { universe: 0, address: 510 } });
    expect(wrap.items.map((i) => [i.universe, i.address])).toEqual([
      [1, 1],
      [1, 5],
    ]);
  });

  it("数量夹取；Universe 用尽时只放得下一部分", () => {
    const p = createEmptyProject("t");
    expect(planAddFixtures(p, DIMMER, { count: 9999 }).requested).toBe(MAX_ADD_COUNT);
    expect(planAddFixtures(p, DIMMER, { count: 0 }).requested).toBe(1);
    const last = planAddFixtures(p, RGBW, { count: 3, start: { universe: MAX_UNIVERSE, address: 505 } });
    expect(last.items).toHaveLength(2);
    expect(last.requested).toBe(3);
  });

  it("名称模板：缺少 {n} 时多台补序号", () => {
    expect(formatFixtureName("面光", 3, true)).toBe("面光 3");
    expect(formatFixtureName("面光", 3, false)).toBe("面光");
    expect(formatFixtureName("L{n}-{n}", 2, true)).toBe("L2-2");
  });

  it("舞台落点：排成一排、夹在舞台内；执行后为一步并写入模式与位置", () => {
    const p = createEmptyProject("t");
    const plan = planAddFixtures(p, RGBW, { count: 3, stagePoint: { x: 0, y: 2 } });
    expect(plan.items.map((i) => i.stage)).toEqual([
      { x: -0.5, y: 2 },
      { x: 0, y: 2 },
      { x: 0.5, y: 2 },
    ]);
    const edge = planAddFixtures(p, RGBW, { count: 1, stagePoint: { x: 999, y: -50 } });
    expect(edge.items[0].stage?.x).toBeLessThanOrEqual(p.stage.width / 2 + 1);
    expect(edge.items[0].stage?.y).toBe(-1);

    const next = produce(p, (d) => void applyAddPlan(d, RGBW, plan));
    expect(next.fixtures).toHaveLength(3);
    expect(next.tracks).toHaveLength(3);
    expect(next.fixtures[1].stage).toEqual({ x: 0, y: 2 });
    expect([...analyzePatch(next).values()].every((s) => s.conflictsWith.length === 0)).toBe(true);
  });

  it("模式：只接受模型里存在的模式，按模式的通道数排布", () => {
    const model = { ...RGBW, id: "m8", modes: [{ id: "8ch", name: "8ch", properties: [{ ...RGBW.properties[0], channel: 8 }] }] };
    const p = createEmptyProject("t");
    const plan = planAddFixtures(p, model, { count: 2, modeId: "8ch" });
    expect(plan.footprint).toBe(8);
    expect(plan.items.map((i) => i.address)).toEqual([1, 9]);
    expect(planAddFixtures(p, model, { count: 1, modeId: "nope" }).modeId).toBeUndefined();
    const next = produce(p, (d) => void applyAddPlan(d, model, plan));
    expect(next.fixtures.every((f) => f.modeId === "8ch")).toBe(true);
  });
});
