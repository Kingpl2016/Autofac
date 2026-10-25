// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { openSignalChecker } from "../api";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
});

describe("openSignalChecker", () => {
  it("调用 signal_checker_open，成功时不提示", async () => {
    invoke.mockResolvedValue(undefined);
    await openSignalChecker();
    expect(invoke).toHaveBeenCalledWith("signal_checker_open");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("失败时弹出带原因的本地化错误，且不向调用方抛出", async () => {
    invoke.mockRejectedValue("窗口创建失败");
    await expect(openSignalChecker()).resolves.toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith("无法打开信号检测器：窗口创建失败");
  });

  it("Error 对象取其 message", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    await openSignalChecker();
    expect(toast.error).toHaveBeenCalledWith("无法打开信号检测器：boom");
  });
});
