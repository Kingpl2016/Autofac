import { describe, expect, it } from "vitest";

import { formatPacketRate } from "@/shared/lib/format";
import { formatUptime } from "@/shared/lib/uptime";
import { formatMemory } from "../format";

describe("formatUptime", () => {
  it("小于 1 小时用 mm:ss，否则 h:mm:ss", () => {
    expect(formatUptime(200)).toBe("03:20");
    expect(formatUptime(3725)).toBe("1:02:05");
  });
});

describe("formatPacketRate", () => {
  it("不足 1000 显示整数", () => {
    expect(formatPacketRate(0)).toEqual({ value: "0", unit: "pps" });
    expect(formatPacketRate(44)).toEqual({ value: "44", unit: "pps" });
    expect(formatPacketRate(999.4)).toEqual({ value: "999", unit: "pps" });
  });

  it("达到 1000 起使用 k 缩写并去掉多余的 .0", () => {
    expect(formatPacketRate(1000)).toEqual({ value: "1k", unit: "pps" });
    expect(formatPacketRate(1234)).toEqual({ value: "1.2k", unit: "pps" });
    expect(formatPacketRate(15800)).toEqual({ value: "15.8k", unit: "pps" });
  });

  it("负数与非有限值按 0 处理", () => {
    expect(formatPacketRate(-5).value).toBe("0");
    expect(formatPacketRate(Number.NaN).value).toBe("0");
    expect(formatPacketRate(Number.POSITIVE_INFINITY).value).toBe("0");
  });
});

describe("formatMemory", () => {
  it("0 或非法值显示为暂无数据", () => {
    expect(formatMemory(0)).toEqual({ value: "—", unit: "" });
    expect(formatMemory(-1)).toEqual({ value: "—", unit: "" });
    expect(formatMemory(Number.NaN)).toEqual({ value: "—", unit: "" });
  });

  it("不足 1 GB 用 MB 取整，且最小显示 1 MB", () => {
    expect(formatMemory(84 * 1024 * 1024)).toEqual({ value: "84", unit: "MB" });
    expect(formatMemory(1024)).toEqual({ value: "1", unit: "MB" });
  });

  it("达到 1 GB 用 GB 保留 1 位小数", () => {
    expect(formatMemory(1024 * 1024 * 1024)).toEqual({ value: "1", unit: "GB" });
    expect(formatMemory(1.5 * 1024 * 1024 * 1024)).toEqual({ value: "1.5", unit: "GB" });
  });
});