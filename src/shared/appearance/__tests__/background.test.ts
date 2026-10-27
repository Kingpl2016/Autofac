import { describe, expect, it } from "vitest";

import {
  colorsLuminance,
  getDefaultBackground,
  isAllowedImageUrl,
  meanLuminance,
  requiredDim,
  sanitizeBackground,
  toLinearGradient,
  toMeshGradient,
  UNKNOWN_LUMA_DIM,
} from "../background";

describe("isAllowedImageUrl", () => {
  it("只允许 http / https，拒绝 data / javascript / blob 与带账号密码的地址", () => {
    expect(isAllowedImageUrl("https://example.com/a.png")).toBe(true);
    expect(isAllowedImageUrl("http://example.com/a.png")).toBe(true);
    expect(isAllowedImageUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedImageUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isAllowedImageUrl("blob:https://example.com/x")).toBe(false);
    expect(isAllowedImageUrl("https://user:pass@example.com/a.png")).toBe(false);
    expect(isAllowedImageUrl("")).toBe(false);
    expect(isAllowedImageUrl(`https://example.com/${"a".repeat(2100)}`)).toBe(false);
  });
});

describe("背景设置", () => {
  it("默认是不使用自定义背景", () => {
    expect(getDefaultBackground().type).toBe("none");
  });

  it("不是对象时回到默认；字段非法时逐项兜底", () => {
    expect(sanitizeBackground(null)).toEqual(getDefaultBackground());
    const result = sanitizeBackground({ type: "hologram", fit: "stretch", speed: "warp" });
    expect(result).toMatchObject({ type: "none", fit: "cover", speed: "normal" });
  });
});

describe("渐变折算", () => {
  it("线性渐变按位置排序色标", () => {
    const css = toLinearGradient({
      angle: 90,
      stops: [
        { color: "#ff0000", position: 100 },
        { color: "#0000ff", position: 0 },
      ],
    });
    expect(css).toBe("linear-gradient(90deg, #0000ff 0%, #ff0000 100%)");
  });

  it("网格渐变每个颜色占据画面的一角", () => {
    const css = toMeshGradient(["#111111", "#222222", "#333333"]);
    expect(css.match(/radial-gradient/g)).toHaveLength(3);
    expect(css).toContain("#111111");
  });
});

describe("对比度保护", () => {
  it("平均亮度：全黑为 0，全白为 1，没有像素时为 0.5", () => {
    expect(meanLuminance([0, 0, 0, 255])).toBe(0);
    expect(meanLuminance([255, 255, 255, 255])).toBeCloseTo(1, 5);
    expect(meanLuminance([])).toBe(0.5);
    expect(colorsLuminance(["#000000", "#ffffff"])).toBeCloseTo(0.5, 1);
    expect(colorsLuminance([])).toBe(0.5);
  });

  it("亮度未知时用保守的固定遮罩", () => {
    expect(requiredDim(null, "dark")).toBe(UNKNOWN_LUMA_DIM);
    expect(requiredDim(null, "light")).toBe(UNKNOWN_LUMA_DIM);
  });

  it("暗色模式：背景够暗时不需要遮罩，背景越亮需要的遮罩越多，且不超过上限", () => {
    expect(requiredDim(0.001, "dark")).toBe(0);
    const mid = requiredDim(0.3, "dark");
    const bright = requiredDim(0.9, "dark");
    expect(mid).toBeGreaterThan(0);
    expect(bright).toBeGreaterThan(mid);
    expect(bright).toBeLessThanOrEqual(80);
  });

  it("亮色模式：背景够亮时不需要遮罩，背景越暗需要的遮罩越多", () => {
    expect(requiredDim(0.95, "light")).toBe(0);
    expect(requiredDim(0.1, "light")).toBeGreaterThan(requiredDim(0.4, "light"));
  });
});
