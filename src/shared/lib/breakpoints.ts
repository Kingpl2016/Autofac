/**
 * 布局断点的媒体查询（与 Tailwind 默认断点一致）。媒体查询里的 `rem` 按浏览器初始字号（16px）计算，
 * 不受界面缩放影响，所以 `80rem` 与 `1280px` 等价。
 */

/** Tailwind `lg`（1024px）。 */
export const MEDIA_LG = "(min-width: 64rem)";
/** Tailwind `xl`（1280px）。 */
export const MEDIA_XL = "(min-width: 80rem)";
/** Tailwind `2xl`（1536px）。 */
export const MEDIA_2XL = "(min-width: 96rem)";
/** 用户要求减少动态效果。 */
export const MEDIA_REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
