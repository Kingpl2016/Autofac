import { z } from "zod";

import { backgroundSchema, getDefaultBackground, type BackgroundSettings } from "@/shared/appearance/background";
import { isSafeTokenValue, sanitizeTokenMap } from "@/shared/appearance/tokens";
import type { ThemeTokenSet } from "@/shared/appearance/types";

/** 用户可选的明暗模式：浅色 / 深色 / 跟随系统。 */
export type ThemeMode = "light" | "dark" | "system";

/** 全部明暗模式（展示顺序）。 */
export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

/** 实际生效的明暗模式（不含 system）。 */
export type ResolvedMode = "light" | "dark";

/** 界面密度。 */
export const DENSITIES = ["compact", "default", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];

/** 卡片样式：outline 描边，elevated 悬浮阴影，flat 扁平填充，glass 毛玻璃，soft 柔和，gradient 渐变。 */
export const CARD_STYLES = ["outline", "elevated", "flat", "glass", "soft", "gradient"] as const;
export type CardStyle = (typeof CARD_STYLES)[number];

/** 卡片悬停反馈：none 无，lift 抬起，glow 光晕，spotlight 聚光灯，glare 高光扫过，tilt 倾斜。 */
export const CARD_HOVERS = ["none", "lift", "glow", "spotlight", "glare", "tilt"] as const;
export type CardHover = (typeof CARD_HOVERS)[number];

/** 卡片描边宽度选项，单位 px。 */
export const CARD_BORDER_WIDTHS = [1, 2, 3] as const;
export type CardBorderWidth = (typeof CARD_BORDER_WIDTHS)[number];

/** 毛玻璃卡片的模糊半径范围，单位 px。 */
export const CARD_BLUR_RANGE = { min: 4, max: 32, defaultValue: 14 } as const;

/** 卡片阴影强度。 */
export const CARD_SHADOWS = ["none", "sm", "md", "lg"] as const;
export type CardShadow = (typeof CARD_SHADOWS)[number];

/** 卡片内边距，取值与界面密度一致。 */
export const CARD_PADDINGS = ["compact", "default", "comfortable"] as const;
export type CardPadding = (typeof CARD_PADDINGS)[number];

/** 卡片圆角的取值范围，单位 rem。 */
export const CARD_RADIUS_RANGE = { min: 0, max: 2 } as const;

/** 页面背景特效：none 无，aurora 极光，flow 流光，dots 点阵，grid 网格，grain 颗粒。 */
export const BACKGROUND_EFFECTS = ["none", "aurora", "flow", "dots", "grid", "grain"] as const;
export type BackgroundEffect = (typeof BACKGROUND_EFFECTS)[number];

/** 动态背景速度。 */
export const BACKGROUND_SPEEDS = ["slow", "normal", "fast"] as const;
export type BackgroundSpeed = (typeof BACKGROUND_SPEEDS)[number];

/** 背景强度。 */
export const BACKGROUND_INTENSITIES = ["soft", "normal", "strong"] as const;
export type BackgroundIntensity = (typeof BACKGROUND_INTENSITIES)[number];

/** 焦点环：keyboard 仅键盘导航时显示（默认），strong 更醒目。 */
export const FOCUS_RINGS = ["keyboard", "strong"] as const;
export type FocusRing = (typeof FOCUS_RINGS)[number];

/** 动效偏好：system 跟随系统（默认），reduce 减少动画，full 保留全部动画。 */
export const MOTIONS = ["system", "reduce", "full"] as const;
export type Motion = (typeof MOTIONS)[number];

/** 内容区最大宽度：narrow 适合阅读，default 为标准宽度，full 铺满（默认）。 */
export const CONTENT_WIDTHS = ["narrow", "default", "full"] as const;
export type ContentWidth = (typeof CONTENT_WIDTHS)[number];

/** 侧栏样式：standard 通栏贴边（默认），floating 悬浮卡片，inset 内容区做成圆角卡片。 */
export const SIDEBAR_STYLES = ["standard", "floating", "inset"] as const;
export type SidebarStyle = (typeof SIDEBAR_STYLES)[number];

/** 侧栏折叠方式：icon 可折叠为图标栏（默认），none 固定展开、不可折叠。 */
export const SIDEBAR_COLLAPSIBLES = ["icon", "none"] as const;
export type SidebarCollapsible = (typeof SIDEBAR_COLLAPSIBLES)[number];

/** 圆角的取值范围，单位 rem。默认值与 `globals.css` 的 `--radius` 一致。 */
export const RADIUS_RANGE = { min: 0, max: 1.25, step: 0.025, defaultValue: 0.5 } as const;

/** 界面缩放的取值范围，单位百分比。 */
export const SCALE_RANGE = { min: 90, max: 115, step: 5, defaultValue: 100 } as const;

/** 用户选定的整套主题（拷贝了 token，因此即使预设来源插件被移除也保持不变）。 */
export interface ThemeSelection {
  /** 预设 id。 */
  id: string;
  /** 明暗两套 token。 */
  tokens: ThemeTokenSet;
}

