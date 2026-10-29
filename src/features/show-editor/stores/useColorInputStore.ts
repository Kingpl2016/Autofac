import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistPrefs } from "@/shared/stores/persistPrefs";

/** 色盘“彩色”方式下的输入方式：色轮（HSV）、RGB 数值、HSI 滑杆。 */
export const COLOR_INPUTS = ["wheel", "rgb", "hsi"] as const;

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
    persistPrefs<ColorInputState, ColorInputData>({
      name: "editor-color-input",
      version: 1,
      // 旧版本存的 `hsl` 方式已去掉（与色轮重复），读回时和其它非法值一样回到色轮
      schema: z.object({ input: z.enum(COLOR_INPUTS).catch("wheel") }),
    }),
  ),
);
