import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isTauri } from "./invoke";

/**
 * 订阅 Tauri 事件；非 Tauri 环境返回空的取消函数。
 *
 * @param event 事件名。
 * @param handler 载荷处理器。
 * @returns 取消订阅函数的 Promise。
 */
export async function onEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<T>(event, (e) => handler(e.payload));
}
