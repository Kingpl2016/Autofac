import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { alignFixtures, distributeFixtures, mirrorFixtures, reverseFixturePositions } from "../../lib/stageOps";
import { RGBW } from "../../lib/__tests__/testkit";
import { labelOf } from "../StageRenderer";
import { applyCamera, FIT_CAMERA, fitStage, toCanvas, toStage, ZOOM_RANGE, zoomAt } from "../stageGeometry";

/** 4 台灯，摆在给定位置。 */
function placed(points: [number, number, number?][]): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, points.length);
    d.stage.width = 20;
    d.stage.depth = 10;
    d.fixtures.forEach((f, i) => {
      const [x, y, rotation] = points[i];
      f.stage = rotation === undefined ? { x, y } : { x, y, rotation };
    });
  });
}
const xs = (p: ShowProject) => p.fixtures.map((f) => f.stage!.x);
const ys = (p: ShowProject) => p.fixtures.map((f) => f.stage!.y);
const ids = (p: ShowProject) => p.fixtures.map((f) => f.id);

describe("视图缩放与平移", () => {
  const fit = fitStage({ width: 10, depth: 5 }, 548, 448);

  it("适应窗口时与 fitStage 相同；缩放以画布中心为中心", () => {
    expect(applyCamera(fit, FIT_CAMERA, 548, 448)).toEqual(fit);
    const v = applyCamera(fit, { zoom: 2, panX: 0, panY: 0 }, 548, 448);
    expect(v.scale).toBe(fit.scale * 2);
    // 画布中心对应的舞台点不变
    expect(toStage(v, 274, 224)).toEqual(toStage(fit, 274, 224));
  });

  it("以指针为中心缩放：指针下的舞台点保持在原处；缩放夹在范围内", () => {
    const cam = zoomAt(fit, FIT_CAMERA, 548, 448, 100, 300, 3);
    const before = toStage(fit, 100, 300);
    const after = toCanvas(applyCamera(fit, cam, 548, 448), before.x, before.y);
    expect(after.x).toBeCloseTo(100, 6);
    expect(after.y).toBeCloseTo(300, 6);
    expect(zoomAt(fit, FIT_CAMERA, 548, 448, 0, 0, 1000).zoom).toBe(ZOOM_RANGE.max);
    expect(zoomAt(fit, FIT_CAMERA, 548, 448, 0, 0, 0.0001).zoom).toBe(ZOOM_RANGE.min);
    expect(zoomAt(fit, FIT_CAMERA, 548, 448, 0, 0, Number.NaN).zoom).toBe(1);
  });
});

describe("对齐、分布、镜像、反转", () => {
  it("对齐：按包围盒的边或中线，另一个方向不变", () => {
    const p = placed([
      [-2, 1],
      [0, 3],
      [4, 2],
    ]);
    const all = ids(p);
    expect(xs(produce(p, (d) => alignFixtures(d, all, "left")))).toEqual([-2, -2, -2]);
    expect(xs(produce(p, (d) => alignFixtures(d, all, "right")))).toEqual([4, 4, 4]);
    expect(xs(produce(p, (d) => alignFixtures(d, all, "centerX")))).toEqual([1, 1, 1]);
    expect(ys(produce(p, (d) => alignFixtures(d, all, "back")))).toEqual([3, 3, 3]);
    expect(ys(produce(p, (d) => alignFixtures(d, all, "front")))).toEqual([1, 1, 1]);
    expect(ys(produce(p, (d) => alignFixtures(d, all, "centerY")))).toEqual([2, 2, 2]);
    // 只选一台时不动
    expect(xs(produce(p, (d) => alignFixtures(d, [all[0]], "right")))).toEqual([-2, 0, 4]);
  });

  it("等距分布：按坐标排序，两端不动；少于 3 台不变", () => {
    const p = placed([
      [5, 0],
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(xs(produce(p, (d) => distributeFixtures(d, ids(p), "x")))).toEqual([5, 0, 5 / 3, 10 / 3].map((v) => Number(v.toFixed(3))));
    expect(xs(produce(p, (d) => distributeFixtures(d, ids(p).slice(0, 2), "x")))).toEqual([5, 0, 1, 2]);
  });

  it("镜像：绕包围盒中线翻转，朝向随之镜像", () => {
    const p = placed([
      [0, 1, 30],
      [4, 3],
    ]);
    const lr = produce(p, (d) => mirrorFixtures(d, ids(p), "x"));
    expect(xs(lr)).toEqual([4, 0]);
    expect(lr.fixtures[0].stage!.rotation).toBe(-30);
    const fb = produce(p, (d) => mirrorFixtures(d, ids(p), "y"));
    expect(ys(fb)).toEqual([3, 1]);
    expect(fb.fixtures[0].stage!.rotation).toBe(150);
  });

  it("反转顺序：首尾互换位置，其它安装参数不变", () => {
    const p = placed([
      [0, 0, 10],
      [1, 1],
      [2, 2],
    ]);
    const r = produce(p, (d) => reverseFixturePositions(d, ids(p)));
    expect(xs(r)).toEqual([2, 1, 0]);
    expect(ys(r)).toEqual([2, 1, 0]);
    expect(r.fixtures[0].stage!.rotation).toBe(10);
  });
});

describe("灯具旁的文字", () => {
  const f = { id: "a", name: "灯1", selected: false, address: "U0 @1" };
  it("按设置显示名称或地址；悬停的总是显示名称", () => {
    expect(labelOf(f, { hover: null })).toBeNull();
    expect(labelOf({ ...f, selected: true }, { hover: null })).toBe("灯1");
    expect(labelOf(f, { hover: null, labels: "name" })).toBe("灯1");
    expect(labelOf(f, { hover: null, labels: "address" })).toBe("U0 @1");
    expect(labelOf(f, { hover: "a", labels: "address" })).toBe("灯1");
    expect(labelOf({ ...f, selected: true }, { hover: null, labels: "none" })).toBeNull();
    expect(labelOf(f, { hover: "a", labels: "none" })).toBe("灯1");
  });
});
