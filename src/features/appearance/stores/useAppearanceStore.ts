import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";
import {
  getDefaultSettings,
  pickSettings,
  sanitizeSettings,
  type AppearanceSettings,
  type ThemeMode,
} from "../lib/appearanceSettings";

/** 外观设置在界面偏好文件里的键。 */
export const APPEARANCE_STORAGE_KEY = "appearance";

/** 外观设置的落盘适配器（也用于判断是否已有保存的设置，以决定是否迁移旧偏好）。 */
export const appearanceStorage = createTauriPersistStorage<AppearanceSettings>();

/** 外观仓库的状态与操作。 */
export interface AppearanceState extends AppearanceSettings {
  /** 设置明暗模式。 */
  setMode: (mode: ThemeMode) => void;
  /** 合并更新若干设置项（经过校验）。 */
  update: (patch: Partial<AppearanceSettings>) => void;
  /** 整体替换设置（用于导入），会先经过校验。 */
  replaceSettings: (settings: unknown) => void;
  /** 恢复默认。 */
  reset: () => void;
}

/**
 * 外观设置仓库，经 Tauri Store 插件持久化到界面偏好文件（键 `appearance`）。
 *
 * 持久化结构为 `{ state: { ...设置 }, version: 1 }`。读回的数据一律经过 {@link sanitizeSettings}：
 * 用户可能手动改过文件，字段非法只会让它回到默认值。
 */
export const useAppearanceStore = create<AppearanceState>()(
  persist<AppearanceState, [], [], AppearanceSettings>(
    (set) => ({
      ...getDefaultSettings(),
      setMode: (mode) => set({ mode }),
      update: (patch) => set((state) => sanitizeSettings({ ...pickSettings(state), ...patch })),
      replaceSettings: (settings) => set(sanitizeSettings(settings)),
      reset: () => set(getDefaultSettings()),
    }),
    {
      name: APPEARANCE_STORAGE_KEY,
      version: 1,
      storage: appearanceStorage,
      partialize: pickSettings,
      // 没有已保存数据（首次运行 / 读取失败）时保持当前值，不被默认值覆盖
      merge: (persisted, current) =>
        persisted == null ? current : { ...current, ...sanitizeSettings(persisted) },
    },
  ),
);
