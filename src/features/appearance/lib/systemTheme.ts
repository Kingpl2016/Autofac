import { defer, fromEvent, map, of, startWith, type Observable } from "rxjs";

import type { ResolvedMode } from "./appearanceSettings";

const QUERY = "(prefers-color-scheme: dark)";

/** 当前环境是否支持 `matchMedia`。 */
function canMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/**
 * 读取当前系统的明暗偏好。
 *
 * @returns 系统偏好深色时为 `dark`，否则为 `light`；没有 `matchMedia` 的环境视为 `dark`（应用默认深色）。
 */
export function readSystemMode(): ResolvedMode {
  if (!canMatchMedia()) return "dark";
  return window.matchMedia(QUERY).matches ? "dark" : "light";
}

/**
 * 系统明暗偏好的流：订阅时先发出当前值，之后系统切换时发出新值。
 * 冷 Observable（每次订阅才读取 / 监听），退订即移除监听。
 */
export const systemMode$: Observable<ResolvedMode> = defer(() => {
  if (!canMatchMedia()) return of<ResolvedMode>("dark");
  const query = window.matchMedia(QUERY);
  return fromEvent<MediaQueryListEvent>(query, "change").pipe(
    map((event): ResolvedMode => (event.matches ? "dark" : "light")),
    startWith<ResolvedMode>(query.matches ? "dark" : "light"),
  );
});

/**
 * 把用户选择的模式解析成实际生效的明暗。
 *
 * @param mode 用户选择；`system` 时读取当前系统偏好。
 * @returns 实际生效的明暗模式。
 */
export function resolveMode(mode: "light" | "dark" | "system"): ResolvedMode {
  return mode === "system" ? readSystemMode() : mode;
}
