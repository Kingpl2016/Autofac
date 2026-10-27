import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";

/** 面板宽度范围与预设，单位 rem。 */
export const PANEL_WIDTH = {
  min: 24,
  max: 56,
  default: 32,
  /** 三档预设：窄 / 中 / 宽。 */
  presets: [26, 32, 42],
} as const;

/** 落盘的面板偏好。 */
interface PanelPrefs {
  /** 面板宽度（rem），仅在大于等于 sm 的屏幕生效；窄屏始终铺满。 */
  width: number;
  /** 顶部示例预览是否展开。 */
  previewOpen: boolean;
}

interface PanelPrefsState extends PanelPrefs {
  /** 设置宽度，超出范围会被限制。 */
  setWidth: (width: number) => void;
  /** 设置预览是否展开。 */
  setPreviewOpen: (open: boolean) => void;
}

/**
 * 把宽度限制到允许范围，并取整到 0.5rem，避免拖拽产生过长的小数。
 *
 * @param width 以 rem 计的宽度。
 * @returns 合法的宽度；不是有限数字时返回默认宽度。
 */
export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_WIDTH.default;
  const rounded = Math.round(width * 2) / 2;
  return Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, rounded));
}

/**
 * 面板自身的界面偏好（宽度、预览是否展开）。
 * 与外观主设置分开存放：恢复默认或导入设置不会改变面板的宽度，也不进入导出文件。
 */
export const usePanelPrefsStore = create<PanelPrefsState>()(
  persist<PanelPrefsState, [], [], PanelPrefs>(
    (set) => ({
      width: PANEL_WIDTH.default,
      previewOpen: false,
      setWidth: (width) => set({ width: clampPanelWidth(width) }),
      setPreviewOpen: (previewOpen) => set({ previewOpen }),
    }),
    {
      name: "appearance-panel",
      version: 1,
      storage: createTauriPersistStorage<PanelPrefs>(),
      partialize: ({ width, previewOpen }) => ({ width, previewOpen }),
      // 存储可能被手动改过：宽度重新限制范围，开关只接受布尔值
      merge: (persisted, current) => {
        const raw = (persisted ?? {}) as Partial<Record<keyof PanelPrefs, unknown>>;
        return {
          ...current,
          width: typeof raw.width === "number" ? clampPanelWidth(raw.width) : current.width,
          previewOpen: typeof raw.previewOpen === "boolean" ? raw.previewOpen : current.previewOpen,
        };
      },
    },
  ),
);
