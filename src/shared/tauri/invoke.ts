import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/**
 * 对 Tauri `invoke` 的薄封装，作为前端调用后端命令的统一入口。
 *
 * 应用只在 Tauri 宿主中运行（桌面专用），因此不再做非 Tauri 环境降级。
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
  return tauriInvoke<T>(cmd, args);
}

/**
 * 以原始二进制调用后端命令（请求体不转成 JSON 数组，适合几 MiB 的文件），元数据放在请求头里。
 *
 * # Arguments
 *
 * * `cmd` - 后端注册的命令名（参数为 `tauri::ipc::Request`）。
 * * `bytes` - 请求体。
 * * `headers` - 请求头（值须为 ASCII；非 ASCII 文本先用 `encodeURIComponent` 编码）。
 *
 * # Returns
 *
 * 命令返回值的 Promise。
 */
export function invokeBinary<T>(cmd: string, bytes: Uint8Array, headers: Record<string, string>): Promise<T> {
  return tauriInvoke<T>(cmd, bytes, { headers });
}
