import { Observable } from "rxjs";

import { onEvent } from "@/shared/tauri/events";

/** 按事件名缓存的 Observable：同一事件名始终是同一个引用，可以直接交给 `useSubscription`。 */
const cache = new Map<string, Observable<unknown>>();

/**
 * 取某个 Tauri 事件的共享冷 Observable（每次订阅仍各自 `listen` / `unlisten`）。
 *
 * @param event 事件名。
 * @returns 引用稳定的载荷流。
 */
export function tauriEvent$<T>(event: string): Observable<T> {
  let source = cache.get(event);
  if (!source) {
    source = fromTauriEvent<unknown>(event);
    cache.set(event, source);
  }
  return source as Observable<T>;
}

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
