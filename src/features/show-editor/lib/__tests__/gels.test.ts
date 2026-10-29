import { describe, expect, it } from "vitest";

import { harmonyColors, hsiToRgb, rgbToHsi, rotateHue } from "../colorMath";
import { GEL_FAMILIES, GELS, gelFamily, gelLabel, groupGels, searchGels } from "../gels";

describe("色纸库", () => {
  it("约 150 张 LEE / Rosco 色纸，id 不重复，RGB 合法", () => {
    expect(GELS.length).toBeGreaterThanOrEqual(150);
    expect(new Set(GELS.map((g) => g.id)).size).toBe(GELS.length);
    expect(GELS.filter((g) => g.brand === "LEE").length).toBeGreaterThan(60);
    expect(GELS.filter((g) => g.brand === "Rosco").length).toBeGreaterThan(60);
    for (const g of GELS) expect(g.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), g.id).toBe(true);
  });

  it("显示名：Rosco 编号带 R，按语言取名称", () => {
    const lee = GELS.find((g) => g.id === "lee-106")!;
    const rosco = GELS.find((g) => g.id === "rosco-26")!;
    expect(gelLabel(lee, "zh")).toBe("LEE 106 原红");
    expect(gelLabel(rosco, "en-US")).toBe("Rosco R26 Light Red");
  });

  it("搜索编号（含 R 前缀）、中英文名称，可按品牌筛选", () => {
    expect(searchGels(GELS, "106").map((g) => g.id)).toContain("lee-106");
    expect(searchGels(GELS, "r26").map((g) => g.id)).toEqual(["rosco-26"]);
    expect(searchGels(GELS, "刚果").map((g) => g.id)).toEqual(["lee-181"]);
    expect(searchGels(GELS, "lavender", "Rosco").every((g) => g.brand === "Rosco")).toBe(true);
    expect(searchGels(GELS, "  ").length).toBe(GELS.length);
  });

  it("按色系分组：顺序固定，淡色与校正纸单独一组", () => {
    expect(gelFamily([255, 0, 0])).toBe("red");
    expect(gelFamily([0, 60, 255])).toBe("blue");
    expect(gelFamily([230, 240, 255])).toBe("tint");
    const groups = groupGels(GELS);
    expect(groups.map((g) => g.family)).toEqual(GEL_FAMILIES.filter((f) => groups.some((g) => g.family === f)));
    expect(groups.find((g) => g.family === "tint")?.gels.map((g) => g.id)).toContain("lee-202");
  });
});

describe("颜色换算：HSI、色相旋转、配色方案", () => {
  it("HSI 与 RGB 互转（标准定义：强度为三通道平均）", () => {
    expect(rgbToHsi([255, 0, 0])).toEqual({ h: 0, s: 1, i: 1 / 3 });
    expect(rgbToHsi([255, 255, 255])).toEqual({ h: 0, s: 0, i: 1 });
    for (const rgb of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [200, 120, 40], [30, 90, 160], [255, 255, 255], [0, 0, 0]] as const) {
      const back = hsiToRgb(rgbToHsi([...rgb]));
      back.forEach((v, i) => expect(Math.abs(v - rgb[i]), `${rgb}`).toBeLessThanOrEqual(1));
    }
    // 超出 RGB 范围的组合被截断
    expect(hsiToRgb({ h: 0, s: 1, i: 1 })).toEqual([255, 0, 0]);
  });

  it("色相旋转保持饱和度与明度；灰色不变", () => {
    expect(rotateHue([255, 0, 0], 120)).toEqual([0, 255, 0]);
    expect(rotateHue([255, 0, 0], -120)).toEqual([0, 0, 255]);
    expect(rotateHue([128, 128, 128], 90)).toEqual([128, 128, 128]);
  });

  it("配色方案：第一个是基色", () => {
    expect(harmonyColors([255, 0, 0], "complementary")).toEqual([[255, 0, 0], [0, 255, 255]]);
    expect(harmonyColors([255, 0, 0], "triad")).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    expect(harmonyColors([255, 0, 0], "analogous")).toHaveLength(3);
    expect(harmonyColors([255, 0, 0], "split")[1]).toEqual(rotateHue([255, 0, 0], 150));
  });
});
