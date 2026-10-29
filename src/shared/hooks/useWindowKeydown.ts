import { useEffect, useRef, type RefObject } from "react";

import { isTextEntry } from "@/shared/lib/keyboard";

/** `useWindowKeydown` 的选项。 */
export interface WindowKeydownOptions {
  /** 为 `false` 时不监听（例如面板不可见时）。默认 `true`。 */
  enabled?: boolean;
  /** 在捕获阶段监听（先于组件自己的处理器）。默认 `false`。 */
  capture?: boolean;
}

/**
 * 在窗口上监听 `keydown`。处理函数用最新一次渲染的版本，不需要保持引用稳定；
 * 只有 `enabled` / `capture` 变化时才重新注册。
 *
 * @param handler 处理函数。
 * @param options 开关与捕获阶段。
 */
export function useWindowKeydown(
  handler: (e: KeyboardEvent) => void,
  { enabled = true, capture = false }: WindowKeydownOptions = {},
): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [enabled, capture]);
}

/**
 * 按 `/` 聚焦搜索框（焦点不在文本输入控件里、没有按 Ctrl / ⌘ / Alt 时）。
 *
 * @param inputRef 搜索框。
 */
export function useSlashToFocus(inputRef: RefObject<HTMLInputElement | null>): void {
  useWindowKeydown((e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
    e.preventDefault();
    inputRef.current?.focus();
  });
}