/** 用户选定的主色。 */
export interface AccentSelection {
  /** 预设 id；自定义取色为 `custom`。 */
  id: string;
  /** 十六进制主色。 */
  color: string;
}

/** 用户选定的字体。 */
export interface FontSelection {
  /** 预设 id。 */
  id: string;
  /** 无衬线字体栈。 */
  sans: string;
  /** 等宽字体栈。 */
  mono?: string;
}

/** 外观设置（会被持久化）。 */
export interface AppearanceSettings {
  /** 明暗模式。 */
  mode: ThemeMode;
  /** 整套主题；null 表示使用 `globals.css` 里的默认配色。 */
  theme: ThemeSelection | null;
  /** 主色；null 表示使用默认强调色。 */
  accent: AccentSelection | null;
  /** 基础圆角（rem）；null 表示使用默认值。 */
  radius: number | null;
  /** 字体；null 表示使用默认字体。 */
  font: FontSelection | null;
  /** 界面缩放（百分比）；null 表示 100%。 */
  scale: number | null;
  /** 界面密度。 */
  density: Density;
  /** 侧栏样式。 */
  sidebarStyle: SidebarStyle;
  /** 侧栏折叠方式。 */
  sidebarCollapsible: SidebarCollapsible;
  /** 是否显示底部状态条（系统日志与包速率）。 */
  statusBar: boolean;
  /** 内容区最大宽度。 */
  contentWidth: ContentWidth;
  /** 卡片样式。 */
  cardStyle: CardStyle;
  /** 卡片阴影强度。 */
  cardShadow: CardShadow;
  /** 卡片圆角（rem）；null 表示跟随全局圆角。 */
  cardRadius: number | null;
  /** 卡片内边距。 */
  cardPadding: CardPadding;
  /** 卡片悬停反馈。 */
  cardHover: CardHover;
  /** 卡片顶部是否显示主色强调条。 */
  cardAccent: boolean;
  /** 卡片描边宽度（px）。 */
  cardBorderWidth: CardBorderWidth;
  /** 卡片页眉与页脚是否带分隔线。 */
  cardDividers: boolean;
  /** 描边是否使用渐变。 */
  cardGradientBorder: boolean;
  /** 是否带发光边框。 */
  cardGlow: boolean;
  /** 毛玻璃卡片的模糊半径（px）；null 表示默认。 */
  cardBlur: number | null;
  /** 页面背景特效。 */
  bgEffect: BackgroundEffect;
  /** 自定义背景（渐变、图片、着色器、粒子、视频等）；媒体文件本身存在 IndexedDB，这里只有元数据。 */
  background: BackgroundSettings;
  /** 背景特效是否动起来。 */
  bgAnimated: boolean;
  /** 动态背景速度。 */
  bgSpeed: BackgroundSpeed;
  /** 背景强度。 */
  bgIntensity: BackgroundIntensity;
  /** 按钮按下时的缩放反馈。 */
  pressFeedback: boolean;
  /** 切换页面时内容淡入上浮。 */
  entrance: boolean;
  /** 骨架屏的流光。 */
  shimmer: boolean;
  /** 细滚动条。 */
  thinScrollbar: boolean;
  /** 焦点环。 */
  focusRing: FocusRing;
  /** 动效偏好。 */
  motion: Motion;
  /** 切换页面时是否使用淡入淡出的过渡动画（浏览器 View Transition）。 */
  pageTransition: boolean;
}

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.-]+$/);

// 缺失的一侧（如只有 light）补为空对象；取值经过白名单过滤
const tokenMapSchema = z
  .preprocess((value) => value ?? {}, z.record(z.string(), z.unknown()))
  .transform((value) => sanitizeTokenMap(value));

const themeTokenSetSchema = z.object({ light: tokenMapSchema, dark: tokenMapSchema });

const fontStackSchema = z
  .string()
  .refine((value) => isSafeTokenValue("--font-sans", value), { message: "字体栈包含不安全的内容" })
  .transform((value) => value.trim());

/**
 * 获取一份全新的默认设置。
 *
 * @returns 默认设置；应用以深色为默认主题（现场操作员多在暗环境作业）。
 */
export function getDefaultSettings(): AppearanceSettings {
  return {
    mode: "dark",
    theme: null,
    accent: null,
    radius: null,
    font: null,
    scale: null,
    density: "default",
    sidebarStyle: "standard",
    sidebarCollapsible: "icon",
    statusBar: true,
    contentWidth: "full",
    cardStyle: "outline",
    cardShadow: "sm",
    cardRadius: null,
    cardPadding: "default",
    cardHover: "none",
    cardAccent: false,
    cardBorderWidth: 1,
    cardDividers: false,
    cardGradientBorder: false,
    cardGlow: false,
    cardBlur: null,
    bgEffect: "none",
    background: getDefaultBackground(),
    bgAnimated: false,
    bgSpeed: "normal",
    bgIntensity: "normal",
    pressFeedback: false,
    entrance: false,
    shimmer: false,
    thinScrollbar: false,
    focusRing: "keyboard",
    motion: "system",
    pageTransition: false,
  };
}

