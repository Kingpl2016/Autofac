import { useEffect, useState } from "react";

/**
 * 返回延迟 `delayMs` 后才更新的值，用于避免输入过程中反复触发查询。
 *
 * @param value 实时值。
 * @param delayMs 防抖延迟（毫秒）。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
