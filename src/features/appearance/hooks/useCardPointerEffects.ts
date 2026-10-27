/** @file 卡片指针效果的委托监听：只在选择了聚光灯 / 高光 / 倾斜时挂载，整页只有一个监听器 */
import { useEffect } from "react";

import { useAppearanceStore } from "../stores/useAppearanceStore";
import { applyCardPointerVars, computeCardPointerVars, resetCardPointerVars } from "../lib/cardPointer";

/** 需要指针监听的悬停反馈 */
const POINTER_HOVERS: ReadonlySet<string> = new Set(["spotlight", "glare", "tilt"]);

/** 卡片选择器 */
const CARD_SELECTOR = '[data-slot="card"]';

/**
 * 判断当前是否应当禁用指针动画：外观里选了“减少”，或选“跟随系统”且系统要求减少动画。
 *
 * @param motion - 外观设置里的动效偏好
 * @returns 是否应当禁用
 */
function motionDisabled(motion: string): boolean {
  if (motion === "reduce") return true;
  if (motion === "full") return false;
  return (
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * 为卡片的聚光灯 / 高光 / 倾斜悬停效果挂载指针监听。
 *
 * @remarks
 * - 委托在 document 上，不管页面上有多少卡片都只有一个监听器；不使用这三种效果时不挂载任何监听
 * - 用 rAF 合并同一帧内的多次移动，只写 CSS 变量，不读取布局之外的东西、不触发重排
 * - 只响应鼠标和手写笔；触屏没有悬停，保持原样
 * - 要求减少动画时不挂载
 *
 * @example
 * ```tsx
 * function AppearanceRuntime() {
 *   useCardPointerEffects()
 *   return null
 * }
 * ```
 */
export function useCardPointerEffects(): void {
  const hover = useAppearanceStore((state) => state.cardHover);
  const motion = useAppearanceStore((state) => state.motion);
  const enabled = POINTER_HOVERS.has(hover) && !motionDisabled(motion);

  useEffect(() => {
    if (!enabled) return;
    let current: HTMLElement | null = null;
    let frame = 0;
    let last: PointerEvent | null = null;

    const release = () => {
      if (current) resetCardPointerVars(current);
      current = null;
    };

    const update = () => {
      frame = 0;
      const event = last;
      if (!event) return;
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>(CARD_SELECTOR) : null;
      if (target !== current) {
        release();
        current = target;
      }
      if (!current) return;
      const rect = current.getBoundingClientRect();
      applyCardPointerVars(
        current,
        computeCardPointerVars({ rect, clientX: event.clientX, clientY: event.clientY }),
      );
    };

    const handleMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      last = event;
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    const handleLeave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = null;
      release();
    };

    document.addEventListener("pointermove", handleMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", handleLeave);
    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.documentElement.removeEventListener("pointerleave", handleLeave);
      handleLeave();
    };
  }, [enabled]);
}
