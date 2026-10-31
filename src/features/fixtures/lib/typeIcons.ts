import {
  Box,
  CloudFog,
  Cylinder,
  Flashlight,
  Grid3x3,
  Lamp,
  LayoutGrid,
  Lightbulb,
  Move,
  Palette,
  RectangleHorizontal,
  ScanLine,
  Sparkle,
  Square,
  Sun,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type { FixtureType } from "./profile";
import type { FixtureShape } from "./types";

/** 灯具类型的图标（灯具库、节目编辑器的轨道头与灯具列表共用）。 */
export const FIXTURE_TYPE_ICONS: Record<FixtureType, LucideIcon> = {
  dimmer: Lightbulb,
  white: Sun,
  mixing: Palette,
  mover: Move,
  other: Lamp,
};

/** 外形模板的内置图标（模型有外观时优先于类型图标）。 */
export const FIXTURE_SHAPE_ICONS: Record<FixtureShape, LucideIcon> = {
  movingHead: Move,
  scanner: ScanLine,
  par: Cylinder,
  wash: Square,
  profile: Flashlight,
  bar: RectangleHorizontal,
  pixelPanel: Grid3x3,
  strobe: Zap,
  blinder: LayoutGrid,
  fogger: CloudFog,
  laser: Sparkle,
  generic: Box,
};
