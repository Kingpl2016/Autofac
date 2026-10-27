import type { AppearanceRegistry } from "@/shared/appearance/registry";
import type { AccentPreset, FontPreset, ThemePreset } from "@/shared/appearance/types";
import { createTintedTheme } from "./tintedTheme";

/** 默认主题的 id：对应 `globals.css` 里的原始配色，选中它等于清除主题覆盖。 */
export const DEFAULT_THEME_ID = "default";
/** 默认字体的 id：对应不覆盖字体变量。 */
export const DEFAULT_FONT_ID = "default";

/** 带色相的主题定义：id、英文名、分组、色相、色度。 */
type TintedThemeDefinition = readonly [id: string, label: string, group: string, hue: number, chroma: number];

/**
 * 内置主题的定义，顺序即展示顺序，按分组排列。
 *
 * - neutral：几乎无色或只带一点冷暖倾向，适合控台类应用
 * - nature：来自自然的绿、青、土色
 * - warm：暖色系，从蜜橘到玫红
 * - cool：冷色系，从海蓝到紫罗兰
 */
const TINTED_THEMES: readonly TintedThemeDefinition[] = [
  ["slate", "Slate", "neutral", 255, 0.03],
  ["stone", "Stone", "neutral", 70, 0.012],
  ["graphite", "Graphite", "neutral", 250, 0.006],
  ["paper", "Paper", "neutral", 90, 0.01],
  ["ink", "Ink", "neutral", 0, 0],
  ["forest", "Forest", "nature", 150, 0.025],
  ["mint", "Mint", "nature", 175, 0.02],
  ["aurora", "Aurora", "nature", 178, 0.03],
  ["olive", "Olive", "nature", 120, 0.02],
  ["sand", "Sand", "nature", 85, 0.012],
  ["honey", "Honey", "warm", 85, 0.022],
  ["sunset", "Sunset", "warm", 55, 0.02],
  ["peach", "Peach", "warm", 40, 0.018],
  ["coffee", "Coffee", "warm", 55, 0.018],
  ["sakura", "Sakura", "warm", 350, 0.016],
  ["rose", "Rose", "warm", 10, 0.02],
  ["ruby", "Ruby", "warm", 20, 0.02],
  ["plum", "Plum", "warm", 335, 0.02],
  ["ocean", "Ocean", "cool", 235, 0.03],
  ["polar", "Polar", "cool", 225, 0.02],
  ["sapphire", "Sapphire", "cool", 255, 0.03],
  ["cyber", "Cyber", "cool", 195, 0.03],
  ["midnight", "Midnight", "cool", 268, 0.035],
  ["twilight", "Twilight", "cool", 285, 0.03],
  ["violet", "Violet", "cool", 295, 0.03],
  ["lavender", "Lavender", "cool", 300, 0.02],
];

/** 内置整套主题。 */
export const BUILTIN_THEMES: readonly ThemePreset[] = [
  {
    id: DEFAULT_THEME_ID,
    label: "Default",
    labelKey: "appearance.presets.themes.default",
    group: "neutral",
    order: 0,
    tokens: { light: {}, dark: {} },
  },
  ...TINTED_THEMES.map(
    ([id, label, group, hue, chroma], index): ThemePreset => ({
      id,
      label,
      labelKey: `appearance.presets.themes.${id}`,
      group,
      order: (index + 1) * 10,
      tokens: createTintedTheme({ hue, chroma }),
    }),
  ),
];

/**
 * 内置主色的定义，顺序即展示顺序，大致沿色相环排列，最后是几种沉稳的灰色调。
 * 前六个 id（blue / cyan / green / orange / violet / rose）与旧版本的强调色同名，用于迁移。
 */
const ACCENT_COLORS: readonly (readonly [id: string, label: string, color: string])[] = [
  ["red", "Red", "#ef4444"],
  ["coral", "Coral", "#f97362"],
  ["orange", "Orange", "#f97316"],
  ["amber", "Amber", "#f59e0b"],
  ["yellow", "Yellow", "#eab308"],
  ["lime", "Lime", "#84cc16"],
  ["olive", "Olive", "#4d7c0f"],
  ["green", "Green", "#16a34a"],
  ["emerald", "Emerald", "#10b981"],
  ["teal", "Teal", "#0d9488"],
  ["cyan", "Cyan", "#0891b2"],
  ["sky", "Sky", "#0ea5e9"],
  ["blue", "Blue", "#3b82f6"],
  ["navy", "Navy", "#1e3a8a"],
  ["indigo", "Indigo", "#6366f1"],
  ["violet", "Violet", "#8b5cf6"],
  ["purple", "Purple", "#a855f7"],
  ["fuchsia", "Fuchsia", "#d946ef"],
  ["pink", "Pink", "#ec4899"],
  ["rose", "Rose", "#e11d48"],
  ["wine", "Wine", "#9f1239"],
  ["brown", "Brown", "#92400e"],
  ["slate", "Slate", "#475569"],
  ["zinc", "Zinc", "#52525b"],
];

