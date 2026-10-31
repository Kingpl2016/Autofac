import { create } from "zustand";

/** “模型配置”对话框的开关（对话框由 AI 插件挂在全局覆盖层，任何地方都能打开）。 */
interface AiModelsDialogState {
  open: boolean;
  /**
   * 打开 / 关闭对话框。
   *
   * @param open 是否打开。
   */
  setOpen: (open: boolean) => void;
}

export const useAiModelsDialogStore = create<AiModelsDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** 打开“模型配置”对话框（不离开当前页面）。 */
export function openAiModelsDialog(): void {
  useAiModelsDialogStore.getState().setOpen(true);
}
