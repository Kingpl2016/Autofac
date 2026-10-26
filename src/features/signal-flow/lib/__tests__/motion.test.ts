import { describe, expect, it } from "vitest";

import {
  PARTICLE_ACTIVE_EDGE_LIMIT,
  PARTICLE_SPEED,
  particleDuration,
  shouldAnimateParticles,
} from "../motion";

describe("shouldAnimateParticles", () => {
  it("减少动态效果时一律不画", () => {
    expect(shouldAnimateParticles(true, 0)).toBe(false);
    expect(shouldAnimateParticles(true, 10)).toBe(false);
  });

  it("有信号的边不超过上限时才画", () => {
    expect(shouldAnimateParticles(false, 0)).toBe(true);
    expect(shouldAnimateParticles(false, PARTICLE_ACTIVE_EDGE_LIMIT)).toBe(true);
    expect(shouldAnimateParticles(false, PARTICLE_ACTIVE_EDGE_LIMIT + 1)).toBe(false);
  });
});

describe("particleDuration", () => {
  it("时长与距离成正比（速度恒定）", () => {
    expect(particleDuration(PARTICLE_SPEED * 3)).toBeCloseTo(3);
    expect(particleDuration(PARTICLE_SPEED * 4)).toBeCloseTo(4);
  });

  it("限制在 1.5 到 6 秒", () => {
    expect(particleDuration(0)).toBe(1.5);
    expect(particleDuration(10)).toBe(1.5);
    expect(particleDuration(100000)).toBe(6);
  });

  it("负距离取绝对值；非法值按 0 处理", () => {
    expect(particleDuration(-PARTICLE_SPEED * 3)).toBeCloseTo(3);
    expect(particleDuration(Number.NaN)).toBe(1.5);
  });
});