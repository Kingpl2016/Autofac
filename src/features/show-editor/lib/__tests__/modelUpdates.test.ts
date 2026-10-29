import { produce } from "immer";
import { describe, expect, it } from "vitest";

import type { FixtureModel } from "@/features/fixtures";
import { addFixtures } from "../ops";
import { applySnapshotUpdates, snapshotUpdates } from "../modelUpdates";
import { createEmptyProject } from "../project";
import { HEAD16, prop, RGBW } from "./testkit";

/** 带一个附加模式的摇头灯。 */
const moving: FixtureModel = {
  ...HEAD16,
  id: "ofl:acme/spot",
  modes: [{ id: "9ch", name: "9 通道", properties: HEAD16.properties.slice(0, 2) }],
};

describe("模型快照更新", () => {
  it("快照与库一致时没有更新；字段顺序和缺省字段不影响比较", () => {
    const p = produce(createEmptyProject("t"), (d) => void addFixtures(d, RGBW, 2));
    const { properties, ...rest } = RGBW;
    // 键顺序不同、多一个值为 undefined 的字段
    const reordered: FixtureModel = { emitters: undefined, ...rest, properties };
    expect(snapshotUpdates(p, [reordered])).toEqual([]);
    // 库里没有的模型（已删除）不提示
    expect(snapshotUpdates(p, [])).toEqual([]);
  });

  it("列出通道、模式与功能变化，替换后用已删除模式的灯具回到默认模式", () => {
    let p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, moving, 2);
      d.fixtures[0].modeId = "9ch";
    });
    const next: FixtureModel = {
      ...moving,
      name: "Spot v2",
      properties: [...moving.properties, prop("Gobo", "gobo", 17)],
      modes: [{ id: "10ch", name: "10 通道", properties: moving.properties.slice(0, 3) }],
    };
    const [u] = snapshotUpdates(p, [next]);
    expect(u).toMatchObject({
      modelId: "ofl:acme/spot",
      name: "Spot v2",
      channels: [16, 17],
      modesAdded: ["10 通道"],
      modesRemoved: ["9 通道"],
      changedChannels: 1,
      fixtures: 2,
    });

    let reset: string[] = [];
    p = produce(p, (d) => {
      reset = applySnapshotUpdates(d, [next]);
    });
    expect(reset).toEqual([p.fixtures[0].id]);
    expect(p.fixtures[0].modeId).toBeUndefined();
    expect(p.fixtureModels.find((m) => m.id === next.id)?.name).toBe("Spot v2");
    expect(snapshotUpdates(p, [next])).toEqual([]);
  });

  it("再次添加同型号时同样会刷新快照并修正失效的模式", () => {
    let p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, moving, 1);
      d.fixtures[0].modeId = "9ch";
    });
    const next: FixtureModel = { ...moving, modes: [] };
    p = produce(p, (d) => void addFixtures(d, next, 1));
    expect(p.fixtures).toHaveLength(2);
    expect(p.fixtures[0].modeId).toBeUndefined();
  });
});
