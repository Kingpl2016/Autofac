import type { AppPlugin } from "@/shared/plugin";
import { SignalCheckerButton } from "./components/SignalCheckerButton";
import { SignalCheckerRuntime } from "./SignalCheckerRuntime";

/** 信号检测器插件：顶栏入口按钮与主窗口内的快捷键。检测器本体是独立窗口。 */
export const signalCheckerPlugin: AppPlugin = {
  name: "signal-checker",
  setup: ({ slots }) =>
    slots.register("header.actions", { id: "signal-checker", order: 60, component: SignalCheckerButton }),
  Runtime: SignalCheckerRuntime,
};
