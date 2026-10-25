import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/**
 * 判断当前是否运行在 Tauri 宿主中（而非纯浏览器 dev 预览）。
 *
 * # Returns
 *
 * 处于 Tauri 运行时返回 `true`，否则返回 `false`。
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 对 Tauri `invoke` 的薄封装：非 Tauri 环境下安全降级，避免 dev 预览崩溃。
 *
 * # Arguments
 *
 * * `cmd` - 后端注册的命令名。
 * * `args` - 命令参数对象。
 *
 * # Returns
 *
 * 命令返回值的 Promise；非 Tauri 环境返回被拒绝的 Promise。
 */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(new Error(`[non-tauri] 命令 ${cmd} 不可用`));
  }
  return tauriInvoke<T>(cmd, args);
}
