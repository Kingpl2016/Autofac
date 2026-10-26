import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { getDemoBackend } from "./demoBridge";

/**
 * 对 Tauri `invoke` 的薄封装，作为前端调用后端命令的统一入口。
 *
 * 应用只在 Tauri 宿主中运行（桌面专用），因此不再做非 Tauri 环境降级。
 * 演示模式下，已被演示后端接管的命令返回演示数据，其余命令照常交给真实后端。
 *
 * # Arguments
 *
 * * `cmd` - 后端注册的命令名。
 * * `args` - 命令参数对象。
 *
 * # Returns
 *
 * 命令返回值的 Promise。
 */
export function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const demo = getDemoBackend();
  if (demo?.hasCommand(cmd)) return demo.invoke(cmd, args) as Promise<T>;
  return tauriInvoke<T>(cmd, args);
}
