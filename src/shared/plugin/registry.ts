import { useSyncExternalStore } from "react";

/** 取消注册 / 取消订阅的函数。 */
export type Disposer = () => void;

/** 注册表条目的最小形状：唯一 id，加可选排序值。 */
export interface RegistryItem {
  /** 唯一 id；同一注册表内重复注册时，后注册的覆盖先注册的。 */
  id: string;
  /** 排序值，越小越靠前，缺省 {@link DEFAULT_ORDER}；相同则按注册先后。 */
  order?: number;
}

/** 条目缺省的排序值。 */
export const DEFAULT_ORDER = 100;

/** 一个“按 id 覆盖、按 order 排序、可订阅”的集合。 */
export interface Registry<T extends RegistryItem> {
  /**
   * 注册一项条目。
   *
   * # Returns
   *
   * 取消注册的函数；只有当前生效的仍是这一项时才会移除，
   * 避免把后来覆盖它的条目误删。
   */
  register: (item: T) => Disposer;
  /** 读取当前条目（已排序）；没有变化时返回同一数组引用，便于 `useSyncExternalStore` 比较。 */
  list: () => readonly T[];
  /** 订阅变化，返回取消订阅函数。 */
  subscribe: (listener: () => void) => Disposer;
}

/**
 * 创建注册表。所有扩展机制（扩展点、路由、导航）共用这一个实现，行为一致。
 *
 * @returns 空的注册表。
 */
export function createRegistry<T extends RegistryItem>(): Registry<T> {
  let items: readonly T[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    register: (item) => {
      // 先移除同 id 的旧项再追加：覆盖语义；toSorted 稳定，order 相同时后注册的在后
      items = [...items.filter((existing) => existing.id !== item.id), item].toSorted(
        (a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER),
      );
      notify();
      return () => {
        if (!items.includes(item)) return;
        items = items.filter((existing) => existing !== item);
        notify();
      };
    },
    list: () => items,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 订阅注册表的当前条目；注册表变化时组件自动更新。
 *
 * @param registry 要订阅的注册表。
 * @returns 已排序的条目。
 */
export function useRegistryItems<T extends RegistryItem>(registry: Registry<T>): readonly T[] {
  return useSyncExternalStore(registry.subscribe, registry.list, registry.list);
}
