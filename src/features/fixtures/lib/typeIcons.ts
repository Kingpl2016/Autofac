import { Lamp, Lightbulb, Move, Palette, Sun, type LucideIcon } from "lucide-react";

import type { FixtureType } from "./profile";

/** 灯具类型的图标（灯具库、节目编辑器的轨道头与灯具列表共用）。 */
export const FIXTURE_TYPE_ICONS: Record<FixtureType, LucideIcon> = {
  dimmer: Lightbulb,
  white: Sun,
  mixing: Palette,
  mover: Move,
  other: Lamp,
};
