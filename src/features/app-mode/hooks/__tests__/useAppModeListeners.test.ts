// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}));
const api = vi.hoisted(() => ({
  appModeGet: vi.fn(),
  appModeSet: vi.fn(),
  stopRecordingForModeChange: vi.fn(),
}));
const announcer = vi.hoisted(() => ({ announce: vi.fn() }));
const events = vi.hoisted(() => ({
  handlers: new Map<string, (p: unknown) => void>(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/stores/announcerStore", () => announcer);
vi.mock("../../lib/api", () => api);
vi.mock("@/shared/tauri/events", () => ({
  onEvent: (name: string, cb: (p: unknown) => void) => {
    events.handlers.set(name, cb);
    return Promise.resolve(() => events.handlers.delete(name));
  },
}));

import "@/shared/i18n";
import i18n from "@/shared/i18n";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useAppModeListeners } from "../useAppModeListeners";

const emit = (payload: unknown) => act(() => events.handlers.get("app:mode")!(payload));

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  events.handlers.clear();
  useEngineStatusStore.setState({ appMode: "live", receivers: "bound", sender: "ready" });
  api.appModeGet.mockResolvedValue({ mode: "live", receivers: "bound", sender: "ready" });
  api.appModeSet.mockResolvedValue({ mode: "live", receivers: "bound", sender: "ready" });
});

afterEach(() => vi.restoreAllMocks());

describe("useAppModeListeners", () => {
  it("把后端推送的模式状态同步到共享 store", async () => {
    renderHook(() => useAppModeListeners());
    await vi.waitFor(() => expect(events.handlers.has("app:mode")).toBe(true));
    emit({ mode: "player", receivers: "suspended", sender: "ready" });
    const s = useEngineStatusStore.getState();
    expect([s.appMode, s.receivers, s.sender]).toEqual(["player", "suspended", "ready"]);
  });

  it("启动时主动拉取一次当前状态（刷新页面后也能同步）", async () => {
    api.appModeGet.mockResolvedValue({ mode: "player", receivers: "suspended", sender: "ready" });
    renderHook(() => useAppModeListeners());
    await vi.waitFor(() => expect(useEngineStatusStore.getState().appMode).toBe("player"));
  });

  it("接收重建失败：弹出不自动消失、带“重试”的警告；恢复后撤掉", async () => {
    renderHook(() => useAppModeListeners());
    await vi.waitFor(() => expect(events.handlers.has("app:mode")).toBe(true));

    emit({ mode: "live", receivers: "failed", sender: "ready" });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [msg, opts] = toast.warning.mock.calls[0];
    expect(msg).toContain("未能重新绑定");
    expect(opts.duration).toBe(Infinity);
    expect(opts.action.label).toBe("重试");

    opts.action.onClick();
    expect(api.appModeSet).toHaveBeenCalledWith("live");

    // 同一状态重复推送不重复弹出
    emit({ mode: "live", receivers: "failed", sender: "ready" });
    expect(toast.warning).toHaveBeenCalledTimes(1);

    emit({ mode: "live", receivers: "bound", sender: "ready" });
    expect(toast.dismiss).toHaveBeenCalled();
  });

  it("播放器模式下发送器状态变化会向读屏播报", async () => {
    renderHook(() => useAppModeListeners());
    await vi.waitFor(() => expect(events.handlers.has("app:mode")).toBe(true));

    emit({ mode: "player", receivers: "suspended", sender: "ready" });
    announcer.announce.mockClear();
    emit({ mode: "player", receivers: "suspended", sender: "reconnecting" });
    expect(announcer.announce).toHaveBeenLastCalledWith("输出重连中…");
    emit({ mode: "player", receivers: "suspended", sender: "down" });
    expect(announcer.announce).toHaveBeenLastCalledWith("输出不可用");
    emit({ mode: "player", receivers: "suspended", sender: "ready" });
    expect(announcer.announce).toHaveBeenLastCalledWith("输出就绪");
  });

  it("实时模式下发送器的变化不打扰读屏", async () => {
    renderHook(() => useAppModeListeners());
    await vi.waitFor(() => expect(events.handlers.has("app:mode")).toBe(true));
    announcer.announce.mockClear();
    emit({ mode: "live", receivers: "bound", sender: "reconnecting" });
    expect(announcer.announce).not.toHaveBeenCalled();
  });
});
