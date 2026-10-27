import { createRegistry, type Disposer, type Registry } from "@/shared/plugin/registry";
import { hexToOklch } from "./oklch";
import { sanitizeTokenMap } from "./tokens";
import type { AccentPreset, FontPreset, ThemePreset, ThemeTokenSet } from "./types";

/** 外观预设注册表：任何插件都可以贡献主题、主色与字体预设。 */
export interface AppearanceRegistry {
  /**
   * 注册整套主题预设；token 会经过白名单过滤，同 id 后注册的覆盖先注册的。
   *
   * @returns 取消注册的函数。
   */
  registerTheme: (preset: ThemePreset) => Disposer;
  /**
   * 注册主色预设；颜色不是合法的十六进制时忽略并给出警告。
   *
   * @returns 取消注册的函数。
   */
  registerAccent: (preset: AccentPreset) => Disposer;
  /**
   * 注册字体预设，同 id 后注册的覆盖先注册的。
   *
   * @returns 取消注册的函数。
   */
  registerFont: (preset: FontPreset) => Disposer;
  /** 主题预设（已排序，无变化时返回同一数组引用）。 */
  themes: Registry<ThemePreset>;
  /** 主色预设。 */
  accents: Registry<AccentPreset>;
  /** 字体预设。 */
  fonts: Registry<FontPreset>;
}

/** 过滤主题 token，只保留白名单内的安全项。 */
function sanitizeThemeTokens(tokens: ThemeTokenSet): ThemeTokenSet {
  return { light: sanitizeTokenMap(tokens.light), dark: sanitizeTokenMap(tokens.dark) };
}

/**
 * 创建外观预设注册表。
 *
 * @returns 空的注册表。
 */
export function createAppearanceRegistry(): AppearanceRegistry {
  const themes = createRegistry<ThemePreset>();
  const accents = createRegistry<AccentPreset>();
  const fonts = createRegistry<FontPreset>();
  return {
    registerTheme: (preset) => themes.register({ ...preset, tokens: sanitizeThemeTokens(preset.tokens) }),
    registerAccent: (preset) => {
      if (!hexToOklch(preset.color)) {
        console.warn(`[appearance] 主色预设 "${preset.id}" 的颜色 "${preset.color}" 不是合法的十六进制，已忽略`);
        return () => {};
      }
      return accents.register(preset);
    },
    registerFont: (preset) => fonts.register(preset),
    themes,
    accents,
    fonts,
  };
}

