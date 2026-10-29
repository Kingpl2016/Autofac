import { vi } from "vitest";

/** 事件处理器。 */
type Handler = (payload: unknown) => void;

/** 内存版的 Tauri 事件总线：记录各事件的处理器，测试里手动派发。 */
export interface TauriEventBus {
  /** 与 `@/shared/tauri/events` 的 `onEvent` 同签名：登记处理器，返回取消订阅函数的 Promise。 */
  onEvent: <T>(event: string, handler: (payload: T) => void) => Promise<() => void>;
  /** 向某个事件的全部处理器派发载荷。 */
  emit: (event: string, payload: unknown) => void;
  /** 某个事件当前是否有处理器。 */
  has: (event: string) => boolean;
  /** 某个事件当前的处理器个数。 */
  count: (event: string) => number;
  /** 当前有处理器的事件名（升序）。 */
  names: () => string[];
  /** 之后的 `onEvent` 都以该错误失败（模拟没有 Tauri 运行时）；传 `null` 恢复正常。 */
  failWith: (error: unknown) => void;
  /** 清空全部处理器并恢复正常（放在 `beforeEach` 里）。 */
  reset: () => void;
}

/**
 * 创建一个内存事件总线。
 *
 * @returns 新的总线。
 */
export function createTauriEventBus(): TauriEventBus {
  const handlers = new Map<string, Set<Handler>>();
  let failure: unknown = null;
  return {
    onEvent: <T>(event: string, handler: (payload: T) => void) => {
      if (failure !== null) return Promise.reject(failure);
      const set = handlers.get(event) ?? new Set<Handler>();
      const h = handler as Handler;
      set.add(h);
      handlers.set(event, set);
      return Promise.resolve(() => {
        set.delete(h);
        if (set.size === 0) handlers.delete(event);
      });
    },
    emit: (event, payload) => {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
    has: (event) => (handlers.get(event)?.size ?? 0) > 0,
    count: (event) => handlers.get(event)?.size ?? 0,
    names: () => [...handlers.keys()].sort(),
    failWith: (error) => {
      failure = error;
    },
    reset: () => {
      handlers.clear();
      failure = null;
    },
  };
}

/**
 * 测试文件共用的总线实例。用法：
 *
 * ```ts
 * vi.mock("@/shared/tauri/events", async () => (await import("@/test/mockTauriEvents")).tauriEventsModule);
 * import { tauriEvents } from "@/test/mockTauriEvents";
 * beforeEach(() => tauriEvents.reset());
 * // ……
 * act(() => tauriEvents.emit("player:state", status));
 * ```
 */
export const tauriEvents = createTauriEventBus();

/** 代替 `@/shared/tauri/events` 的模块内容。 */
export const tauriEventsModule = { onEvent: tauriEvents.onEvent };

/**
 * jsdom 没有 `ResizeObserver`（Radix 弹层、面板组、时间线都要用）：装一个什么都不做的桩。
 */
export function stubResizeObserver(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}
