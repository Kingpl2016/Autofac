import { Observable } from "rxjs";

import { onEvent } from "@/shared/tauri/events";

/**
 * 把 Tauri 事件包成冷 Observable：订阅时才 `listen`，退订时 `unlisten`。
 *
 * `listen` 是异步的。若在它完成前就退订，这里在它完成后立刻补一次 `unlisten`，
 * 不会留下泄漏的监听器。
 *
 * @param event 事件名。
 * @returns 载荷流；`listen` 失败时以错误结束。
 */
export function fromTauriEvent<T>(event: string): Observable<T> {
  return new Observable<T>((subscriber) => {
    let closed = false;
    let unlisten: (() => void) | undefined;
    onEvent<T>(event, (payload) => subscriber.next(payload)).then(
      (fn) => {
        if (closed) fn();
        else unlisten = fn;
      },
      (error: unknown) => subscriber.error(error),
    );
    return () => {
      closed = true;
      unlisten?.();
    };
  });
}
