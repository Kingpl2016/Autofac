// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const plugin = vi.hoisted(() => ({
  attachLogger: vi.fn(),
  LogLevel: { Trace: 1, Debug: 2, Info: 3, Warn: 4, Error: 5 },
}));

vi.mock("@tauri-apps/plugin-log", () => plugin);

import { useLogStore } from "@/shared/stores/logStore";
import { useSystemLog } from "../useSystemLog";

beforeEach(() => {
  vi.clearAllMocks();
  useLogStore.setState({ entries: [] });
  plugin.attachLogger.mockResolvedValue(() => undefined);
});

afterEach(() => useLogStore.setState({ entries: [] }));

describe("useSystemLog", () => {
  it("订阅日志并按级别映射后写入 logStore", () => {
    renderHook(() => useSystemLog());

    expect(plugin.attachLogger).toHaveBeenCalledTimes(1);
    const cb = plugin.attachLogger.mock.calls[0][0] as (r: {
      level: number;
      message: string;
    }) => void;

    cb({ level: plugin.LogLevel.Info, message: "引擎已启动" });
    cb({ level: plugin.LogLevel.Warn, message: "来源超时" });
    cb({ level: plugin.LogLevel.Error, message: "绑定失败" });
    cb({ level: plugin.LogLevel.Debug, message: "细节" });

    const entries = useLogStore.getState().entries;
    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ["info", "引擎已启动"],
      ["warn", "来源超时"],
      ["error", "绑定失败"],
      ["info", "细节"],
    ]);
  });
});
