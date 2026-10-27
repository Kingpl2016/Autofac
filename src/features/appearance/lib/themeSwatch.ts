import type { TokenMap } from "@/shared/appearance/types";
import type { ResolvedMode } from "./appearanceSettings";

/** 预设卡片迷你预览用到的颜色。 */
export interface Swatch {
  /** 页面背景。 */
  background: string;
  /** 卡片背景。 */
  card: string;
  /** 侧边栏背景。 */
  sidebar: string;
  /** 主色（始终取当前生效的主色，预览随主色实时变化）。 */
  primary: string;
  /** 弱化色。 */
  muted: string;
  /** 边框。 */
  border: string;
  /** 正文文字。 */
  foreground: string;
}

/** 默认主题（`globals.css`）在各模式下的色块；预设里没有覆盖的 token 回退到这里。 */
const DEFAULT_SWATCH: Record<ResolvedMode, Swatch> = {
  light: {
    background: "oklch(0.99 0 0)",
    card: "oklch(1 0 0)",
    sidebar: "oklch(0.97 0.005 260)",
    primary: "var(--primary)",
    muted: "oklch(0.96 0.005 260)",
    border: "oklch(0.9 0.005 260)",
    foreground: "oklch(0.18 0.01 260)",
  },
  dark: {
    background: "oklch(0.16 0.004 260)",
    card: "oklch(0.19 0.005 260)",
    sidebar: "oklch(0.18 0.005 260)",
    primary: "var(--primary)",
    muted: "oklch(0.24 0.006 260)",
    border: "oklch(0.28 0.006 260)",
    foreground: "oklch(0.95 0.005 260)",
  },
};

/**
 * 提取某个模式下的预览色块。
 *
 * @param tokens 预设在该模式下的 token（可以是空对象）。
 * @param mode 明暗模式。
 * @returns 迷你预览用到的颜色。
 */
export function getSwatch(tokens: TokenMap, mode: ResolvedMode): Swatch {
  const fallback = DEFAULT_SWATCH[mode];
  return {
    background: tokens["--background"] ?? fallback.background,
    card: tokens["--card"] ?? fallback.card,
    sidebar: tokens["--sidebar"] ?? fallback.sidebar,
    primary: fallback.primary,
    muted: tokens["--muted"] ?? fallback.muted,
    border: tokens["--border"] ?? fallback.border,
    foreground: tokens["--foreground"] ?? fallback.foreground,
  };
}