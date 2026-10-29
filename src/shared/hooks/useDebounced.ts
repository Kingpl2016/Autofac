import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 返回延迟 `delayMs` 后才跟上变化的值：连续输入时只在停下来之后更新一次（用于避免反复触发查询）。
 *
 * @param value 实时值。
 * @param delayMs 延迟（毫秒）。
 * @returns 防抖后的值。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** `useDebouncedCallback` 的返回值（引用稳定）。 */
export interface DebouncedCallback<A extends unknown[]> {
  /** 安排一次调用；之前尚未执行的调用被取消，用最后一次的参数。 */
  schedule: (...args: A) => void;
  /** 有待执行的调用时立刻执行它。 */
  flush: () => void;
  /** 取消待执行的调用。 */
  cancel: () => void;
  /** 是否有待执行的调用。 */
  pending: () => boolean;
}

/**
 * 防抖地调用一个函数（例如改动后自动保存）。总是调用最新一次渲染的 `fn`；
 * 组件卸载时取消待执行的调用（需要卸载时落盘的，自己在清理里处理）。
 *
 * @param fn 被调用的函数。
 * @param delayMs 延迟（毫秒）。
 * @returns 引用稳定的 `schedule` / `flush` / `cancel` / `pending`。
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
): DebouncedCallback<A> {
  const fnRef = useRef(fn);
  const delayRef = useRef(delayMs);
  useEffect(() => {
    fnRef.current = fn;
    delayRef.current = delayMs;
  });
  // 待执行的调用：定时器与参数
  const queued = useRef<{ timer: ReturnType<typeof setTimeout>; args: A } | null>(null);

  const cancel = useCallback(() => {
    if (queued.current) clearTimeout(queued.current.timer);
    queued.current = null;
  }, []);
  const flush = useCallback(() => {
    const q = queued.current;
    if (!q) return;
    clearTimeout(q.timer);
    queued.current = null;
    fnRef.current(...q.args);
  }, []);
  const schedule = useCallback(
    (...args: A) => {
      cancel();
      queued.current = { timer: setTimeout(flush, delayRef.current), args };
    },
    [cancel, flush],
  );
  const pending = useCallback(() => queued.current !== null, []);

  useEffect(() => cancel, [cancel]);
  return useMemo(() => ({ schedule, flush, cancel, pending }), [schedule, flush, cancel, pending]);
}
