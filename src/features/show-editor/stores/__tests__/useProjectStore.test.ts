import { beforeEach, describe, expect, it } from "vitest";

import { addFixtures, createGroup, removeFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { selectDirty, useProjectStore } from "../useProjectStore";

const temporal = () => useProjectStore.temporal.getState();

beforeEach(() => {
  useProjectStore.getState().load(createEmptyProject("测试"));
});

describe("useProjectStore", () => {
  it("载入工程后历史为空、没有未保存修改", () => {
    expect(temporal().pastStates).toHaveLength(0);
    expect(selectDirty(useProjectStore.getState())).toBe(false);
  });

  it("编辑产生新快照并标记为未保存", () => {
    useProjectStore.getState().update((d) => {
      addFixtures(d, RGBW, 2);
    });
    const s = useProjectStore.getState();
    expect(s.project.fixtures).toHaveLength(2);
    expect(selectDirty(s)).toBe(true);
    expect(temporal().pastStates).toHaveLength(1);
  });

  it("撤销 / 重做", () => {
    const { update } = useProjectStore.getState();
    update((d) => {
      addFixtures(d, RGBW, 2);
    });
    update((d) => {
      addFixtures(d, RGBW, 1);
    });
    expect(useProjectStore.getState().project.fixtures).toHaveLength(3);

    temporal().undo();
    expect(useProjectStore.getState().project.fixtures).toHaveLength(2);
    temporal().undo();
    expect(useProjectStore.getState().project.fixtures).toHaveLength(0);
    expect(temporal().pastStates).toHaveLength(0);

    temporal().redo();
    expect(useProjectStore.getState().project.fixtures).toHaveLength(2);
    expect(temporal().futureStates).toHaveLength(1);
  });

  it("撤销回基线后不再算未保存修改", () => {
    useProjectStore.getState().update((d) => {
      addFixtures(d, RGBW, 1);
    });
    expect(selectDirty(useProjectStore.getState())).toBe(true);
    temporal().undo();
    expect(selectDirty(useProjectStore.getState())).toBe(false);
  });

  it("保存后以当前工程为基线，之后撤销又变成未保存", () => {
    const { update, markSaved } = useProjectStore.getState();
    update((d) => {
      addFixtures(d, RGBW, 1);
    });
    markSaved();
    expect(selectDirty(useProjectStore.getState())).toBe(false);
    temporal().undo();
    expect(selectDirty(useProjectStore.getState())).toBe(true);
  });

  it("没有实际变化的编辑不产生历史", () => {
    useProjectStore.getState().update(() => undefined);
    expect(temporal().pastStates).toHaveLength(0);
  });

  it("载入另一个工程会清空撤销历史", () => {
    useProjectStore.getState().update((d) => {
      addFixtures(d, RGBW, 1);
    });
    useProjectStore.getState().load(createEmptyProject("另一个"));
    expect(temporal().pastStates).toHaveLength(0);
    expect(temporal().futureStates).toHaveLength(0);
    expect(useProjectStore.getState().project.name).toBe("另一个");
  });

  it("编排一组操作：分组与删除都可逐步撤销", () => {
    const { update } = useProjectStore.getState();
    let ids: string[] = [];
    update((d) => {
      ids = addFixtures(d, RGBW, 3);
    });
    update((d) => {
      createGroup(d, "舞台", ids);
    });
    update((d) => removeFixtures(d, [ids[0]]));
    expect(useProjectStore.getState().project.groups[0].fixtureIds).toHaveLength(2);
    temporal().undo();
    expect(useProjectStore.getState().project.groups[0].fixtureIds).toHaveLength(3);
    temporal().undo();
    expect(useProjectStore.getState().project.groups).toHaveLength(0);
  });

  it("历史步数有上限", () => {
    const { update } = useProjectStore.getState();
    for (let i = 0; i < 230; i += 1) {
      update((d) => {
        d.notes = `n${i}`;
      });
    }
    expect(temporal().pastStates.length).toBe(200);
  });
});