/** 内置主色。 */
export const BUILTIN_ACCENTS: readonly AccentPreset[] = ACCENT_COLORS.map(
  ([id, label, color], index): AccentPreset => ({
    id,
    label,
    labelKey: `appearance.presets.accents.${id}`,
    color,
    order: (index + 1) * 10,
  }),
);

/** 字体定义：id、英文名、分组、无衬线字体栈与可选的等宽字体栈。 */
type FontDefinition = readonly [id: string, label: string, group: string, sans: string, mono?: string];

/**
 * 内置字体：全部是系统字体栈，不会下载任何字体文件；每个字体栈都以该字体开头，后面跟同类字体作后备，
 * 所以在没有安装该字体的系统上会优雅回退。
 */
const FONT_STACKS: readonly FontDefinition[] = [
  // 默认字体：选中时不写入覆盖，实际字体栈由 globals.css 决定
  [DEFAULT_FONT_ID, "Inter", "sans", "\"Inter\", ui-sans-serif, system-ui, sans-serif"],
  ["system-ui", "System UI", "sans", "ui-sans-serif, system-ui, sans-serif"],
  ["arial", "Arial", "sans", "Arial, 'Helvetica Neue', Helvetica, sans-serif"],
  ["helvetica", "Helvetica", "sans", "'Helvetica Neue', Helvetica, Arial, sans-serif"],
  ["verdana", "Verdana", "sans", "Verdana, Geneva, sans-serif"],
  ["tahoma", "Tahoma", "sans", "Tahoma, Geneva, Verdana, sans-serif"],
  ["trebuchet", "Trebuchet MS", "sans", "'Trebuchet MS', 'Lucida Grande', 'Lucida Sans Unicode', sans-serif"],
  ["segoe", "Segoe UI", "sans", "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"],
  ["roboto", "Roboto", "sans", "Roboto, 'Helvetica Neue', Arial, sans-serif"],
  ["sf", "San Francisco", "sans", "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"],
  ["yahei", "Microsoft YaHei", "chinese", "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', sans-serif"],
  ["pingfang", "PingFang SC", "chinese", "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"],
  [
    "noto-sc",
    "Noto Sans SC",
    "chinese",
    "'Noto Sans SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  ],
  ["hei", "SimHei", "chinese", "SimHei, 'Heiti SC', STHeiti, 'Microsoft YaHei', sans-serif"],
  ["song", "SimSun", "chinese", "SimSun, 'Songti SC', STSong, 'Noto Serif CJK SC', serif"],
  ["kai", "KaiTi", "chinese", "KaiTi, 'Kaiti SC', STKaiti, 'Noto Serif CJK SC', serif"],
  ["fangsong", "FangSong", "chinese", "FangSong, FangSong_GB2312, STFangsong, 'Noto Serif CJK SC', serif"],
  ["serif", "Serif", "serif", "ui-serif, Georgia, Cambria, 'Times New Roman', 'Songti SC', 'Noto Serif CJK SC', serif"],
  ["georgia", "Georgia", "serif", "Georgia, 'Times New Roman', serif"],
  ["times", "Times New Roman", "serif", "'Times New Roman', Times, serif"],
  ["palatino", "Palatino", "serif", "'Palatino Linotype', Palatino, 'Book Antiqua', serif"],
  [
    "mono",
    "Monospace",
    "mono",
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  ],
  [
    "consolas",
    "Consolas",
    "mono",
    "Consolas, 'Lucida Console', 'Courier New', monospace",
    "Consolas, 'Lucida Console', 'Courier New', monospace",
  ],
  ["courier", "Courier New", "mono", "'Courier New', Courier, monospace", "'Courier New', Courier, monospace"],
  [
    "menlo",
    "Menlo",
    "mono",
    "Menlo, Monaco, 'SF Mono', Consolas, monospace",
    "Menlo, Monaco, 'SF Mono', Consolas, monospace",
  ],
];

/** 内置字体。 */
export const BUILTIN_FONTS: readonly FontPreset[] = FONT_STACKS.map(
  ([id, label, group, sans, mono], index): FontPreset => ({
    id,
    label,
    labelKey: `appearance.presets.fonts.${id === DEFAULT_FONT_ID ? "system" : id}`,
    group,
    order: (index + 1) * 10,
    sans,
    mono,
  }),
);

/**
 * 把内置预设注册到预设注册表。
 *
 * @param registry 预设注册表。
 * @returns 取消全部注册的函数。
 */
export function registerBuiltinPresets(registry: AppearanceRegistry): () => void {
  const disposers = [
    ...BUILTIN_THEMES.map((preset) => registry.registerTheme(preset)),
    ...BUILTIN_ACCENTS.map((preset) => registry.registerAccent(preset)),
    ...BUILTIN_FONTS.map((preset) => registry.registerFont(preset)),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
