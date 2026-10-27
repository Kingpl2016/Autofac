import { ALLOWED_TOKEN_NAMES } from "@/shared/appearance/tokens";
import type { ResolvedMode } from "./appearanceSettings";
import { MANAGED_ATTR_KEYS, type AppearanceAttrs } from "./computeAttrs";
import type { AppearanceVars } from "./computeVars";

/**
 * 把外观应用到 `<html>`：明暗 class、`color-scheme`、CSS 变量与 data 属性。
 *
 * 幂等：每次调用都会先清掉白名单内、但本次不再需要的变量和属性，
 * 因此切换预设或恢复默认后不会残留旧值。
 *
 * @param root 通常是 `document.documentElement`。
 * @param vars 折算好的明暗两套变量。
 * @param attrs 折算好的 data 属性。
 * @param resolved 实际生效的明暗模式。
 */
export function applyAppearance(
  root: HTMLElement,
  vars: AppearanceVars,
  attrs: AppearanceAttrs,
  resolved: ResolvedMode,
): void {
  // 应用的 Tailwind 暗色变体只认 `.dark`；浅色时不加类
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;

  const current = vars[resolved];
  for (const name of ALLOWED_TOKEN_NAMES) {
    const value = current[name];
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }

  for (const key of MANAGED_ATTR_KEYS) {
    const value = attrs[key];
    if (value === undefined) delete root.dataset[key];
    else root.dataset[key] = value;
  }
}
