import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 订阅 Tauri 事件。
 *
 * @param event 事件名。
 * @param handler 载荷处理器。
 * @returns 取消订阅函数的 Promise。
 */
export function onEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}
