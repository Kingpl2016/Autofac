import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";

/** 色盘“彩色”方式下的输入方式：色轮（HSV）、RGB 数值。 */
export const COLOR_INPUTS = ["wheel", "rgb"] as const;

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
      // 旧版本存的 `hsl` 方式已去掉（与色轮重复），读回时和其它非法值一样回到色轮
      merge: (persisted, current) => {
        const input = (persisted as Partial<ColorInputData> | null)?.input;
        return COLOR_INPUTS.includes(input as ColorInput) ? { ...current, input: input as ColorInput } : current;
      },
    },
  ),
);
