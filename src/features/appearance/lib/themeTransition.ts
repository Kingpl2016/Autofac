import type { ResolvedMode, ThemeMode } from "./appearanceSettings";
import { readSystemMode, resolveMode } from "./systemTheme";
import { useAppearanceStore } from "../stores/useAppearanceStore";

/** 最近一次指针按下的位置，作为扩散圆心。 */
let lastPointer: { x: number; y: number } | null = null;

/** 动画时长（毫秒）。 */
const DURATION_MS = 420;

/** 记录指针按下的位置。 */
function rememberPointer(event: PointerEvent): void {
  lastPointer = { x: event.clientX, y: event.clientY };
}

/**
 * 开始记录指针位置，供切换动画确定圆心。
 *
 * @returns 停止记录的函数。
 */
export function trackPointerOrigin(): () => void {
  window.addEventListener("pointerdown", rememberPointer, { capture: true, passive: true });
  return () => window.removeEventListener("pointerdown", rememberPointer, { capture: true });
}

/**
 * 判断当前是否应当播放动画。
 *
 * @returns 浏览器支持 View Transition，且用户没有要求减少动画时为 true。
 */
function shouldAnimate(): boolean {
  if (typeof document.startViewTransition !== "function") return false;
  const { motion } = useAppearanceStore.getState();
  if (motion === "reduce") return false;
  if (motion === "full") return true;
  return !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/**
 * 执行一次可能带圆形扩散的更新。
 *
 * `update` 必须同步地改变 DOM（外观 store 的订阅会在 `set` 时同步应用到 `<html>`）。
 * 不支持 View Transition，或系统开启“减少动态效果”时，直接执行 `update`。
 *
 * @param update 同步执行的更新函数。
 */
export function runWithThemeTransition(update: () => void): void {
  if (!shouldAnimate()) {
    update();
    return;
  }

  const root = document.documentElement;
  const x = lastPointer?.x ?? window.innerWidth - 48;
  const y = lastPointer?.y ?? 32;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

  root.classList.add("theme-transition");
  const transition = document.startViewTransition(update);
  const cleanup = () => root.classList.remove("theme-transition");

  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: DURATION_MS, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(cleanup);
  transition.finished.then(cleanup, cleanup);
}

/**
 * 切换明暗模式；明暗效果确实发生变化时才播放扩散动画。
 *
 * @param mode 目标模式。
 */
export function setModeWithTransition(mode: ThemeMode): void {
  const current: ResolvedMode = resolveMode(useAppearanceStore.getState().mode);
  const apply = () => useAppearanceStore.getState().setMode(mode);
  if (current === (mode === "system" ? readSystemMode() : mode)) {
    apply();
    return;
  }
  runWithThemeTransition(apply);
}
