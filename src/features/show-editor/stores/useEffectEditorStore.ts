import { create } from "zustand";

import type { EffectDef } from "../lib/effectDefSchema";

/** 特效编辑器对话框的状态。 */
interface EffectEditorState {
  /** 正在编辑的特效（打开时的初值）；`null` 为关闭 */
  draft: EffectDef | null;
  /** `edit` 为修改已有的用户特效（保存时按 `id` 替换），`new` 为新建 */
  mode: "new" | "edit";
  /**
   * 打开编辑器。
   *
   * @param draft 初值（深拷贝后使用）。
   * @param mode 新建或修改。
   */
  open: (draft: EffectDef, mode: "new" | "edit") => void;
  /** 关闭编辑器。 */
  close: () => void;
}

/**
 * 特效编辑器对话框（挂在编辑器主视图里）：素材库的“新建 / 编辑特效”与 Cue 属性的“存为特效”都通过它打开。
 */
export const useEffectEditorStore = create<EffectEditorState>()((set) => ({
  draft: null,
  mode: "new",
  open: (draft, mode) => set({ draft: structuredClone(draft), mode }),
  close: () => set({ draft: null }),
}));
