import { useEffect } from "react";

import { attachLogger, LogLevel } from "@/shared/tauri/log";
import { useLogStore, type LogLevel as UiLogLevel } from "@/shared/stores/logStore";

/** 把 tauri-plugin-log 的级别映射到应用内日志面板的三级。 */
function toUiLevel(level: LogLevel): UiLogLevel {
  if (level === LogLevel.Error) return "error";
  if (level === LogLevel.Warn) return "warn";
  return "info";
}

/**
 * 订阅 tauri-plugin-log 的日志记录（含 Rust `tracing` 经 `log` 桥接的后端日志
 * 与前端日志），汇入全局 {@link useLogStore}，驱动 Dashboard 与底部状态条的日志面板。
 * 在应用根挂载一次。
 */
export function useSystemLog(): void {
  const append = useLogStore((s) => s.append);

  useEffect(() => {
    const detach = attachLogger(({ level, message }) =>
      append(toUiLevel(level), message),
    );
    return () => {
      void detach.then((fn) => fn());
    };
  }, [append]);
}
