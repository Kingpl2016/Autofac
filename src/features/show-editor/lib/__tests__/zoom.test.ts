import { describe, expect, it } from "vitest";

import {
  DEFAULT_PX_PER_SEC,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  normalizeZoom,
  sliderToZoom,
  zoomPxPerSec,
  zoomToRange,
  zoomToSlider,
  ZOOM_SLIDER_STEPS,
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

  it("低缩放时保留小数，能一路缩到下限", () => {
    expect(zoomPxPerSec(4, -1)).toBe(3.2);
    let px = DEFAULT_PX_PER_SEC;
    for (let i = 0; i < 60; i += 1) px = zoomPxPerSec(px, -1);
    expect(px).toBe(MIN_PX_PER_SEC);
  });

  it("默认缩放在范围内", () => {
    expect(DEFAULT_PX_PER_SEC).toBeGreaterThanOrEqual(MIN_PX_PER_SEC);
    expect(DEFAULT_PX_PER_SEC).toBeLessThanOrEqual(MAX_PX_PER_SEC);
  });
});

describe("normalizeZoom", () => {
  it("10 以上取整，以下保留两位小数", () => {
    expect(normalizeZoom(12.4)).toBe(12);
    expect(normalizeZoom(5.678)).toBe(5.68);
  });

  it("夹在范围内，非有限值回到默认", () => {
    expect(normalizeZoom(0.1)).toBe(MIN_PX_PER_SEC);
    expect(normalizeZoom(99_999)).toBe(MAX_PX_PER_SEC);
    expect(normalizeZoom(Number.NaN)).toBe(DEFAULT_PX_PER_SEC);
  });
});

describe("缩放滑块", () => {
  it("两端对应上下限，往返后落在同一格", () => {
    expect(sliderToZoom(0)).toBe(MIN_PX_PER_SEC);
    expect(sliderToZoom(ZOOM_SLIDER_STEPS)).toBe(MAX_PX_PER_SEC);
    for (const pos of [0, 10, 25, 50, 75, 100]) expect(zoomToSlider(sliderToZoom(pos))).toBe(pos);
  });
});

describe("zoomToRange", () => {
  it("范围铺满视口（两侧各留 5%），并滚动到让它居中", () => {
    expect(zoomToRange({ startMs: 0, endMs: 10_000 }, 1000)).toEqual({ pxPerSec: 90, scrollLeft: 0 });
    expect(zoomToRange({ startMs: 10_000, endMs: 20_000 }, 1000)).toEqual({ pxPerSec: 90, scrollLeft: 850 });
    // 起止颠倒也一样；内容左侧有偏移时一起算上
    expect(zoomToRange({ startMs: 20_000, endMs: 10_000 }, 1000, 12)).toEqual({ pxPerSec: 90, scrollLeft: 862 });
  });

  it("太短的范围按 1 秒算，缩放被夹到上限", () => {
    expect(zoomToRange({ startMs: 5000, endMs: 5000 }, 1000).pxPerSec).toBe(900);
    expect(zoomToRange({ startMs: 0, endMs: 100 }, 4000).pxPerSec).toBe(MAX_PX_PER_SEC);
  });
});
