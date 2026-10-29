/**
 * 信号检测器窗口的入口（第二个公开出口，只给 `src/signal-checker/main.tsx` 使用）。
 * 与 `index.ts` 分开，主窗口的包里就不会出现检测器视图。
 */
export { SignalCheckerRoot } from "./components/SignalCheckerRoot";
