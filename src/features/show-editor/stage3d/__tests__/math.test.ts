import { describe, expect, it } from "vitest";

import { beamAngleDeg, beamDirection, cross, dot, fixtureBasis, floorHit, headAngles, spotEllipse, toScene, type Vec3 } from "../math";

const near = (a: Vec3, b: Vec3, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

describe("fixtureBasis", () => {
  it("朝向 0 朝观众（-y），正角度转向 +x；right / up / front 构成右手系", () => {
    const b = fixtureBasis(0, 0, false);
    expect(near(b.up, [0, 0, 1])).toBe(true);
    expect(near(b.front, [0, -1, 0])).toBe(true);
    expect(near(cross(b.right, b.up), b.front)).toBe(true);
    expect(near(fixtureBasis(90, 0, false).front, [1, 0, 0])).toBe(true);
  });

  it("俯仰让光轴朝朝向倾斜；吊挂时光轴朝下", () => {
    const hang = fixtureBasis(180, 45, true);
    // 吊挂、朝舞台后方（+y）、俯仰 45°：光轴朝下并朝后
    expect(hang.up[2]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(hang.up[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(dot(hang.up, hang.front)).toBeCloseTo(0, 9);
    const stand = fixtureBasis(0, 30, false);
    expect(stand.up[2]).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(stand.up[1]).toBeCloseTo(-0.5, 6);
  });
});

describe("beamDirection", () => {
  it("中位时沿光轴；Tilt 让光束朝前倾，Pan 绕光轴转（与 2D 舞台同向）", () => {
    const b = fixtureBasis(0, 0, false);
    expect(near(beamDirection(b, headAngles(0.5, 0.5, 540, 270)), [0, 0, 1])).toBe(true);
    // Tilt 满行程的 2/3（+90°）：水平朝前（观众）
    const forward = beamDirection(b, headAngles(0.5, 0.5 + 90 / 270, 540, 270));
    expect(near(forward, [0, -1, 0])).toBe(true);
    // 再 Pan +90°：转向 +x（2D 舞台里 Pan 增大也转向 +x）
    const right = beamDirection(b, headAngles(0.5 + 90 / 540, 0.5 + 90 / 270, 540, 270));
    expect(near(right, [1, 0, 0])).toBe(true);
  });

  it("吊挂灯中位时朝下，Pan 在俯视里反向（等同 2D 的 1 − pan）", () => {
    const b = fixtureBasis(0, 0, true);
    expect(near(beamDirection(b, headAngles(null, null, 540, 270)), [0, 0, -1])).toBe(true);
    const d = beamDirection(b, headAngles(0.5 + 90 / 540, 0.5 + 90 / 270, 540, 270));
    expect(near(d, [-1, 0, 0])).toBe(true);
  });
});

describe("floorHit / spotEllipse / beamAngleDeg / toScene", () => {
  it("朝下的光束落到地面；朝上或太远时没有交点", () => {
    const hit = floorHit([0, 0, 5], [0, 0.6, -0.8]);
    expect(hit?.distance).toBeCloseTo(6.25, 6);
    expect(hit?.point[1]).toBeCloseTo(3.75, 6);
    expect(floorHit([0, 0, 5], [0, 0, 1])).toBeNull();
    expect(floorHit([0, 0, 5], [0, 1, -0.01], 0, 25)).toBeNull();
    // 台口外的观众区地面低于台面
    expect(floorHit([0, 0, 5], [0, 0, -1], -1)?.distance).toBeCloseTo(6, 6);
  });

  it("垂直打下是圆，斜射沿光束方向拉长", () => {
    const round = spotEllipse([0, 0, -1], 5, 20);
    expect(round.major).toBeCloseTo(round.minor, 9);
    const slant = spotEllipse([0, Math.SQRT1_2, -Math.SQRT1_2], 5, 20);
    expect(slant.major / slant.minor).toBeCloseTo(Math.SQRT2, 6);
    expect(slant.heading).toBeCloseTo(Math.PI / 2, 6);
  });

  it("光束角：变焦标注优先，其次物理参数插值，最后用兜底值", () => {
    expect(beamAngleDeg({ beamMinDeg: 10, beamMaxDeg: 40 }, 0.5, [5, 45], 25)).toBe(25);
    expect(beamAngleDeg({ beamMinDeg: 10, beamMaxDeg: 40 }, 1, null, 25)).toBe(40);
    expect(beamAngleDeg({ beamMinDeg: 10, beamMaxDeg: 40 }, null, null, 25)).toBe(25);
    expect(beamAngleDeg({ beamMinDeg: 12 }, null, null, 25)).toBe(12);
    expect(beamAngleDeg(undefined, null, null, 300)).toBe(120);
    expect(toScene([1, 2, 3])).toEqual([1, 3, -2]);
  });
});
