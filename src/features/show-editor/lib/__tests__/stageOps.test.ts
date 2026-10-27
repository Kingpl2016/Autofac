import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { placeFixtures } from "../../stage/stageGeometry";
import { addFixtures } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import {
  addStageObject,
  arrangeFixtures,
  clampToStage,
  materializePlacements,
  moveFixtures,
  normalizeDeg,
  removeStageObject,
  resetPlacements,
  setFixturePlacement,
  setStageBackground,
  setStageSize,
  snap,
  STAGE_SIZE_RANGE,
  updateStageObject,
} from "../stageOps";
import { RGBW } from "./testkit";

function base(n = 4): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, n);
  });
}
const ids = (p: ShowProject) => p.fixtures.map((f) => f.id);
const at = (p: ShowProject, i: number) => p.fixtures[i].stage!;

describe("舞台布置操作", () => {
  it("snap / normalizeDeg / clampToStage", () => {
    expect(snap(1.13, 0.25)).toBe(1.25);
    expect(snap(-0.1, 0.25)).toBe(0);
    expect(Object.is(snap(-0.1, 0.25), -0)).toBe(false);
    expect(snap(1.13, 0)).toBe(1.13);
    expect(normalizeDeg(190)).toBe(-170);
    expect(normalizeDeg(-180)).toBe(180);
    expect(normalizeDeg(720)).toBe(0);
    expect(clampToStage({ width: 10, depth: 6 }, 100, -100)).toEqual({ x: 6, y: -1 });
  });

  it("舞台尺寸夹到范围内，非数字忽略", () => {
    const p = produce(base(), (d) => setStageSize(d, 0, 500));
    expect(p.stage).toMatchObject({ width: STAGE_SIZE_RANGE.min, depth: STAGE_SIZE_RANGE.max });
    const q = produce(p, (d) => setStageSize(d, Number.NaN, 10));
    expect(q.stage).toMatchObject({ width: STAGE_SIZE_RANGE.min, depth: 10 });
  });

  it("第一次摆位前把其余灯固定在自动排布位置，避免它们跳动", () => {
    const p = base();
    const auto = placeFixtures(p.fixtures, p.stage);
    const q = produce(p, (d) => moveFixtures(d, [ids(p)[0]], 1, 0));
    for (let i = 1; i < 4; i += 1) {
      const a = auto.get(ids(p)[i])!;
      expect(at(q, i).x).toBeCloseTo(a.x, 2);
      expect(at(q, i).y).toBeCloseTo(a.y, 2);
    }
    expect(at(q, 0).x).toBeCloseTo(auto.get(ids(p)[0])!.x + 1, 2);
    // 全部都有位置时不再改动
    const r = produce(q, (d) => materializePlacements(d));
    expect(r).toBe(q);
  });

  it("整组平移：吸附作用于第一台，其余保持相对位置；越界被夹住", () => {
    const p = produce(base(2), (d) => {
      d.fixtures[0].stage = { x: 0.1, y: 1 };
      d.fixtures[1].stage = { x: 1.1, y: 2 };
    });
    const q = produce(p, (d) => moveFixtures(d, ids(p), 0.5, 0, 0.25));
    expect(at(q, 0)).toEqual({ x: 0.5, y: 1 });
    expect(at(q, 1)).toEqual({ x: 1.5, y: 2 });
    const far = produce(p, (d) => moveFixtures(d, ids(p), 0, 100));
    expect(at(far, 0).y).toBe(p.stage.depth + 1);
    // 不存在的 id 不改工程
    expect(produce(p, (d) => moveFixtures(d, ["nope"], 1, 1))).toBe(p);
  });

  it("朝向 / 高度 / 吊挂；复位回到自动排布", () => {
    const p = base(3);
    const q = produce(p, (d) => setFixturePlacement(d, ids(p).slice(0, 2), { rotation: 270, z: 4, hanging: true }));
    expect(at(q, 0)).toMatchObject({ rotation: -90, z: 4, hanging: true });
    expect(at(q, 1)).toMatchObject({ rotation: -90, z: 4, hanging: true });
    expect(at(q, 2).rotation).toBeUndefined();
    const r = produce(q, (d) => setFixturePlacement(d, [ids(p)[0]], { hanging: false }));
    expect(at(r, 0).hanging).toBeUndefined();
    const s = produce(r, (d) => resetPlacements(d, [ids(p)[0]]));
    expect(s.fixtures[0].stage).toBeUndefined();
    expect(s.fixtures[1].stage).toBeDefined();
  });

  it("排成直线：沿包围盒长边均分，按给定顺序", () => {
    const p = produce(base(3), (d) => {
      d.fixtures[0].stage = { x: 4, y: 2 };
      d.fixtures[1].stage = { x: -2, y: 3 };
      d.fixtures[2].stage = { x: 0, y: 4 };
    });
    const q = produce(p, (d) => arrangeFixtures(d, ids(p), { kind: "line" }));
    expect(q.fixtures.map((f) => f.stage)).toEqual([
      { x: -2, y: 3 },
      { x: 1, y: 3 },
      { x: 4, y: 3 },
    ]);
  });

  it("所有灯在同一点时直线用舞台宽的一半展开；少于两台不动", () => {
    const p = produce(base(3), (d) => {
      for (const f of d.fixtures) f.stage = { x: 0, y: 2 };
    });
    const q = produce(p, (d) => arrangeFixtures(d, ids(p), { kind: "line" }));
    expect(q.fixtures.map((f) => f.stage!.x)).toEqual([-3, 0, 3]);
    expect(produce(p, (d) => arrangeFixtures(d, [ids(p)[0]], { kind: "line" }))).toBe(p);
  });

  it("弧线两端靠前、中间靠后且左右对称；圆和网格的点互不重叠", () => {
    const p = produce(base(5), (d) => {
      d.fixtures.forEach((f, i) => (f.stage = { x: -4 + i * 2, y: 3 }));
    });
    const arc = produce(p, (d) => arrangeFixtures(d, ids(p), { kind: "arc", sweepDeg: 90 }));
    const ys = arc.fixtures.map((f) => f.stage!.y);
    expect(ys[2]).toBeCloseTo(3, 3);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[0]).toBeCloseTo(ys[4], 3);
    expect(arc.fixtures[0].stage!.x).toBeCloseTo(-arc.fixtures[4].stage!.x, 3);

    for (const how of [{ kind: "circle" as const }, { kind: "grid" as const, columns: 3 }]) {
      const q = produce(p, (d) => arrangeFixtures(d, ids(p), how));
      const keys = new Set(q.fixtures.map((f) => `${f.stage!.x.toFixed(2)},${f.stage!.y.toFixed(2)}`));
      expect(keys.size).toBe(5);
    }
  });

  it("布景物件增删改：默认尺寸、夹取、角度规整；背景图", () => {
    let id = "";
    const p = produce(base(0), (d) => {
      id = addStageObject(d, "truss");
    });
    expect(p.stage.objects[0]).toMatchObject({ id, kind: "truss", x: 0, y: p.stage.depth / 2, w: 6, rotation: 0 });
    const q = produce(p, (d) => updateStageObject(d, id, { x: 1000, w: -3, rotation: 450, label: "前排" }));
    expect(q.stage.objects[0]).toMatchObject({ x: p.stage.width / 2 + 1, w: 0, rotation: 90, label: "前排" });
    expect(produce(q, (d) => updateStageObject(d, "nope", { x: 1 }))).toBe(q);
    const r = produce(q, (d) => removeStageObject(d, id));
    expect(r.stage.objects).toEqual([]);
    const s = produce(r, (d) => setStageBackground(d, "C:/stage.png"));
    expect(s.stage.backgroundPath).toBe("C:/stage.png");
    expect(produce(s, (d) => setStageBackground(d, null)).stage.backgroundPath).toBeNull();
  });
});
