// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import { usePrefsStore } from "@/shared/stores/prefsStore";
import { EMPTY_STATUS } from "../../lib/types";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { RecordingOverlay } from "../RecordingOverlay";

beforeEach(() => {
  useRecordingStore.setState({ status: EMPTY_STATUS });
  usePrefsStore.setState({ recordingGlow: true });
});
afterEach(() => cleanup());

describe("RecordingOverlay", () => {
  it("录制中出现、不挡操作也不打扰读屏；停止后消失", () => {
    const { rerender } = render(<RecordingOverlay />);
    expect(screen.queryByTestId("recording-overlay")).toBeNull();

    useRecordingStore.setState({ status: { ...EMPTY_STATUS, recording: true } });
    rerender(<RecordingOverlay />);
    const el = screen.getByTestId("recording-overlay");
    expect(el.className).toContain("pointer-events-none");
    expect(el.getAttribute("aria-hidden")).toBe("true");

    useRecordingStore.setState({ status: EMPTY_STATUS });
    rerender(<RecordingOverlay />);
    expect(screen.queryByTestId("recording-overlay")).toBeNull();
  });

  it("在设置里关闭后录制中也不显示", () => {
    usePrefsStore.setState({ recordingGlow: false });
    useRecordingStore.setState({ status: { ...EMPTY_STATUS, recording: true } });
    render(<RecordingOverlay />);
    expect(screen.queryByTestId("recording-overlay")).toBeNull();
  });
});
