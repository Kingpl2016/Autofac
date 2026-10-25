import { describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  info: vi.fn((_message: string) => Promise.resolve()),
  warn: vi.fn((_message: string) => Promise.resolve()),
  error: vi.fn((_message: string) => Promise.resolve()),
  debug: vi.fn((_message: string) => Promise.resolve()),
  attachLogger: vi.fn(),
  LogLevel: { Trace: 1, Debug: 2, Info: 3, Warn: 4, Error: 5 },
}));

vi.mock("@tauri-apps/plugin-log", () => plugin);

import { logInfo, logWarn, logError, logDebug } from "../log";

describe("日志封装", () => {
  it("info / warn / debug 透传文本", async () => {
    await logInfo("启动");
    expect(plugin.info).toHaveBeenCalledWith("启动");
    await logWarn("注意");
    expect(plugin.warn).toHaveBeenCalledWith("注意");
    await logDebug("细节");
    expect(plugin.debug).toHaveBeenCalledWith("细节");
  });

  it("error 无异常时只记录文本", async () => {
    await logError("失败");
    expect(plugin.error).toHaveBeenCalledWith("失败");
  });

  it("error 带异常时拼接异常文本", async () => {
    await logError("读取失败", new Error("boom"));
    const msg = plugin.error.mock.calls[0][0];
    expect(msg).toContain("读取失败");
    expect(msg).toContain("boom");
  });
});
