// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useElementSize } from "../useElementSize";

/** 可手动触发的 ResizeObserver 替身。 */
const observers: { cb: () => void; disconnected: boolean }[] = [];
class FakeResizeObserver {
  #entry: { cb: () => void; disconnected: boolean };
  constructor(cb: () => void) {
    this.#entry = { cb, disconnected: false };
    observers.push(this.#entry);
  }
  observe() {}
  disconnect() {
    this.#entry.disconnected = true;
  }
}

/** 造一个 clientWidth / clientHeight 可改的元素。 */
function box(width: number, height: number) {
  const el = document.createElement("div");
  const size = { width, height };
  Object.defineProperty(el, "clientWidth", { get: () => size.width });
  Object.defineProperty(el, "clientHeight", { get: () => size.height });
  return { el, size };
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe("useElementSize", () => {
  it("挂载时测一次，尺寸变化后更新，并调用 onResize", () => {
    const { el, size } = box(300, 40);
    const onResize = vi.fn();
    const { result } = renderHook(() => useElementSize({ current: el }, { onResize }));
    expect(result.current).toEqual({ width: 300, height: 40 });
    expect(onResize).toHaveBeenCalledWith({ width: 300, height: 40 });

    size.width = 420;
    act(() => observers[0].cb());
    expect(result.current).toEqual({ width: 420, height: 40 });
  });

  it("尺寸没变时返回同一个对象（不触发重渲染）", () => {
    const { el } = box(100, 10);
    const { result } = renderHook(() => useElementSize({ current: el }));
    const first = result.current;
    act(() => observers[0].cb());
    expect(result.current).toBe(first);
  });

  it("key 变化时重新观测，卸载时断开", () => {
    const { el } = box(1, 1);
    const ref = { current: el };
    const { rerender, unmount } = renderHook(({ k }) => useElementSize(ref, { key: k }), { initialProps: { k: 1 } });
    rerender({ k: 2 });
    expect(observers).toHaveLength(2);
    expect(observers[0].disconnected).toBe(true);
    unmount();
    expect(observers[1].disconnected).toBe(true);
  });

  it("元素未挂载时为 0；没有 ResizeObserver 时只测一次", () => {
    expect(renderHook(() => useElementSize({ current: null })).result.current).toEqual({ width: 0, height: 0 });
    vi.unstubAllGlobals();
    vi.stubGlobal("ResizeObserver", undefined);
    const { el } = box(50, 5);
    expect(renderHook(() => useElementSize({ current: el })).result.current).toEqual({ width: 50, height: 5 });
  });
});
