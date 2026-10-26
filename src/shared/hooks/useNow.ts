import { useEffect, useState } from "react";

/**
 * 以固定间隔刷新的当前时间戳（毫秒），用于“距今多久 / 是否过期”这类随时间变化的展示。
 *
 * 只在定时器回调里更新状态，不在 effect 体内同步 `setState`。
 *
 * @param intervalMs 刷新间隔（毫秒），默认 1000。
 * @returns 最近一次刷新时的 `Date.now()`。
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}