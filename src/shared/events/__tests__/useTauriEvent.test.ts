// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@/shared/tauri/events", async () => (await import("@/test/mockTauriEvents")).tauriEventsModule);
import { tauriEvents } from "@/test/mockTauriEvents";

import { tauriEvent$ } from "../fromTauriEvent";
import { useTauriEvent } from "../useObservable";

beforeEach(() => tauriEvents.reset());

describe("tauriEvent$", () => {
  it("同一事件名返回同一个 Observable", () => {
    expect(tauriEvent$("a")).toBe(tauriEvent$("a"));
    expect(tauriEvent$("a")).not.toBe(tauriEvent$("b"));
  });
});

describe("useTauriEvent", () => {
  it("挂载时监听、用最新的处理函数、卸载时取消监听", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ fn }) => useTauriEvent<number>("tick", fn), {
      initialProps: { fn: first },
    });
    await vi.waitFor(() => expect(tauriEvents.has("tick")).toBe(true));

    act(() => tauriEvents.emit("tick", 1));
    expect(first).toHaveBeenCalledWith(1);

    rerender({ fn: second });
    act(() => tauriEvents.emit("tick", 2));
    expect(second).toHaveBeenCalledWith(2);
    expect(first).toHaveBeenCalledTimes(1);
    // 换处理函数不会重新 listen
    expect(tauriEvents.count("tick")).toBe(1);

    unmount();
    await vi.waitFor(() => expect(tauriEvents.has("tick")).toBe(false));
  });

  it("多个组件订阅同一事件各自 listen，互不影响", async () => {
    const a = renderHook(() => useTauriEvent("x", vi.fn()));
    renderHook(() => useTauriEvent("x", vi.fn()));
    await vi.waitFor(() => expect(tauriEvents.count("x")).toBe(2));
    a.unmount();
    await vi.waitFor(() => expect(tauriEvents.count("x")).toBe(1));
  });
});
