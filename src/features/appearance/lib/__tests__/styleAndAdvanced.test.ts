import { describe, expect, it } from "vitest";

import { getDefaultSettings, sanitizeSettings } from "../appearanceSettings";
import { MANAGED_ATTR_KEYS, computeAttrs } from "../computeAttrs";
import { computeVars } from "../computeVars";

/** 把每一项都设成非默认值的设置。 */
const ALL_NON_DEFAULT = {
  ...getDefaultSettings(),
  sidebarStyle: "floating" as const,
  sidebarCollapsible: "none" as const,
  statusBar: false,
  contentWidth: "narrow" as const,
  cardStyle: "glass" as const,
  cardShadow: "lg" as const,
  cardPadding: "compact" as const,
  cardHover: "spotlight" as const,
  cardAccent: true,
  cardBorderWidth: 3 as const,
  cardDividers: true,
  cardGradientBorder: true,
  cardGlow: true,
  bgEffect: "aurora" as const,
  bgAnimated: true,
  bgSpeed: "fast" as const,
  bgIntensity: "strong" as const,
  pressFeedback: true,
  entrance: true,
  shimmer: true,
  thinScrollbar: true,
  focusRing: "strong" as const,
  pageTransition: true,
  motion: "reduce" as const,
  background: { ...getDefaultSettings().background, type: "gradient" as const },
};

describe("computeAttrs", () => {
  it("默认值一个属性都不写", () => {
    expect(computeAttrs(getDefaultSettings())).toEqual({});
  });

  it("每一项非默认设置都对应一个受管理的属性，取值与样式表里的选择器一致", () => {
    const attrs = computeAttrs(ALL_NON_DEFAULT);
    expect(attrs).toEqual({
      sidebarStyle: "floating",
      sidebarCollapsible: "none",
      statusBar: "off",
      contentWidth: "narrow",
      cardStyle: "glass",
      cardShadow: "lg",
      cardPadding: "compact",
      cardHover: "spotlight",
      cardAccent: "on",
      cardBorder: "3",
      cardDividers: "on",
      cardGradientBorder: "on",
      cardGlow: "on",
      customBg: "on",
      bgEffect: "aurora",
      bgAnimated: "on",
      bgSpeed: "fast",
      bgIntensity: "strong",
      pressFeedback: "on",
      entrance: "on",
      shimmer: "on",
      thinScrollbar: "on",
      focusRing: "strong",
      pageTransition: "on",
      motion: "reduce",
    });
    // 产出的键都在受管理的键列表里（切换设置后才能被清掉）
    for (const key of Object.keys(attrs)) expect(MANAGED_ATTR_KEYS as readonly string[]).toContain(key);
    expect(Object.keys(attrs)).toHaveLength(MANAGED_ATTR_KEYS.length);
  });

  it("动态、速度与强度只在选了背景特效时才有意义", () => {
    const attrs = computeAttrs({ ...getDefaultSettings(), bgEffect: "none", bgAnimated: true, bgSpeed: "fast" });
    expect(attrs).toEqual({});
  });
});

describe("computeVars（卡片）", () => {
  it("卡片圆角与毛玻璃模糊写入对应变量；默认不写", () => {
    expect(computeVars(getDefaultSettings()).light).toEqual({});
    const vars = computeVars({ ...getDefaultSettings(), cardRadius: 1.5, cardBlur: 20 });
    expect(vars.dark).toMatchObject({ "--card-radius": "1.5rem", "--card-blur": "20px" });
  });
});

describe("sanitizeSettings（卡片、特效与布局）", () => {
  it("非法的枚举值逐项回到默认值，合法项保留", () => {
    const result = sanitizeSettings({
      cardStyle: "neon",
      cardShadow: "xl",
      cardBorderWidth: 9,
      cardAccent: "yes",
      cardHover: "explode",
      cardRadius: 99,
      cardBlur: 1,
      cardPadding: "huge",
      bgEffect: "lava",
      bgSpeed: "warp",
      sidebarStyle: "wide",
      sidebarCollapsible: "half",
      statusBar: "no",
      contentWidth: "huge",
      focusRing: "off",
      motion: "full",
    });
    expect(result).toMatchObject({
      cardStyle: "outline",
      cardShadow: "sm",
      cardBorderWidth: 1,
      cardAccent: false,
      cardHover: "none",
      cardRadius: null,
      cardBlur: null,
      cardPadding: "default",
      bgEffect: "none",
      bgSpeed: "normal",
      sidebarStyle: "standard",
      sidebarCollapsible: "icon",
      statusBar: true,
      contentWidth: "full",
      focusRing: "keyboard",
      motion: "full",
    });
  });

  it("新增的卡片样式与悬停反馈取值被接受", () => {
    const result = sanitizeSettings({ cardStyle: "gradient", cardHover: "tilt", bgEffect: "grain" });
    expect(result).toMatchObject({ cardStyle: "gradient", cardHover: "tilt", bgEffect: "grain" });
  });

  it("自定义背景逐字段兜底：非法地址被丢弃，数值被限制在范围内", () => {
    const result = sanitizeSettings({
      background: {
        type: "url",
        url: "javascript:alert(1)",
        overlay: { dim: 500, blur: -3, blend: "xor", guard: "yes" },
        mesh: ["#111111"],
      },
    });
    expect(result.background.type).toBe("url");
    expect(result.background.url).toBeNull();
    expect(result.background.overlay).toEqual({ dim: 0, blur: 0, blend: "normal", guard: true });
    expect(result.background.mesh).toHaveLength(4);
  });
});
