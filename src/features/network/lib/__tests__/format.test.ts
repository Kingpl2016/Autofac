import { describe, expect, it } from "vitest";

import { agoParts, formatBytes, formatClock, formatHourMinute, formatSpeed, percentOf } from "../format";

describe("format", () => {
  it("formatBytes 按 1024 进位", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("formatClock 输出 m:ss 或 h:mm:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_900)).toBe("1:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(-1)).toBe("0:00");
  });

  it("formatSpeed 追加 /s", () => {
    expect(formatSpeed(2 * 1024 * 1024)).toBe("2.0 MB/s");
  });

  it("percentOf 对未知总量返回 null 并夹在 0~100", () => {
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(300, 200)).toBe(100);
    expect(percentOf(-1, 200)).toBe(0);
  });

  it("agoParts 取最大的整单位，5 秒内为 now", () => {
    expect(agoParts(0)).toEqual({ unit: "now", value: 0 });
    expect(agoParts(4_999)).toEqual({ unit: "now", value: 0 });
    expect(agoParts(-10)).toEqual({ unit: "now", value: 0 });
    expect(agoParts(5_000)).toEqual({ unit: "sec", value: 5 });
    expect(agoParts(59_999)).toEqual({ unit: "sec", value: 59 });
    expect(agoParts(60_000)).toEqual({ unit: "min", value: 1 });
    expect(agoParts(3_599_000)).toEqual({ unit: "min", value: 59 });
    expect(agoParts(7_200_000)).toEqual({ unit: "hour", value: 2 });
    expect(agoParts(3 * 86_400_000)).toEqual({ unit: "day", value: 3 });
  });

  it("formatHourMinute 输出本地 HH:mm", () => {
    expect(formatHourMinute(new Date(2026, 0, 1, 9, 5).getTime())).toBe("09:05");
    expect(formatHourMinute(new Date(2026, 0, 1, 23, 59).getTime())).toBe("23:59");
  });
});
