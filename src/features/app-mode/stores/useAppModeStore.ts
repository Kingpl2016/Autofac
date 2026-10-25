import { create } from "zustand";

interface AppModeUiState {
  /** 模式切换进行中：此时顶栏开关忙碌，所有会触发切换的入口都应忽略输入 */
  transitioning: boolean;
  setTransitioning: (on: boolean) => void;
}

/**
 * 应用模式的界面态。模式本身（`appMode` / `receivers` / `sender`）放在共享的
 * `useEngineStatusStore` 里，供不依赖本特性的布局与录制组件读取。
 */
export const useAppModeStore = create<AppModeUiState>((set) => ({
  transitioning: false,
  setTransitioning: (on) => set({ transitioning: on }),
}));
