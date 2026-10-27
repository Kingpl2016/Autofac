import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Observable } from "rxjs";

/** `useSyncExternalStore` 需要的外部仓库形状。 */
interface ObservableStore<T> {
  get: () => T;
  subscribe: (onChange: () => void) => () => void;
}

/**
 * 把 Observable 适配成 `useSyncExternalStore` 的外部仓库：缓存最近一次发出的值。
 *
 * @param source$ 数据源。
 * @param initialValue 第一次发出值之前使用的值。
 * @returns 仓库。
 */
function createObservableStore<T>(source$: Observable<T>, initialValue: T): ObservableStore<T> {
  let value = initialValue;
  return {
    get: () => value,
    subscribe: (onChange) => {
      const subscription = source$.subscribe((next) => {
        value = next;
        onChange();
      });
      return () => subscription.unsubscribe();
    },
  };
}

/**
 * 在组件里订阅 Observable，返回它最近一次发出的值。
 *
 * `source$` 必须引用稳定（模块级常量或 `useMemo`），否则每次渲染都会重新订阅。
 *
 * @param source$ 数据源。
 * @param initialValue 订阅后、第一次发出值之前使用的值。
 * @returns 最近一次发出的值。
 */
export function useObservable<T>(source$: Observable<T>, initialValue: T): T {
  const store = useMemo(() => createObservableStore(source$, initialValue), [source$, initialValue]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * 在组件生命周期内订阅 Observable，对每个值执行副作用。
 * 处理函数用最新一次渲染的版本，不需要保持引用稳定。
 *
 * @param source$ 数据源，须引用稳定。
 * @param next 每个值的处理函数。
 */
export function useSubscription<T>(source$: Observable<T>, next: (value: T) => void): void {
  const nextRef = useRef(next);
  useEffect(() => {
    nextRef.current = next;
  });
  useEffect(() => {
    const subscription = source$.subscribe((value) => nextRef.current(value));
    return () => subscription.unsubscribe();
  }, [source$]);
}
