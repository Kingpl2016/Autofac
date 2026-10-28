import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";

/** 色盘 RGB 模式下的输入方式：色轮、HSL 滑杆、RGB 数值。 */
export const COLOR_INPUTS = ["wheel", "hsl", "rgb"] as const;

/** 输入方式。 */
export type ColorInput = (typeof COLOR_INPUTS)[number];

/** 落盘的数据。 */
interface ColorInputData {
  input: ColorInput;
}

interface ColorInputState extends ColorInputData {
  /**
   * 切换输入方式（记住上次的选择）。
   *
   * @param input 输入方式。
   */
  setInput: (input: ColorInput) => void;
}

/**
 * 色盘的输入方式偏好，落盘到界面偏好文件（键 `editor-color-input`）。
 */
export const useColorInputStore = create<ColorInputState>()(
  persist(
    (set) => ({
      input: "wheel",
      setInput: (input) => set({ input }),
    }),
    {
      name: "editor-color-input",
      version: 1,
      storage: createTauriPersistStorage<ColorInputData>(),
      partialize: ({ input }) => ({ input }),
      merge: (persisted, current) => {
        const input = (persisted as Partial<ColorInputData> | null)?.input;
        return COLOR_INPUTS.includes(input as ColorInput) ? { ...current, input: input as ColorInput } : current;
      },
    },
  ),
);
