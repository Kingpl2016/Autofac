import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistPrefs, prefsSanitizer } from "@/shared/stores/persistPrefs";
import type { UniverseViewMode } from "../lib/universeView";

/** 落盘的偏好字段。 */
export interface DashboardPrefsData {
  /** 活动宇宙的展示形式。 */
  universeView: UniverseViewMode;
}

interface DashboardPrefsState extends DashboardPrefsData {
  setUniverseView: (view: UniverseViewMode) => void;
}

/** 偏好默认值。 */
export const DEFAULT_DASHBOARD_PREFS: DashboardPrefsData = { universeView: "cards" };

/** 落盘字段与兜底规则。 */
const schema = z.object({
  universeView: z.enum(["cards", "table"]).catch(DEFAULT_DASHBOARD_PREFS.universeView),
}) satisfies z.ZodType<DashboardPrefsData>;

/** 校验并规整从磁盘读回的偏好：不合法的字段回落到默认值。 */
export const sanitizeDashboardPrefs = prefsSanitizer(schema);

/**
 * 仪表盘的可保存偏好（活动宇宙的卡片 / 表格切换），经 Tauri Store 插件落盘到 `ui-prefs.json`。
 */
export const useDashboardPrefs = create<DashboardPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_DASHBOARD_PREFS,
      setUniverseView: (universeView) => set({ universeView }),
    }),
    persistPrefs<DashboardPrefsState, DashboardPrefsData>({ name: "dashboard", version: 1, schema }),
  ),
);
