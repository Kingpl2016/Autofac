// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
const api = vi.hoisted(() => ({
  recordingStart: vi.fn(),
  recordingStop: vi.fn(),
}));
const shortcut = vi.hoisted(() => ({
  registerShortcut: vi.fn((_acc: string, _cb: () => void) => Promise.resolve()),
  unregisterShortcut: vi.fn((_acc: string) => Promise.resolve()),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/globalShortcut", () => shortcut);
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));
vi.mock("../../lib/api", () => api);

import i18n from "@/shared/i18n";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { usePrefsStore, DEFAULT_RECORD_HOTKEYS } from "@/shared/stores/prefsStore";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { usePlayerStore } from "../../stores/usePlayerStore";
import { EMPTY_STATUS, EMPTY_PLAYBACK } from "../../lib/types";
import { useRecordingHotkeys } from "../useRecordingHotkeys";

/** 从 mock 中取出按加速键注册的处理器。 */
function handlerFor(accelerator: string): () => void {
  const call = shortcut.registerShortcut.mock.calls.find((c) => c[0] === accelerator);
  if (!call) throw new Error(`未注册 ${accelerator}`);
  return call[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrefsStore.setState({ recordHotkeys: { ...DEFAULT_RECORD_HOTKEYS } });
  useRecordingStore.setState({ status: EMPTY_STATUS });
  usePlayerStore.setState({ status: EMPTY_PLAYBACK, channels: {} });
  useEngineStatusStore.setState({ appMode: "live" });
  api.recordingStart.mockResolvedValue({ plan: { accepted: [1, 2] } });
  api.recordingStop.mockResolvedValue({ files: [{ frames: 10 }] });
});

afterEach(() => vi.restoreAllMocks());

describe("useRecordingHotkeys", () => {
  it("按配置的加速键注册开始与停止", () => {
    renderHook(() => useRecordingHotkeys());
    expect(shortcut.registerShortcut).toHaveBeenCalledWith(
      DEFAULT_RECORD_HOTKEYS.start,
      expect.any(Function),
    );
    expect(shortcut.registerShortcut).toHaveBeenCalledWith(
      DEFAULT_RECORD_HOTKEYS.stop,
      expect.any(Function),
    );
  });

  it("未录制时开始热键以快速录制启动", async () => {
    renderHook(() => useRecordingHotkeys());
    handlerFor(DEFAULT_RECORD_HOTKEYS.start)();
    await vi.waitFor(() => expect(api.recordingStart).toHaveBeenCalledTimes(1));
    expect(api.recordingStop).not.toHaveBeenCalled();
  });

  it("回放中开始热键不录制，给出提示", () => {
    usePlayerStore.setState({ status: { ...EMPTY_PLAYBACK, loaded: true } });
    renderHook(() => useRecordingHotkeys());
    handlerFor(DEFAULT_RECORD_HOTKEYS.start)();
    expect(api.recordingStart).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("播放器模式下开始热键不录制（实时接收已停止，没有东西可录），给出原因", () => {
    useEngineStatusStore.setState({ appMode: "player" });
    renderHook(() => useRecordingHotkeys());
    handlerFor(DEFAULT_RECORD_HOTKEYS.start)();
    expect(api.recordingStart).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(i18n.t("mode.guardRecord"));
  });

  it("录制中停止热键停止录制，未录制时忽略", async () => {
    useRecordingStore.setState({ status: { ...EMPTY_STATUS, recording: true } });
    renderHook(() => useRecordingHotkeys());
    handlerFor(DEFAULT_RECORD_HOTKEYS.stop)();
    await vi.waitFor(() => expect(api.recordingStop).toHaveBeenCalledTimes(1));
  });

  it("加速键变更时重注册", () => {
    const { rerender } = renderHook(() => useRecordingHotkeys());
    usePrefsStore.getState().setRecordHotkey("start", "F9");
    rerender();
    expect(shortcut.unregisterShortcut).toHaveBeenCalledWith(DEFAULT_RECORD_HOTKEYS.start);
    expect(shortcut.registerShortcut).toHaveBeenCalledWith("F9", expect.any(Function));
  });
});
