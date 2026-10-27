import { contrastRatio, type Oklch } from "@/shared/appearance/oklch";
import { deriveAccentVars } from "./computeVars";
import type { ResolvedMode } from "./appearanceSettings";

/** WCAG AA 对普通文字的最低对比度。 */
export const MIN_TEXT_CONTRAST = 4.5;

/**
 * 计算某个主色在应用里“主按钮文字”的对比度。
 *
 * 应用的 `--primary` 与 `--primary-foreground` 在 `globals.css` 里由强调色色相 / 彩度加固定明度派生：
 * 浅色 `oklch(0.55 c h)` 配 `oklch(0.99 0 0)`，深色 `oklch(0.7 c*0.8 h)` 配 `oklch(0.16 0.01 260)`。
 * 这里按同样的公式算出对比度，供个性化面板提示用户所选主色是否达到 WCAG AA。
 *
 * @param color 十六进制主色。
 * @param mode 实际生效的明暗模式。
 * @returns 对比度（1 到 21）；颜色不合法时为 null。
 */
export function getAccentContrast(color: string, mode: ResolvedMode): number | null {
  const vars = deriveAccentVars(color);
  const hue = Number(vars["--accent-h"]);
  const chroma = Number(vars["--accent-c"]);
  if (!Number.isFinite(hue) || !Number.isFinite(chroma)) return null;
  const background: Oklch = mode === "light" ? { l: 0.55, c: chroma, h: hue } : { l: 0.7, c: chroma * 0.8, h: hue };
  const foreground: Oklch = mode === "light" ? { l: 0.99, c: 0, h: 0 } : { l: 0.16, c: 0.01, h: 260 };
  return contrastRatio(background, foreground);
}
