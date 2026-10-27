/** @file 页面不可见时暂停动态背景：切到别的标签页或最小化后，动画不再消耗资源 */
import { useEffect } from "react";

import { useAppearanceStore } from "../stores/useAppearanceStore";

/**
 * 页面不可见时给 `<html>` 加上 `data-bg-paused`，样式据此暂停背景动画；回到页面后移除。
 *
 * @remarks
 * 只在选择了背景特效且开启“动态”时监听，其余情况不挂载任何监听。
 * 暂停靠 CSS 的 `animation-play-state`，恢复后从暂停处继续，不会跳变。
 *
 * @example
 * ```tsx
 * function AppearanceRuntime() {
 *   useBackgroundPause()
 *   return null
 * }
 * ```
 */
export function useBackgroundPause(): void {
  const active = useAppearanceStore((state) => state.bgEffect !== "none" && state.bgAnimated);

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const sync = () => {
      if (document.hidden) root.dataset.bgPaused = "";
      else delete root.dataset.bgPaused;
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      delete root.dataset.bgPaused;
    };
  }, [active]);
}
