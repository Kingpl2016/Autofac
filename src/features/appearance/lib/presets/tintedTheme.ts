import { formatOklch } from "@/shared/appearance/oklch";
import type { ThemeTokenSet, TokenMap } from "@/shared/appearance/types";

/** 生成参数。 */
interface TintedThemeOptions {
  /** 表面色的色相角，0 到 360。 */
  hue: number;
  /** 表面色的基础色度，通常 0.005 到 0.04；越大越有“染色”感。 */
  chroma: number;
}

/**
 * 生成一套带色相的表面主题 token。
 *
 * 亮度沿用应用 `globals.css` 里的层级（凹陷 < 背景 < 面板 < 抬升），只是给每个表面色加上同一色相的少量色度，
 * 因此整体对比度与默认主题接近。主色（`--primary` 等）、状态语义色刻意不出现在结果里：
 * 它们由主色预设与全局令牌控制，换主题不会改变录制红、在线绿的含义。
 *
 * @param options 生成参数。
 * @returns 明暗两套 token。
 */
export function createTintedTheme({ hue, chroma }: TintedThemeOptions): ThemeTokenSet {
  /** 按色相生成颜色：`scale` 是相对基础色度的倍数。 */
  const tint = (l: number, scale = 1): string => formatOklch({ l, c: chroma * scale, h: hue });

  const light: TokenMap = {
    "--background": tint(0.99, 0.25),
    "--foreground": tint(0.18, 0.6),
    "--card": tint(1, 0.1),
    "--card-foreground": tint(0.18, 0.6),
    "--popover": tint(1, 0.1),
    "--popover-foreground": tint(0.18, 0.6),
    "--secondary": tint(0.96, 0.6),
    "--secondary-foreground": tint(0.22, 0.6),
    "--muted": tint(0.96, 0.6),
    "--muted-foreground": tint(0.52, 0.8),
    "--accent": tint(0.95, 0.8),
    "--accent-foreground": tint(0.22, 0.6),
    "--border": tint(0.9, 0.7),
    "--input": tint(0.9, 0.7),
    "--surface-1": tint(0.965, 0.5),
    "--surface-2": tint(1, 0.1),
    "--surface-3": tint(0.975, 0.9),
    "--sidebar": tint(0.97, 0.7),
    "--sidebar-foreground": tint(0.2, 0.6),
    "--sidebar-accent": tint(0.95, 0.9),
    "--sidebar-accent-foreground": tint(0.22, 0.6),
    "--sidebar-border": tint(0.9, 0.7),
  };

  const dark: TokenMap = {
    "--background": tint(0.16, 0.8),
    "--foreground": tint(0.95, 0.1),
    "--card": tint(0.19, 0.8),
    "--card-foreground": tint(0.95, 0.1),
    "--popover": tint(0.2, 0.8),
    "--popover-foreground": tint(0.95, 0.1),
    "--secondary": tint(0.26, 0.7),
    "--secondary-foreground": tint(0.95, 0.1),
    "--muted": tint(0.24, 0.7),
    "--muted-foreground": tint(0.68, 0.8),
    "--accent": tint(0.28, 0.7),
    "--accent-foreground": tint(0.95, 0.1),
    "--border": tint(0.28, 0.7),
    "--input": tint(0.3, 0.7),
    "--surface-1": tint(0.135, 0.7),
    "--surface-2": tint(0.215, 0.8),
    "--surface-3": tint(0.28, 0.9),
    "--sidebar": tint(0.18, 0.8),
    "--sidebar-foreground": tint(0.92, 0.1),
    "--sidebar-accent": tint(0.28, 0.7),
    "--sidebar-accent-foreground": tint(0.95, 0.1),
    "--sidebar-border": tint(0.26, 0.7),
  };

  return { light, dark };
}
