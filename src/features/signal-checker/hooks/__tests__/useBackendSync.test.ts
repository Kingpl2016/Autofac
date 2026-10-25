// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

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

import { DEFAULTS, useCheckerFormStore } from "../../stores/useCheckerFormStore";
import { useBackendSync } from "../useBackendSync";

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue(undefined);
  useCheckerFormStore.setState({ ...DEFAULTS });
});

afterEach(() => cleanup());

describe("useBackendSync", () => {
  it("窗口打开时把保存的模式 / 图案 / 倍速推给后端", async () => {
    useCheckerFormStore.setState({ mode: "manual", pattern: "rainbow", speed: 0.5 });
    renderHook(() => useBackendSync());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(invoke).toHaveBeenCalledWith("signal_checker_set_mode", { mode: "manual" });
    expect(invoke).toHaveBeenCalledWith("signal_checker_set_pattern", { pattern: "rainbow" });
    expect(invoke).toHaveBeenCalledWith("signal_checker_set_speed", { speed: 0.5 });
  });

  it("不会下发连接配置：它是草稿，要用户点“应用”才生效", async () => {
    renderHook(() => useBackendSync());
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const commands = invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands).not.toContain("signal_checker_configure");
    expect(commands).not.toContain("signal_checker_start");
  });

  it("后端暂时不可用时静默忽略", async () => {
    invoke.mockRejectedValue(new Error("no backend"));
    renderHook(() => useBackendSync());
    await waitFor(() => expect(invoke).toHaveBeenCalled());
  });
});
