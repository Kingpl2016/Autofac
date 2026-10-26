import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";
import type { UniverseViewMode } from "../lib/universeView";

/** 落盘的偏好字段。 */
export interface DashboardPrefsData {
  /** 活动宇宙的展示形式。 */
  universeView: UniverseViewMode;
}

interface DashboardPrefsState extends DashboardPrefsData {
  setUniverseView: (view: UniverseViewMode) => void;
}

const VIEWS: readonly UniverseViewMode[] = ["cards", "table"];

/** 偏好默认值。 */
export const DEFAULT_DASHBOARD_PREFS: DashboardPrefsData = { universeView: "cards" };

/**
 * 校验并规整从磁盘读回的偏好：不合法的字段回落到默认值。
 *
 * @param raw 磁盘上读到的未知数据。
 * @returns 一定合法的偏好数据。
 */
export function sanitizeDashboardPrefs(raw: unknown): DashboardPrefsData {
  const r = (raw ?? {}) as Partial<Record<keyof DashboardPrefsData, unknown>>;
  return {
    universeView: VIEWS.includes(r.universeView as UniverseViewMode)
      ? (r.universeView as UniverseViewMode)
      : DEFAULT_DASHBOARD_PREFS.universeView,
  };
}

/**
 * 仪表盘的可保存偏好（活动宇宙的卡片 / 表格切换），经 Tauri Store 插件落盘到
 * `ui-prefs.json`；非 Tauri 环境读写失败时只告警，不影响使用。
 */
export const useDashboardPrefs = create<DashboardPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_DASHBOARD_PREFS,
      setUniverseView: (universeView) => set({ universeView }),
    }),
    {
      name: "dashboard",
      version: 1,
      storage: createTauriPersistStorage<DashboardPrefsData>(),
      partialize: ({ universeView }) => ({ universeView }),
      merge: (persisted, current) =>
        persisted == null ? current : { ...current, ...sanitizeDashboardPrefs(persisted) },
    },
  ),
);