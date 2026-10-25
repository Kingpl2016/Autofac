import { describe, expect, it } from "vitest";

import { isValidIpv4 } from "../ip";
import { base64ToBytes, cellIntensity, decodeOverview, timeToX, xToTimeUs } from "../overview";

describe("isValidIpv4", () => {
  it("接受合法地址并忽略首尾空白", () => {
    expect(isValidIpv4("192.168.1.50")).toBe(true);
    expect(isValidIpv4(" 10.0.0.1 ")).toBe(true);
    expect(isValidIpv4("255.255.255.255")).toBe(true);
  });

  it("拒绝非法地址", () => {
    for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "a.b.c.d", "1.2.3.-4", "1..3.4"]) {
      expect(isValidIpv4(bad), bad).toBe(false);
    }
  });
});

describe("overview 解码与坐标换算", () => {
  it("Base64 解码字节矩阵，非法输入得到空数组", () => {
    expect([...base64ToBytes("AAEC/w==")]).toEqual([0, 1, 2, 255]);
    expect(base64ToBytes("!!").length).toBe(0);
  });

  it("decodeOverview 逐行还原", () => {
    const o = decodeOverview({
      version: 1,
      durationUs: 1000,
      buckets: 2,
      universes: [1],
      change: ["AAE="],
      level: ["/wA="],
      frames: 2,
      skippedFrames: 0,
      fileBytes: 10,
    });
    expect([...o.change[0]]).toEqual([0, 1]);
    expect([...o.level[0]]).toEqual([255, 0]);
    expect(o.universes).toEqual([1]);
  });

  it("强度在 0..1 内，电平与变化都会提亮", () => {
    expect(cellIntensity(0, 0)).toBe(0);
    expect(cellIntensity(255, 255)).toBe(1);
    expect(cellIntensity(100, 0)).toBeLessThan(cellIntensity(100, 200));
    expect(cellIntensity(10, 50)).toBeLessThan(cellIntensity(200, 50));
  });

  it("像素与时间互相换算并钳制", () => {
    expect(xToTimeUs(50, 100, 10_000_000)).toBe(5_000_000);
    expect(xToTimeUs(-5, 100, 10_000_000)).toBe(0);
    expect(xToTimeUs(500, 100, 10_000_000)).toBe(10_000_000);
    expect(xToTimeUs(10, 0, 10_000_000)).toBe(0);
    expect(timeToX(2_500_000, 200, 10_000_000)).toBe(50);
    expect(timeToX(99_000_000, 200, 10_000_000)).toBe(200);
    expect(timeToX(5, 200, 0)).toBe(0);
  });
});
