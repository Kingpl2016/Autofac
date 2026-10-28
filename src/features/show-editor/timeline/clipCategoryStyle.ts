import { Bookmark, Clapperboard, Palette, Sparkles, type LucideIcon } from "lucide-react";

import type { ClipCategory } from "../lib/clipVisual";

/** 片段类别在时间线上的图标（片段左上角、图例共用）。 */
export const CLIP_CATEGORY_ICONS: Record<ClipCategory, LucideIcon> = {
  color: Palette,
  effect: Sparkles,
  preset: Bookmark,
  scene: Clapperboard,
};

/** 片段类别的顶部色条（Tailwind 背景类，颜色来自 `globals.css` 的 `--clip-*`）。 */
export const CLIP_CATEGORY_ACCENT: Record<ClipCategory, string> = {
  color: "bg-clip-light",
  effect: "bg-clip-effect",
  preset: "bg-clip-preset",
  scene: "bg-clip-scene",
};

/** 片段类别的文字色（图例里的图标）。 */
export const CLIP_CATEGORY_TEXT: Record<ClipCategory, string> = {
  color: "text-clip-light",
  effect: "text-clip-effect",
  preset: "text-clip-preset",
  scene: "text-clip-scene",
};

/** 图例里列出的类别顺序。 */
export const CLIP_CATEGORIES: readonly ClipCategory[] = ["color", "effect", "preset", "scene"];
