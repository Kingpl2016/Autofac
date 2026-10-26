import { useState } from "react";

/**
 * 只在 `key` 变化时才返回新的 `value`，否则一直返回上一个对象引用。
 *
 * 用于把“每次刷新都会重新计算、但内容往往没变”的派生数据稳定下来，
 * 避免它驱动下游昂贵的更新（如重新协调整个节点图）。在渲染期派生状态，不使用 effect。
 *
 * @param value 当前值。
 * @param key 代表 `value` 内容的键；键相同视为内容没变。
 * @returns 键未变化时为上一次的对象，否则为 `value`。
 */
export function useStableValue<T>(value: T, key: string): T {
  const [state, setState] = useState({ key, value });
  if (state.key !== key) {
    setState({ key, value });
    return value;
  }
  return state.value;
}