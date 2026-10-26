import { describe, expect, it } from "vitest";

import { formatCount, formatDuration } from "../format";

describe("formatCount", () => {
  it("使用千分位并四舍五入", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12340)).toBe("12,340");
    expect(formatCount(1234567.6)).toBe("1,234,568");
  });

  it("非有限值按 0 处理", () => {
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatDuration", () => {
  it("覆盖各量级的边界", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(999.4)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(3240)).toBe("3.2s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
  });

  it("负数与非有限值按 0 处理", () => {
    expect(formatDuration(-10)).toBe("0ms");
    expect(formatDuration(Number.NaN)).toBe("0ms");
  });
});