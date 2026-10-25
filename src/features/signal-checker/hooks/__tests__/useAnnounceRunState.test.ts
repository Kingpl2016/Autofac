// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const announcer = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("@/shared/stores/announcerStore", () => announcer);
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { makeStatus } from "../../__tests__/helpers";
import { useSenderStore } from "../../stores/useSenderStore";
import { useAnnounceRunState } from "../useAnnounceRunState";

const config = { targetIp: "10.0.0.9", port: 5568, protocol: "sacn", universes: "1" } as const;
const push = (running: boolean, over = {}) =>
  act(() => useSenderStore.getState().setStatus(makeStatus({ running, config, ...over })));

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useSenderStore.setState({ status: null });
});

afterEach(() => cleanup());

describe("useAnnounceRunState", () => {
  it("窗口刚打开收到的第一份状态是“现状”，不播报（哪怕正在发送）", () => {
    renderHook(() => useAnnounceRunState());
    push(true);
    expect(announcer.announce).not.toHaveBeenCalled();
  });

  it("开始发送时播报目标，停止时播报停止", () => {
    renderHook(() => useAnnounceRunState());
    push(false);
    push(true);
    expect(announcer.announce).toHaveBeenLastCalledWith("已开始发送：sACN → 10.0.0.9:5568");
    push(false);
    expect(announcer.announce).toHaveBeenLastCalledWith("已停止发送");
    expect(announcer.announce).toHaveBeenCalledTimes(2);
  });

  it("状态每 200ms 推送一次，运行状态没变就不重复播报", () => {
    renderHook(() => useAnnounceRunState());
    push(false);
    push(true, { packetsSent: 1 });
    push(true, { packetsSent: 20 });
    push(true, { packetsSent: 40 });
    expect(announcer.announce).toHaveBeenCalledTimes(1);
  });

  it("用当前语言播报", async () => {
    await i18n.changeLanguage("en");
    renderHook(() => useAnnounceRunState());
    push(false);
    push(true);
    expect(announcer.announce).toHaveBeenLastCalledWith("Started sending: sACN → 10.0.0.9:5568");
    push(false);
    expect(announcer.announce).toHaveBeenLastCalledWith("Stopped sending");
  });
});
