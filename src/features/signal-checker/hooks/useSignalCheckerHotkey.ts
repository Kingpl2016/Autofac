import { useEffect } from "react";

import { openSignalChecker } from "../lib/api";

/** 打开信号检测器的快捷键（仅主窗口内生效，不是全局快捷键）。 */
export const SIGNAL_CHECKER_HOTKEY = "Ctrl+Shift+T";

/**
 * 在主窗口内监听 `Ctrl+Shift+T`（macOS 为 `Cmd+Shift+T`）打开信号检测器。
 *
 * 刻意不用全局快捷键：`Ctrl+Shift+S` 已被"停止录制"占用，而且系统级快捷键会劫持其他软件里的同名操作。
 * 按住不放产生的重复按键事件会被忽略。在主布局挂载一次。
 */
export function useSignalCheckerHotkey(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.altKey || !e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "t") return;
      e.preventDefault();
      void openSignalChecker();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
