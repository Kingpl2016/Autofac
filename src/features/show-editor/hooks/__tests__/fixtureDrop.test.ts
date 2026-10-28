import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { useFixtureStore } from "@/features/fixtures";
import i18n from "@/shared/i18n";
import { RGBW } from "../../lib/__tests__/testkit";
import { createEmptyProject } from "../../lib/project";
import { useProjectStore } from "../../stores/useProjectStore";
import { dropFixtureModel, resolveFixtureDrop, STAGE_DROP_ID } from "../fixtureDrop";

const rect = { left: 100, width: 512 };

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  toast.mockReset();
  toast.error.mockReset();
  useProjectStore.getState().load(createEmptyProject("t"));
  useFixtureStore.setState({ models: [RGBW], status: "ready", error: null });
});

describe("灯具模型的放置", () => {
  it("时间线、舞台与非灯具目标", () => {
    expect(resolveFixtureDrop({ id: "timeline", rect }, { x: 0, y: 0 }, "timeline")).toEqual({ kind: "timeline" });
    const stage = { kind: "stage", toStagePoint: (x: number, y: number) => ({ x: x / 100, y: y / 100 }) };
    expect(resolveFixtureDrop({ id: STAGE_DROP_ID, rect, data: { current: stage } }, { x: 150, y: 300 }, "timeline")).toEqual({
      kind: "stage",
      point: { x: 1.5, y: 3 },
    });
    expect(resolveFixtureDrop({ id: "x", rect }, { x: 0, y: 0 }, "timeline")).toBeNull();
    expect(resolveFixtureDrop(null, { x: 0, y: 0 }, "timeline")).toBeNull();
  });

  it("Universe 卡片：优先用占用条的实际位置，量不到时按卡片宽度近似并夹取", () => {
    const exact = { kind: "universe", universe: 2, addressAt: () => 77 };
    expect(resolveFixtureDrop({ id: "universe:2", rect, data: { current: exact } }, { x: 0, y: 0 }, "timeline")).toEqual({
      kind: "universe",
      universe: 2,
      address: 77,
    });
    const rough = { kind: "universe", universe: 1, addressAt: () => null };
    const at = (x: number) => resolveFixtureDrop({ id: "universe:1", rect, data: { current: rough } }, { x, y: 0 }, "timeline");
    expect(at(100)).toMatchObject({ address: 1 });
    expect(at(100 + 256)).toMatchObject({ address: 257 });
    expect(at(9999)).toMatchObject({ address: 512 });
    expect(at(-50)).toMatchObject({ address: 1 });
  });

  it("放下后添加一台：Universe 被占用时顺延并提示；舞台放在落点", () => {
    dropFixtureModel(RGBW.id, { kind: "universe", universe: 3, address: 10 });
    dropFixtureModel(RGBW.id, { kind: "universe", universe: 3, address: 11 });
    const [a, b] = useProjectStore.getState().project.fixtures;
    expect([a.universe, a.address]).toEqual([3, 10]);
    expect([b.universe, b.address]).toEqual([3, 14]);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining("顺延到 U3.14"), expect.anything());

    dropFixtureModel(RGBW.id, { kind: "stage", point: { x: 1, y: 2 } });
    expect(useProjectStore.getState().project.fixtures[2].stage).toEqual({ x: 1, y: 2 });
    expect(useProjectStore.getState().project.tracks).toHaveLength(3);
    expect(dropFixtureModel("nope", { kind: "timeline" })).toBeNull();
  });
});