const settingsSchema = z.object({
  mode: z.enum(["light", "dark", "system"]).catch("dark"),
  theme: z.object({ id: idSchema, tokens: themeTokenSetSchema }).nullable().catch(null),
  accent: z
    .object({ id: idSchema, color: z.string().regex(/^#[\da-f]{6}$/i) })
    .nullable()
    .catch(null),
  radius: z.number().min(RADIUS_RANGE.min).max(RADIUS_RANGE.max).nullable().catch(null),
  font: z
    .object({ id: idSchema, sans: fontStackSchema, mono: fontStackSchema.optional() })
    .nullable()
    .catch(null),
  scale: z.number().min(SCALE_RANGE.min).max(SCALE_RANGE.max).nullable().catch(null),
  density: z.enum(DENSITIES).catch("default"),
  sidebarStyle: z.enum(SIDEBAR_STYLES).catch("standard"),
  sidebarCollapsible: z.enum(SIDEBAR_COLLAPSIBLES).catch("icon"),
  statusBar: z.boolean().catch(true),
  contentWidth: z.enum(CONTENT_WIDTHS).catch("full"),
  cardStyle: z.enum(CARD_STYLES).catch("outline"),
  cardShadow: z.enum(CARD_SHADOWS).catch("sm"),
  cardRadius: z.number().min(CARD_RADIUS_RANGE.min).max(CARD_RADIUS_RANGE.max).nullable().catch(null),
  cardPadding: z.enum(CARD_PADDINGS).catch("default"),
  cardHover: z.enum(CARD_HOVERS).catch("none"),
  cardAccent: z.boolean().catch(false),
  cardBorderWidth: z.union([z.literal(1), z.literal(2), z.literal(3)]).catch(1),
  cardDividers: z.boolean().catch(false),
  cardGradientBorder: z.boolean().catch(false),
  cardGlow: z.boolean().catch(false),
  cardBlur: z.number().min(CARD_BLUR_RANGE.min).max(CARD_BLUR_RANGE.max).nullable().catch(null),
  bgEffect: z.enum(BACKGROUND_EFFECTS).catch("none"),
  background: backgroundSchema.catch(getDefaultBackground()),
  bgAnimated: z.boolean().catch(false),
  bgSpeed: z.enum(BACKGROUND_SPEEDS).catch("normal"),
  bgIntensity: z.enum(BACKGROUND_INTENSITIES).catch("normal"),
  pressFeedback: z.boolean().catch(false),
  entrance: z.boolean().catch(false),
  shimmer: z.boolean().catch(false),
  thinScrollbar: z.boolean().catch(false),
  focusRing: z.enum(FOCUS_RINGS).catch("keyboard"),
  motion: z.enum(MOTIONS).catch("system"),
  pageTransition: z.boolean().catch(false),
});

/**
 * 校验并清洗任意来源的外观设置。
 *
 * 每个字段独立兜底：某个字段非法只会让它回到默认值，不影响其他字段。
 * 用户可能手动改过存储文件，因此即使版本号相同也要经过这里。
 *
 * @param raw 待清洗的数据。
 * @returns 完整且安全的外观设置。
 */
export function sanitizeSettings(raw: unknown): AppearanceSettings {
  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  return settingsSchema.parse(input);
}

/**
 * 从包含其他字段（如 store 里的 action）的对象中提取纯数据的设置。
 *
 * @param source 含有全部设置字段的对象。
 * @returns 只包含设置字段的新对象。
 */
export function pickSettings(source: AppearanceSettings): AppearanceSettings {
  return {
    mode: source.mode,
    theme: source.theme,
    accent: source.accent,
    radius: source.radius,
    font: source.font,
    scale: source.scale,
    density: source.density,
    sidebarStyle: source.sidebarStyle,
    sidebarCollapsible: source.sidebarCollapsible,
    statusBar: source.statusBar,
    contentWidth: source.contentWidth,
    cardStyle: source.cardStyle,
    cardShadow: source.cardShadow,
    cardRadius: source.cardRadius,
    cardPadding: source.cardPadding,
    cardHover: source.cardHover,
    cardAccent: source.cardAccent,
    cardBorderWidth: source.cardBorderWidth,
    cardDividers: source.cardDividers,
    cardGradientBorder: source.cardGradientBorder,
    cardGlow: source.cardGlow,
    cardBlur: source.cardBlur,
    bgEffect: source.bgEffect,
    background: source.background,
    bgAnimated: source.bgAnimated,
    bgSpeed: source.bgSpeed,
    bgIntensity: source.bgIntensity,
    pressFeedback: source.pressFeedback,
    entrance: source.entrance,
    shimmer: source.shimmer,
    thinScrollbar: source.thinScrollbar,
    focusRing: source.focusRing,
    motion: source.motion,
    pageTransition: source.pageTransition,
  };
}
