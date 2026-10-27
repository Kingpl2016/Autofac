import { usePageTransition } from "@/shared/appearance/pageTransition";
import type { AppPlugin } from "@/shared/plugin";
import { useAppearanceStore } from "./stores/useAppearanceStore";
import { AppearanceRuntime } from "./AppearanceRuntime";
import { AppearanceSheet } from "./components/AppearanceSheet";
import { BackgroundHost } from "./components/BackgroundHost";
import { AppearanceTrigger } from "./components/AppearanceTrigger";
import { ThemeToggle } from "./components/ThemeToggle";
import { loadAppearance, startAppearanceSync } from "./lib/runtime";
import { registerBuiltinPresets } from "./lib/presets/builtinPresets";
import { trackPointerOrigin } from "./lib/themeTransition";

/**
 * 外观插件：个性化设置（明暗模式含跟随系统、主题、主色等）。
 *
 * `setup` 先从磁盘读回设置并应用到 `<html>`，再渲染界面，所以首屏就是用户选的外观。
 * 其他插件可以通过 `ctx.appearance` 注册自己的主题、主色与字体预设，
 * 也可以向 `appearance.sections` 扩展点贡献设置分区（出现在面板的“扩展”标签页）。
 */
export const appearancePlugin: AppPlugin = {
  name: "appearance",
  setup: async ({ slots, appearance }) => {
    await loadAppearance();
    const sync = startAppearanceSync();
    // 把“页面过渡”发布给导航入口（侧栏据此决定是否使用 View Transition）
    const publishPageTransition = () => usePageTransition.getState().setEnabled(useAppearanceStore.getState().pageTransition);
    publishPageTransition();
    const unsubscribePageTransition = useAppearanceStore.subscribe(publishPageTransition);
    const disposers = [
      // 记录指针位置，作为明暗切换动画的圆心
      trackPointerOrigin(),
      registerBuiltinPresets(appearance),
      slots.register("header.actions", { id: "theme-toggle", order: 80, component: ThemeToggle }),
      slots.register("header.actions", { id: "personalization", order: 90, component: AppearanceTrigger }),
      // 面板本身全局只挂载一次
      slots.register("layout.overlays", { id: "appearance-sheet", order: 90, component: AppearanceSheet }),
      slots.register("layout.overlays", { id: "appearance-background", order: 5, component: BackgroundHost }),
    ];
    return () => {
      unsubscribePageTransition();
      sync.unsubscribe();
      for (const dispose of disposers) dispose();
    };
  },
  Runtime: AppearanceRuntime,
};
