import { useAppModeListeners } from "./hooks/useAppModeListeners";

/** 模式同步的无界面运行时。 */
export function AppModeRuntime() {
  useAppModeListeners();
  return null;
}
