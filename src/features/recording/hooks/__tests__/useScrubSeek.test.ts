// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { SEEK_THROTTLE_MS, useScrubSeek } from "../useScrubSeek";

let now = 0;

beforeEach(() => {
  now = 1000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useScrubSeek", () => {
  it("拖动时本地位置立即生效，seek 被节流并保证最后一次发出", () => {
    const onSeek = vi.fn();
    const { result } = renderHook(() => useScrubSeek(onSeek));

    act(() => result.current.scrub(100));
    expect(result.current.dragPos).toBe(100);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenLastCalledWith(100);

    // 节流窗口内的后续位置只更新本地值，并在窗口结束后尾随发出最后一个
    now += 10;
    act(() => result.current.scrub(200));
    now += 10;
    act(() => result.current.scrub(300));
    expect(result.current.dragPos).toBe(300);
    expect(onSeek).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(SEEK_THROTTLE_MS));
    expect(onSeek).toHaveBeenCalledTimes(2);
    expect(onSeek).toHaveBeenLastCalledWith(300);
  });

  it("松手提交：立即发出最终位置、清除本地位置，并取消待发的尾随 seek", () => {
    const onSeek = vi.fn();
    const { result } = renderHook(() => useScrubSeek(onSeek));
    act(() => result.current.scrub(100));
    now += 10;
    act(() => result.current.scrub(150));
    act(() => result.current.commit(180));
    expect(onSeek).toHaveBeenLastCalledWith(180);
    expect(result.current.dragPos).toBeNull();
    const calls = onSeek.mock.calls.length;
    act(() => vi.advanceTimersByTime(SEEK_THROTTLE_MS * 2));
    expect(onSeek).toHaveBeenCalledTimes(calls);
  });

  it("未在拖动时提交什么也不做；省略位置时取最后一次拖动的位置", () => {
    const onSeek = vi.fn();
    const { result } = renderHook(() => useScrubSeek(onSeek));
    act(() => result.current.commit(500));
    expect(onSeek).not.toHaveBeenCalled();

    act(() => result.current.scrub(42));
    act(() => result.current.commit());
    expect(onSeek).toHaveBeenLastCalledWith(42);
  });

  it("取消拖动：清除本地位置且不再发出待发的 seek", () => {
    const onSeek = vi.fn();
    const { result } = renderHook(() => useScrubSeek(onSeek));
    act(() => result.current.scrub(10));
    now += 5;
    act(() => result.current.scrub(20));
    act(() => result.current.cancel());
    expect(result.current.dragPos).toBeNull();
    act(() => vi.advanceTimersByTime(SEEK_THROTTLE_MS * 2));
    expect(onSeek).toHaveBeenCalledTimes(1);
  });
});
