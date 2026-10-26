import { describe, expect, it } from "vitest";

import { STALE_AFTER_MS, ageNow, isOutputStale } from "../outputFreshness";

describe("isOutputStale", () => {
  it("没收到过事件不算过期（显示“等待”）", () => {
    expect(isOutputStale(null, 10_000)).toBe(false);
  });

  it("以 5 秒为界", () => {
    expect(isOutputStale(1000, 1000 + STALE_AFTER_MS - 1)).toBe(false);
    expect(isOutputStale(1000, 1000 + STALE_AFTER_MS)).toBe(true);
  });
});

describe("ageNow", () => {
  it("补偿事件在途时间", () => {
    expect(ageNow(1000, 5000, 7500)).toBe(3500);
  });

  it("null 原样返回；时钟回拨不产生负补偿", () => {
    expect(ageNow(null, 5000, 7500)).toBeNull();
    expect(ageNow(1000, 5000, 4000)).toBe(1000);
    expect(ageNow(1000, null, 4000)).toBe(1000);
  });
});