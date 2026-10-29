// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
const announcer = vi.hoisted(() => ({ announce: vi.fn() }));
const api = vi.hoisted(() => ({ playerStatus: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/stores/announcerStore", () => announcer);
vi.mock("../../lib/api", () => api);
vi.mock("@/shared/tauri/events", async () => (await import("@/test/mockTauriEvents")).tauriEventsModule);
import { tauriEvents } from "@/test/mockTauriEvents";

import "@/shared/i18n";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { EMPTY_PLAYBACK } from "../../lib/types";
import { usePlayerStore } from "../../stores/usePlayerStore";
import { usePlayerListeners } from "../usePlayerListeners";

beforeEach(() => {
  vi.clearAllMocks();
  tauriEvents.reset();
  usePlayerStore.setState({ status: EMPTY_PLAYBACK, channels: {} });
  api.playerStatus.mockResolvedValue(EMPTY_PLAYBACK);
});

describe("usePlayerListeners", () => {
  it("只订阅状态与连播事件（通道数据走二进制通道流）", async () => {
    renderHook(() => usePlayerListeners());
    await vi.waitFor(() => expect(api.playerStatus).toHaveBeenCalledTimes(1));
    expect(tauriEvents.names()).toEqual(["player:playlist", "player:state"]);
  });

  it("状态同步到 store 与顶部状态条；节目关闭时清空回放通道表", async () => {
    renderHook(() => usePlayerListeners());
    await vi.waitFor(() => expect(tauriEvents.has("player:state")).toBe(true));
    usePlayerStore.setState({ channels: { 5: Uint8Array.from([1, 2]) } });

    act(() => tauriEvents.emit("player:state", { ...EMPTY_PLAYBACK, loaded: true, state: "playing" }));
    expect(usePlayerStore.getState().status.loaded).toBe(true);
    expect(useEngineStatusStore.getState()).toMatchObject({ playback: true, playing: true });
    expect(Object.keys(usePlayerStore.getState().channels)).toEqual(["5"]);

    act(() => tauriEvents.emit("player:state", EMPTY_PLAYBACK));
    expect(usePlayerStore.getState().channels).toEqual({});
    expect(useEngineStatusStore.getState()).toMatchObject({ playback: false, playing: false });
  });
});
