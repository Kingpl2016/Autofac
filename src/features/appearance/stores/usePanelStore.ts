import { create } from "zustand";

/** 个性化面板的标签页。 */
export type AppearanceTab = "colors" | "shape" | "cards" | "effects" | "layout" | "extensions";

interface PanelState {
  /** 面板是否打开。 */
  open: boolean;
  /** 当前标签页。 */
  tab: AppearanceTab;
  /** 打开 / 关闭面板。 */
  setOpen: (open: boolean) => void;
  /** 切换标签页。 */
  setTab: (tab: AppearanceTab) => void;
}

/**
 * 个性化面板的打开状态与当前标签页（不持久化）。
 * 入口按钮、快捷键或其他插件都通过它打开面板，面板本身挂在全局覆盖层里。
 */
export const usePanelStore = create<PanelState>()((set) => ({
  open: false,
  tab: "colors",
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
}));
