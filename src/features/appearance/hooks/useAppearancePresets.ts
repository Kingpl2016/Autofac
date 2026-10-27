import { useRegistryItems } from "@/shared/plugin/registry";
import { usePluginHost } from "@/shared/plugin";
import type { AccentPreset, FontPreset, ThemePreset } from "@/shared/appearance/types";

/**
 * 订阅外观预设注册表：任何插件新注册的主题、主色或字体都会立即出现在个性化面板里。
 *
 * @returns 主题、主色与字体预设（已排序）。
 */
export function useAppearancePresets(): {
  themes: readonly ThemePreset[];
  accents: readonly AccentPreset[];
  fonts: readonly FontPreset[];
} {
  const { appearance } = usePluginHost();
  return {
    themes: useRegistryItems(appearance.themes),
    accents: useRegistryItems(appearance.accents),
    fonts: useRegistryItems(appearance.fonts),
  };
}
