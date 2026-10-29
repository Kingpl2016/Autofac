// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useDebouncedCallback, useDebouncedValue } from "../useDebounced";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useDebouncedValue", () => {
  it("停止变化 delay 毫秒后才更新", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 100), { initialProps: { v: "a" } });
    rerender({ v: "b" });
    act(() => void vi.advanceTimersByTime(60));
    rerender({ v: "c" });
    act(() => void vi.advanceTimersByTime(60));
    expect(result.current).toBe("a");
    act(() => void vi.advanceTimersByTime(40));
    expect(result.current).toBe("c");
  });
});

describe("useDebouncedCallback", () => {
  it("合并连续调用，只用最后一次的参数", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 100));
    result.current.schedule(1);
    result.current.schedule(2);
    expect(result.current.pending()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledExactlyOnceWith(2);
    expect(result.current.pending()).toBe(false);
  });

  it("flush 立刻执行待执行的调用，没有待执行时什么也不做", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 100));
    result.current.flush();
    expect(fn).not.toHaveBeenCalled();
    result.current.schedule("x");
    result.current.flush();
    expect(fn).toHaveBeenCalledWith("x");
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel 与卸载都会取消待执行的调用", () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 100));
    result.current.schedule();
    result.current.cancel();
    vi.advanceTimersByTime(200);
    result.current.schedule();
    unmount();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it("返回值引用稳定，并调用最新一次渲染的函数", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ fn }) => useDebouncedCallback(fn, 100), { initialProps: { fn: first } });
    const api = result.current;
    api.schedule();
    rerender({ fn: second });
    expect(result.current).toBe(api);
    vi.advanceTimersByTime(100);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
