import type { AppPlugin } from "@/shared/plugin";
import { AppModeRuntime } from "./AppModeRuntime";
import { CloseGuardDialog } from "./components/CloseGuardDialog";
import { ModeConfirmDialog } from "./components/ModeConfirmDialog";
import { ModeSwitch } from "./components/ModeSwitch";

/**
 * 应用模式（实时 / 播放器）插件：顶栏模式开关，以及整个应用只挂载一次的确认对话框。
 * 任何入口都通过 `useModeActions` 打开对话框，不需要自己挂载。
 */
export const appModePlugin: AppPlugin = {
  name: "app-mode",
  dependsOn: ["engine"],
  setup: ({ slots }) => {
    const disposers = [
      slots.register("header.actions", { id: "mode-switch", order: 20, component: ModeSwitch }),
      // 模式切换确认对话框
      slots.register("layout.overlays", { id: "mode-confirm", order: 10, component: ModeConfirmDialog }),
      // 退出守卫：录制或播放进行中关闭窗口时的确认
      slots.register("layout.overlays", { id: "close-guard", order: 20, component: CloseGuardDialog }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  },
  Runtime: AppModeRuntime,
};
