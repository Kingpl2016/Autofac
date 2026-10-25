// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import { useSignalCheckerHotkey } from "../useSignalCheckerHotkey";

/** 在 window 上派发一次按键，返回事件是否被 `preventDefault`。 */
function press(init: KeyboardEventInit): boolean {
  const e = new KeyboardEvent("keydown", { cancelable: true, ...init });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup(); // 卸载上一个用例挂载的 hook，移除它的 window 监听
  vi.restoreAllMocks();
});

describe("useSignalCheckerHotkey", () => {
  it("Ctrl+Shift+T 打开信号检测器，并拦下浏览器默认行为", () => {
    renderHook(() => useSignalCheckerHotkey());
    const prevented = press({ key: "T", ctrlKey: true, shiftKey: true });
    expect(prevented).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("signal_checker_open");
  });

  it("macOS 的 Cmd+Shift+T 同样有效，大小写不敏感", () => {
    renderHook(() => useSignalCheckerHotkey());
    press({ key: "t", metaKey: true, shiftKey: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("缺少修饰键、按了别的键或带 Alt 都不触发（尤其不能抢 Ctrl+Shift+S 的“停止录制”）", () => {
    renderHook(() => useSignalCheckerHotkey());
    expect(press({ key: "t", ctrlKey: true })).toBe(false); // 没按 Shift
    expect(press({ key: "t", shiftKey: true })).toBe(false); // 没按 Ctrl
    expect(press({ key: "T" })).toBe(false);
    expect(press({ key: "S", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(press({ key: "T", ctrlKey: true, shiftKey: true, altKey: true })).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("按住不放的重复按键事件被忽略", () => {
    renderHook(() => useSignalCheckerHotkey());
    press({ key: "T", ctrlKey: true, shiftKey: true });
    press({ key: "T", ctrlKey: true, shiftKey: true, repeat: true });
    press({ key: "T", ctrlKey: true, shiftKey: true, repeat: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("卸载后不再响应", () => {
    const { unmount } = renderHook(() => useSignalCheckerHotkey());
    unmount();
    press({ key: "T", ctrlKey: true, shiftKey: true });
    expect(invoke).not.toHaveBeenCalled();
  });
});
