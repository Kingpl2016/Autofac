import { useSyncExternalStore } from "react";

/**
 * 订阅 CSS 媒体查询结果。
 *
 * @param query 媒体查询字符串，如 `(min-width: 1280px)`。
 * @param fallback 环境不支持 `matchMedia`（如 jsdom）时使用的值。
 * @returns 当前是否匹配。
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener("change", notify);
      return () => mql.removeEventListener("change", notify);
    },
    () =>
      typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback,
    () => fallback,
  );
}
