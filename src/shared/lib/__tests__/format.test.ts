import { describe, expect, it } from "vitest";

import { formatBytes, formatBytesIec, formatCount, formatDuration, formatHms, pad2 } from "../format";
import { clamp, clamp01 } from "../math";

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

describe("formatBytes（KB / MB）", () => {
  it("B 级取整，其余一位小数，最大到 TB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150.0 MB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
  });

  it("负数与非有限值按 0 处理", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatBytesIec（KiB / MiB）", () => {
  it("不足 100 一位小数，100 起取整，最大到 GiB", () => {
    expect(formatBytesIec(512)).toBe("512 B");
    expect(formatBytesIec(1536)).toBe("1.5 KiB");
    expect(formatBytesIec(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatBytesIec(150 * 1024 * 1024)).toBe("150 MiB");
    expect(formatBytesIec(2 * 1024 ** 4)).toBe("2048 GiB");
  });
});

describe("formatHms / pad2", () => {
  it("m:ss，一小时以上 h:mm:ss；可要求分钟补零", () => {
    expect(formatHms(0)).toBe("0:00");
    expect(formatHms(65.9)).toBe("1:05");
    expect(formatHms(3725)).toBe("1:02:05");
    expect(formatHms(200, true)).toBe("03:20");
    expect(formatHms(3725, true)).toBe("1:02:05");
  });

  it("负数与非有限值按 0 处理", () => {
    expect(formatHms(-1)).toBe("0:00");
    expect(formatHms(Number.NaN, true)).toBe("00:00");
  });

  it("pad2 两位补零", () => {
    expect(pad2(5)).toBe("05");
    expect(pad2(12)).toBe("12");
  });
});

describe("clamp / clamp01", () => {
  it("夹在区间内", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(-0.2)).toBe(0);
  });
});
