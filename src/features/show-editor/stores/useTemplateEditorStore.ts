import { create } from "zustand";

import type { CueTemplate } from "../lib/cueTemplates";

/** Cue 模板编辑器对话框的状态。 */
interface TemplateEditorState {
  /** 正在编辑的模板（打开时的初值）；`null` 为关闭 */
  draft: CueTemplate | null;
  /** `edit` 为修改已有的用户模板（保存时按 `id` 替换），`new` 为新建（内置模板的副本、新存的模板） */
  mode: "new" | "edit";
  /**
   * 打开编辑器。
   *
   * @param draft 初值（深拷贝后使用）。
   * @param mode 新建或修改。
   */
  open: (draft: CueTemplate, mode: "new" | "edit") => void;
  /** 关闭编辑器。 */
  close: () => void;
}

/**
 * Cue 模板编辑器对话框（挂在编辑器主视图里）：素材库右键“编辑… / 复制并编辑…”与“存为 Cue 模板”后的“编辑”都通过它打开。
 */
export const useTemplateEditorStore = create<TemplateEditorState>()((set) => ({
  draft: null,
  mode: "new",
  open: (draft, mode) => set({ draft: structuredClone(draft), mode }),
  close: () => set({ draft: null }),
}));
