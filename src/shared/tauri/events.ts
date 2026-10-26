import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { getDemoBackend } from "./demoBridge";

/**
 * 订阅 Tauri 事件。演示模式下，由演示后端产生的事件走本地总线，其余事件仍订阅真实后端。
 *
 * @param event 事件名。
 * @param handler 载荷处理器。
 * @returns 取消订阅函数的 Promise。
 */
export function onEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  const demo = getDemoBackend();
  if (demo?.hasEvent(event)) {
    return Promise.resolve(demo.subscribe(event, handler as (payload: unknown) => void));
  }
  return listen<T>(event, (e) => handler(e.payload));
}
