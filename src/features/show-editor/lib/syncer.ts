/**
 * 防抖 + 串行 + 只发最新值的同步器。
 *
 * 用于把频繁变化的工程推给后端：`push` 之后等 `delayMs` 无新值才发送；
 * 上一次发送还没完成时，新值排队，完成后只发最新的一个（中间值被丢弃）。
 */
export interface Syncer<T> {
  /**
   * 提交新值。
   *
   * @param value 要同步的最新值。
   */
  push: (value: T) => void;
  /**
   * 立即发送待发的值（有的话），不再等防抖。
   *
   * @returns 在没有待发值且发送完成后 resolve。
   */
  flush: () => Promise<void>;
  /** 取消待发的值并停止（之后的 `push` 无效）。 */
  dispose: () => void;
}

/**
 * 创建同步器。
 *
 * @param send 发送函数；失败（reject）交给 `onError`，不会中断后续同步。
 * @param onError 发送失败时的回调。
 * @param delayMs 防抖时长（毫秒）。
 * @returns 同步器。
 */
export function createSyncer<T>(
  send: (value: T) => Promise<unknown>,
  onError: (error: unknown) => void,
  delayMs: number,
): Syncer<T> {
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let disposed = false;

  const run = (): Promise<void> => {
    if (inflight) return inflight;
    const body = async () => {
      while (pending && !disposed) {
        const { value } = pending;
        pending = null;
        try {
          await send(value);
        } catch (e) {
          onError(e);
        }
      }
    };
    // 用 finally 回调清除：body 可能同步结束，回调总在赋值之后的微任务里执行
    inflight = body().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    push: (value) => {
      if (disposed) return;
      pending = { value };
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delayMs);
    },
    flush: () => {
      clearTimer();
      return run();
    },
    dispose: () => {
      disposed = true;
      pending = null;
      clearTimer();
    },
  };
}

/**
 * 节流（首尾都触发）：连续调用时，第一次立即执行，之后每 `intervalMs` 至多执行一次，并保证最后一次参数被执行。
 *
 * @param fn 要节流的函数。
 * @param intervalMs 最小间隔（毫秒）。
 * @returns 节流后的函数，附带 `cancel` 取消待执行的尾调用。
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
): ((...args: A) => void) & { cancel: () => void } {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tail: A | null = null;

  const throttled = (...args: A) => {
    const now = Date.now();
    const wait = last + intervalMs - now;
    if (wait <= 0) {
      last = now;
      fn(...args);
      return;
    }
    tail = args;
    timer ??= setTimeout(() => {
      timer = null;
      last = Date.now();
      const a = tail;
      tail = null;
      if (a) fn(...a);
    }, wait);
  };
  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    tail = null;
  };
  return throttled;
}
