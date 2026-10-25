import { useEffect, useState } from "react";

/**
 * 返回延迟 `delayMs` 毫秒才跟上变化的值：连续输入时只在停下来之后更新一次。
 *
 * # Arguments
 *
 * * `value` - 原始值。
 * * `delayMs` - 延迟（毫秒）。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
