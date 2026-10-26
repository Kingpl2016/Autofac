import { describe, expect, it } from "vitest";

import { compareIp } from "../ip";

describe("compareIp", () => {
  it("IPv4 按数值而非字典序比较", () => {
    expect(compareIp("10.0.0.2", "10.0.0.10")).toBeLessThan(0);
    expect(compareIp("10.0.0.10", "10.0.0.2")).toBeGreaterThan(0);
    expect(compareIp("9.255.255.255", "10.0.0.0")).toBeLessThan(0);
    expect(compareIp("192.168.1.1", "192.168.1.1")).toBe(0);
  });

  it("可直接用于 sort", () => {
    const list = ["192.168.1.20", "192.168.1.3", "10.0.0.1", "192.168.1.100"];
    expect(list.sort(compareIp)).toEqual([
      "10.0.0.1",
      "192.168.1.3",
      "192.168.1.20",
      "192.168.1.100",
    ]);
  });

  it("非法或非 IPv4 的字符串排在 IPv4 之后，彼此按字典序", () => {
    expect(compareIp("10.0.0.1", "::1")).toBeLessThan(0);
    expect(compareIp("::1", "10.0.0.1")).toBeGreaterThan(0);
    expect(compareIp("999.1.1.1", "10.0.0.1")).toBeGreaterThan(0);
    expect(compareIp("::1", "::2")).toBeLessThan(0);
    expect(compareIp("PLAYER", "PLAYER")).toBe(0);
  });
});