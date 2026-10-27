import { create } from "zustand";

interface PageTransitionState {
  /** 切换页面时是否使用淡入淡出的过渡动画（浏览器 View Transition）。 */
  enabled: boolean;
  /** 由外观插件在设置变化时写入。 */
  setEnabled: (enabled: boolean) => void;
}

/**
 * 页面过渡开关。设置本身属于外观插件，但侧栏等导航入口需要据此决定是否启用路由过渡，
 * 而宿主不能依赖具体功能——所以由外观插件把它发布到这个共享标志，宿主只读。
 */
export const usePageTransition = create<PageTransitionState>()((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
}));