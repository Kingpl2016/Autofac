/** 通道流两次全量帧之间的最长间隔（与后端 `FULL_FRAME_INTERVAL` 一致）。 */
export const FULL_FRAME_MS = 1000;

/**
 * 两份通道数据是否逐值相同（生产者的变化检测用）。
 *
 * # Arguments
 *
 * * `a` - 上次发送的数据；`undefined` 表示前端没有该 Universe 的数据。
 * * `b` - 本次数据。
 *
 * # Returns
 *
 * 长度相同且逐值相等时为 `true`。
 */
export function sameData(a: readonly number[] | undefined, b: readonly number[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 两个查看列表是否相同（顺序敏感，与后端一致）。
 *
 * # Arguments
 *
 * * `a` - 列表一。
 * * `b` - 列表二。
 *
 * # Returns
 *
 * 长度相同且逐项相等时为 `true`。
 */
export function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 演示后端的二进制 DMX 通道流集线器，对应真实后端的 `DmxStream`（帧格式见 `@/shared/lib/dmxFrame`）。
 *
 * 实时引擎（kind = 1）与回放引擎（kind = 2）推送到同一组订阅者。与真实后端一致：
 * 订阅 / 取消订阅与 {@link StreamHub.requestFull} 都会改变全量代次，各生产者记下上次看到的代次，
 * 不同即让下一帧为全量。
 */
export interface StreamHub {
  /**
   * 订阅通道流。
   *
   * # Arguments
   *
   * * `onFrame` - 每帧以 `ArrayBuffer` 回调。
   *
   * # Returns
   *
   * 取消函数：只取消这一次订阅（同一个回调重复订阅也各自独立，对齐 React 严格模式的“订阅 → 取消 → 再订阅”）。
   */
  subscribe(onFrame: (buf: ArrayBuffer) => void): () => void;
  /** 是否有订阅者；没有时生产者应跳过全部通道工作。 */
  hasSubscribers(): boolean;
  /** 全量代次（数值本身无意义，只用于比较）。 */
  epoch(): number;
  /** 要求各生产者的下一帧为全量。 */
  requestFull(): void;
  /**
   * 把一帧推给当前全部订阅者。
   *
   * # Arguments
   *
   * * `buf` - 完整的帧字节。
   */
  send(buf: ArrayBuffer): void;
}

/**
 * 创建通道流集线器。
 *
 * # Returns
 *
 * 没有订阅者的集线器；可直接交给 `installDemoStream` 注册为演示模式的通道流提供者。
 */
export function createStreamHub(): StreamHub {
  /** 用对象包一层：同一个回调重复订阅也各自独立取消。 */
  const subs = new Set<{ onFrame: (buf: ArrayBuffer) => void }>();
  let epoch = 0;

  return {
    subscribe: (onFrame) => {
      const sub = { onFrame };
      subs.add(sub);
      epoch += 1;
      return () => {
        if (subs.delete(sub)) epoch += 1;
      };
    },
    hasSubscribers: () => subs.size > 0,
    epoch: () => epoch,
    requestFull: () => {
      epoch += 1;
    },
    send: (buf) => {
      for (const { onFrame } of [...subs]) onFrame(buf);
    },
  };
}
