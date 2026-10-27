import { useSignalCheckerHotkey } from "./hooks/useSignalCheckerHotkey";

/** 信号检测器的无界面运行时：主窗口内 Ctrl+Shift+T 打开检测器。 */
export function SignalCheckerRuntime() {
  useSignalCheckerHotkey();
  return null;
}
