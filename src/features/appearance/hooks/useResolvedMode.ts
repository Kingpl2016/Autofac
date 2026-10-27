import { useObservable } from "@/shared/events/useObservable";
import type { ResolvedMode } from "../lib/appearanceSettings";
import { readSystemMode, systemMode$ } from "../lib/systemTheme";
import { useAppearanceStore } from "../stores/useAppearanceStore";

/**
 * 实际生效的明暗模式：`跟随系统` 时随系统偏好实时变化。
 * 需要把明暗传给第三方库（图表、画布、Toaster 等）时使用，而不是直接读 store 里的 `mode`。
 *
 * @returns `light` 或 `dark`。
 */
export function useResolvedMode(): ResolvedMode {
  const mode = useAppearanceStore((s) => s.mode);
  const system = useObservable(systemMode$, readSystemMode());
  return mode === "system" ? system : mode;
}

/**
 * 外观修订标记：明暗、主题或主色任何一项变化时它的值就会变化。
 * 在 canvas 里用 `getComputedStyle` 读取主题色的组件把它放进依赖，主题一变就重绘。
 *
 * @returns 一个只用于比较是否相等的字符串。
 */
export function useAppearanceRevision(): string {
  const resolved = useResolvedMode();
  const themeId = useAppearanceStore((s) => s.theme?.id ?? "");
  const accent = useAppearanceStore((s) => s.accent?.color ?? "");
  return `${resolved}|${themeId}|${accent}`;
}
