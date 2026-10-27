import { create } from "zustand";

import type { ColorValue } from "../lib/project";

/** 最近使用的颜色最多保留几个。 */
export const MAX_RECENT_COLORS = 10;

interface RecentColorsState {
  colors: ColorValue[];
  /**
   * 记一次使用（移到最前，去重）。
   *
   * @param color 颜色。
   */
  push: (color: ColorValue) => void;
}

/** 色盘的“最近使用”（本次会话内，不随工程保存）。 */
export const useRecentColorsStore = create<RecentColorsState>((set) => ({
  colors: [],
  push: (color) =>
    set((s) => {
      const key = JSON.stringify(color);
      return { colors: [color, ...s.colors.filter((c) => JSON.stringify(c) !== key)].slice(0, MAX_RECENT_COLORS) };
    }),
}));
