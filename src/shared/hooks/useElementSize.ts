import { useEffect, useRef, useState, type RefObject } from "react";

/** 元素尺寸（`clientWidth` / `clientHeight`，含内边距、不含边框与滚动条）。 */
export interface ElementSize {
  width: number;
  height: number;
}

/** `useElementSize` 的选项。 */
export interface ElementSizeOptions {
  /**
   * 变化时重新开始观测（例如被观测的元素条件渲染、换了一个）。传一个原始值或对象引用即可。
   */
  key?: unknown;
  /** 每次测量后调用（例如同步到 store）；用最新一次渲染的版本。 */
  onResize?: (size: ElementSize) => void;
}

/**
 * 观测元素尺寸：挂载时测一次，之后随 `ResizeObserver` 更新；尺寸没变时不触发重渲染。
 * 环境没有 `ResizeObserver` 时只测一次。
 *
 * @param ref 被观测的元素。
 * @param options 重新观测的键与回调。
 * @returns 当前尺寸；元素还没挂载时为 0。
 */
export function useElementSize(ref: RefObject<HTMLElement | null>, { key, onResize }: ElementSizeOptions = {}): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
      onResizeRef.current?.(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, key]);

  return size;
}
