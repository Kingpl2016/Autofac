import { describe, expect, it } from "vitest";

import {
  DEFAULT_PX_PER_SEC,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  zoomPxPerSec,
} from "../zoom";

describe("zoomPxPerSec", () => {
  it("放大 / 缩小按倍率变化并取整", () => {
    expect(zoomPxPerSec(160, 1)).toBe(200);
    expect(zoomPxPerSec(200, -1)).toBe(160);
  });

  it("夹在上下限之内", () => {
    expect(zoomPxPerSec(MAX_PX_PER_SEC, 1)).toBe(MAX_PX_PER_SEC);
    expect(zoomPxPerSec(MIN_PX_PER_SEC, -1)).toBe(MIN_PX_PER_SEC);
  });

  it("默认缩放在范围内", () => {
    expect(DEFAULT_PX_PER_SEC).toBeGreaterThanOrEqual(MIN_PX_PER_SEC);
    expect(DEFAULT_PX_PER_SEC).toBeLessThanOrEqual(MAX_PX_PER_SEC);
  });
});
