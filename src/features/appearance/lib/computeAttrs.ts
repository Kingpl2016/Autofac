import type { AppearanceSettings } from "./appearanceSettings";

/** data 属性集合：键为 dataset 的驼峰写法，值为属性值；默认值不出现在结果里。 */
export type AppearanceAttrs = Readonly<Record<string, string>>;

/**
 * 外观插件管理的全部 data 属性（`dataset` 驼峰键）。
 *
 * 新增由设置驱动的属性时，需要同时加入这里与 {@link computeAttrs}。
 * 应用时会清掉这里列出、但本次不再需要的属性，所以切换设置后不会残留旧值。
 */
export const MANAGED_ATTR_KEYS = [
  "sidebarStyle",
  "sidebarCollapsible",
  "statusBar",
  "contentWidth",
  "cardStyle",
  "cardShadow",
  "cardPadding",
  "cardHover",
  "cardAccent",
  "cardBorder",
  "cardDividers",
  "cardGradientBorder",
  "cardGlow",
  "customBg",
  "bgEffect",
  "bgAnimated",
  "bgSpeed",
  "bgIntensity",
  "pressFeedback",
  "entrance",
  "shimmer",
  "thinScrollbar",
  "focusRing",
  "pageTransition",
  "motion",
] as const;

/**
 * 折算外观设置得到的 data 属性。
 *
 * 约定“默认值不写属性”，因此未设置时和原来的外观完全一样，样式规则只需针对非默认值。
 *
 * @param settings 外观设置。
 * @returns 非默认值的 data 属性；设置全部为默认值时为空对象。
 */
export function computeAttrs(settings: AppearanceSettings): AppearanceAttrs {
  const attrs: Record<string, string> = {};
  if (settings.sidebarStyle !== "standard") attrs.sidebarStyle = settings.sidebarStyle;
  if (settings.sidebarCollapsible !== "icon") attrs.sidebarCollapsible = settings.sidebarCollapsible;
  if (!settings.statusBar) attrs.statusBar = "off";
  if (settings.contentWidth !== "full") attrs.contentWidth = settings.contentWidth;
  if (settings.cardStyle !== "outline") attrs.cardStyle = settings.cardStyle;
  if (settings.cardShadow !== "sm") attrs.cardShadow = settings.cardShadow;
  if (settings.cardPadding !== "default") attrs.cardPadding = settings.cardPadding;
  if (settings.cardHover !== "none") attrs.cardHover = settings.cardHover;
  if (settings.cardAccent) attrs.cardAccent = "on";
  if (settings.cardBorderWidth !== 1) attrs.cardBorder = String(settings.cardBorderWidth);
  if (settings.cardDividers) attrs.cardDividers = "on";
  if (settings.cardGradientBorder) attrs.cardGradientBorder = "on";
  if (settings.cardGlow) attrs.cardGlow = "on";
  // 自定义背景启用时，页面容器要让出底色，样式据此切换
  if (settings.background.type !== "none") attrs.customBg = "on";
  if (settings.bgEffect !== "none") {
    attrs.bgEffect = settings.bgEffect;
    // 动态、速度与强度只在选了背景特效时才有意义，避免无谓地写属性
    if (settings.bgAnimated) attrs.bgAnimated = "on";
    if (settings.bgSpeed !== "normal") attrs.bgSpeed = settings.bgSpeed;
    if (settings.bgIntensity !== "normal") attrs.bgIntensity = settings.bgIntensity;
  }
  if (settings.pressFeedback) attrs.pressFeedback = "on";
  if (settings.entrance) attrs.entrance = "on";
  if (settings.shimmer) attrs.shimmer = "on";
  if (settings.thinScrollbar) attrs.thinScrollbar = "on";
  if (settings.focusRing !== "keyboard") attrs.focusRing = settings.focusRing;
  if (settings.pageTransition) attrs.pageTransition = "on";
  // system 交给 CSS 的 prefers-reduced-motion 媒体查询处理，不需要属性
  if (settings.motion !== "system") attrs.motion = settings.motion;
  return attrs;
}
