import {
  ACCENT_CHROMA_TOKEN,
  ACCENT_HUE_TOKEN,
  CARD_BLUR_TOKEN,
  CARD_RADIUS_TOKEN,
  DENSITY_GAP_TOKEN,
  DENSITY_GUTTER_TOKEN,
  FONT_MONO_TOKEN,
  FONT_SANS_TOKEN,
  PANEL_PAD_TOKEN,
  RADIUS_TOKEN,
  UI_SCALE_TOKEN,
  sanitizeTokenMap,
} from "@/shared/appearance/tokens";
import { hexToOklch } from "@/shared/appearance/oklch";
import type { TokenMap } from "@/shared/appearance/types";
import type { AppearanceSettings, Density } from "./appearanceSettings";

/** 明暗两套 CSS 变量。 */
export interface AppearanceVars {
  /** 亮色模式的变量。 */
  light: TokenMap;
  /** 暗色模式的变量。 */
  dark: TokenMap;
}

/** 各密度对应的页面边距、区块间距与面板内边距；default 使用 `globals.css` 的默认值，不写变量。 */
const DENSITY_SPACING: Record<Density, { gutter: string; gap: string; panel: string } | null> = {
  compact: { gutter: "1rem", gap: "0.875rem", panel: "0.875rem" },
  default: null,
  comfortable: { gutter: "2rem", gap: "1.5rem", panel: "1.75rem" },
};

/** 强调色彩度的上限：超出的高彩度颜色在深色模式下会过于刺眼。 */
const MAX_ACCENT_CHROMA = 0.26;

/**
 * 把十六进制主色折算成强调色的色相与彩度变量。
 * 应用的 `--primary`、`--ring`、`--heat-*` 等都由这两个变量在 CSS 里派生，
 * 所以只改它们，明暗两种模式下的对比度仍由 CSS 里固定的明度保证。
 *
 * @param color 十六进制主色。
 * @returns 变量映射；颜色不合法时为空对象。
 */
export function deriveAccentVars(color: string): TokenMap {
  const oklch = hexToOklch(color);
  if (!oklch) return {};
  const hue = Number(oklch.h.toFixed(1));
  const chroma = Number(Math.min(MAX_ACCENT_CHROMA, Math.max(0, oklch.c)).toFixed(3));
  return { [ACCENT_HUE_TOKEN]: String(hue), [ACCENT_CHROMA_TOKEN]: String(chroma) };
}

/**
 * 折算外观设置得到的 CSS 变量。
 *
 * 叠加顺序（后者覆盖前者）：整套主题 → 主色 → 圆角、字体、缩放、密度。
 * 结果会再过一遍白名单校验，保证写入 `<html>` 的一定是安全的值。
 *
 * @param settings 外观设置。
 * @returns 明暗两套变量；设置全部为默认值时两套都是空对象。
 */
export function computeVars(settings: AppearanceSettings): AppearanceVars {
  const accent = settings.accent ? deriveAccentVars(settings.accent.color) : {};

  const shared: Record<string, string> = {};
  if (settings.radius !== null) shared[RADIUS_TOKEN] = `${Number(settings.radius.toFixed(3))}rem`;
  if (settings.cardRadius !== null) shared[CARD_RADIUS_TOKEN] = `${Number(settings.cardRadius.toFixed(3))}rem`;
  if (settings.cardBlur !== null) shared[CARD_BLUR_TOKEN] = `${settings.cardBlur}px`;
  if (settings.font) {
    shared[FONT_SANS_TOKEN] = settings.font.sans;
    if (settings.font.mono) shared[FONT_MONO_TOKEN] = settings.font.mono;
  }
  // 100% 等于默认，不写变量，保持 globals.css 的默认行为
  if (settings.scale !== null && settings.scale !== 100) shared[UI_SCALE_TOKEN] = String(settings.scale);
  const spacing = DENSITY_SPACING[settings.density];
  if (spacing) {
    shared[DENSITY_GUTTER_TOKEN] = spacing.gutter;
    shared[DENSITY_GAP_TOKEN] = spacing.gap;
    shared[PANEL_PAD_TOKEN] = spacing.panel;
  }

  const build = (mode: "light" | "dark"): TokenMap =>
    sanitizeTokenMap({ ...settings.theme?.tokens[mode], ...accent, ...shared });
  return { light: build("light"), dark: build("dark") };
}
