import { describe, expect, it } from "vitest";

import { beamOf, fitStage, hitFixture, hitObject, lassoFixtures, placeFixtures, STAGE_PADDING, toCanvas, toStage } from "../stageGeometry";

describe("舞台几何", () => {
  it("fitStage：舞台按较紧的一边缩放并居中，前沿中央在画布底部居中", () => {
    const view = fitStage({ width: 10, depth: 5 }, 548, 448);
    // 宽：(548-48)/10=50，深：(448-48)/5=80 → 取 50
    expect(view.scale).toBe(50);
    expect(view.originX).toBe(274);
    expect(view.originY).toBe(224 + 125);
    const back = toCanvas(view, 0, 5);
    expect(back.y).toBe(224 - 125);
    // 舞台正好留出 padding
    expect(toCanvas(view, -5, 0).x).toBe(STAGE_PADDING);
  });

  it("toCanvas / toStage 互逆；舞台 y 越大画布越靠上", () => {
    const view = fitStage({ width: 12, depth: 8 }, 800, 600);
    const p = toCanvas(view, 2.5, 3);
    expect(toStage(view, p.x, p.y)).toEqual({ x: expect.closeTo(2.5) as number, y: expect.closeTo(3) as number });
    expect(toCanvas(view, 0, 4).y).toBeLessThan(toCanvas(view, 0, 1).y);
  });

  it("尺寸为 0 时不产生 NaN（缩放至少 1）", () => {
    const view = fitStage({ width: 0, depth: 0 }, 0, 0);
    expect(Number.isFinite(view.scale) && view.scale >= 1).toBe(true);
  });

  it("placeFixtures：已摆放的保持原位，其余排成网格且都在舞台内、互不重叠", () => {
    const fixtures = [
      { id: "a" },
      { id: "b", stage: { x: -3, y: 2, rotation: 90 } },
      { id: "c" },
      { id: "d" },
      { id: "e" },
    ];
    const stage = { width: 12, depth: 8 };
    const placed = placeFixtures(fixtures, stage);
    expect(placed.size).toBe(5);
    expect(placed.get("b")).toEqual({ x: -3, y: 2, rotation: 90 });
    const loose = ["a", "c", "d", "e"].map((id) => placed.get(id)!);
    for (const p of loose) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(6);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(8);
    }
    const keys = new Set(loose.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    expect(keys.size).toBe(4);
  });

  it("hitFixture：取半径内最近的一台；都不在半径内返回 null", () => {
    const points = [
      { id: "a", x: 10, y: 10 },
      { id: "b", x: 16, y: 10 },
    ];
    expect(hitFixture(points, 14, 10, 8)).toBe("b");
    expect(hitFixture(points, 11, 10, 8)).toBe("a");
    expect(hitFixture(points, 100, 100, 8)).toBeNull();
  });

  it("lassoFixtures：任意方向拖出的矩形都能框选，保持输入顺序", () => {
    const points = [
      { id: "a", x: 10, y: 10 },
      { id: "b", x: 50, y: 50 },
      { id: "c", x: 30, y: 20 },
    ];
    expect(lassoFixtures(points, { x: 40, y: 30 }, { x: 0, y: 0 })).toEqual(["a", "c"]);
    expect(lassoFixtures(points, { x: 0, y: 0 }, { x: 5, y: 5 })).toEqual([]);
  });

  it("hitObject：考虑旋转的矩形、圆；后加的物件优先", () => {
    const view = fitStage({ width: 10, depth: 10 }, 548, 548);
    const base = { label: "", h: 0.4, rotation: 0 };
    const objects = [
      { ...base, id: "truss", kind: "truss" as const, x: 0, y: 5, w: 6 },
      { ...base, id: "ring", kind: "circle" as const, x: 3, y: 2, w: 2, h: 2 },
      { ...base, id: "post", kind: "rect" as const, x: -3, y: 2, w: 4, rotation: 90 },
      { ...base, id: "top", kind: "rect" as const, x: 2.5, y: 5, w: 1, h: 1 },
    ];
    const at = (x: number, y: number) => {
      const p = toCanvas(view, x, y);
      return hitObject(objects, view, p.x, p.y, 0);
    };
    expect(at(-2.5, 5)).toBe("truss");
    expect(at(-2.5, 5.5)).toBeNull();
    expect(at(2.5, 5)).toBe("top");
    expect(at(3.9, 2)).toBe("ring");
    expect(at(3.9, 2.9)).toBeNull();
    // 旋转 90° 后竖着：沿 y 方向长 4 m
    expect(at(-3, 3.8)).toBe("post");
    expect(at(-4.5, 2)).toBeNull();
  });

  it("beamOf：Pan 居中指向观众，Tilt 居中垂直向下（无投射），朝向叠加到角度上", () => {
    expect(beamOf(0.5, 0.5, 540)).toEqual({ angle: 0, reach: 0 });
    const right = beamOf(0.5 + 90 / 540, 1, 540);
    expect(right.angle).toBeCloseTo(Math.PI / 2);
    expect(right.reach).toBe(1);
    expect(beamOf(0.5, 0.75, 540, 180).angle).toBeCloseTo(Math.PI);
    expect(beamOf(0.5, 0.75, 540).reach).toBeCloseTo(0.5);
  });
});
