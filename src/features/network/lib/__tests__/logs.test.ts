import { describe, expect, it } from "vitest";

import { filterLogLines, isNearBottom, lineLevel, stripAnsi } from "../logs";

describe("logs", () => {
  it("lineLevel 识别 ESP-IDF 前缀（含 ANSI 颜色）", () => {
    expect(lineLevel("E (12) net: fail")).toBe("error");
    expect(lineLevel("W (12) net: slow")).toBe("warn");
    expect(lineLevel("I (12) net: ok")).toBe("info");
    expect(lineLevel("D (12) net: dbg")).toBe("debug");
    expect(lineLevel("\u001b[0;31mE (12) net: red\u001b[0m")).toBe("error");
    expect(lineLevel("random text")).toBe("info");
  });

  it("stripAnsi 去除颜色序列", () => {
    expect(stripAnsi("\u001b[0;32mI (1) ok\u001b[0m")).toBe("I (1) ok");
  });

  it("filterLogLines 忽略空行并按关键字过滤", () => {
    const text = "I (1) sd: mounted\r\n\r\nE (2) net: link down\nW (3) SD slow\n";
    expect(filterLogLines(text, "")).toHaveLength(3);
    expect(filterLogLines(text, "sd")).toEqual(["I (1) sd: mounted", "W (3) SD slow"]);
    expect(filterLogLines(text, "  LINK ")).toEqual(["E (2) net: link down"]);
    expect(filterLogLines(text, "nothing")).toEqual([]);
  });

  it("isNearBottom 带容差", () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true);
    expect(isNearBottom(880, 100, 1000)).toBe(true);
    expect(isNearBottom(800, 100, 1000)).toBe(false);
  });
});
