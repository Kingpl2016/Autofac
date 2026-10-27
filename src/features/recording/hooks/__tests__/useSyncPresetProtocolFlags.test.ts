// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const flags = vi.hoisted(() => ({ sacnEnabled: true }));

vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: flags.sacnEnabled }),
}));
// 模拟真实存储：写入返回 Promise（persist 中间件包装后的 set 会把它原样返回）
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import { useRecordingPresetStore } from "../../stores/useRecordingPresetStore";
import { useSyncPresetProtocolFlags } from "../useSyncPresetProtocolFlags";

beforeEach(() => {
  flags.sacnEnabled = true;
  useRecordingPresetStore.setState({ sacnEnabled: false });
});

describe("useSyncPresetProtocolFlags", () => {
  it("把设置里的 sACN 开关同步到预设 store；开关变化与卸载都不会抛错", () => {
    const { rerender, unmount } = renderHook(() => useSyncPresetProtocolFlags());
    expect(useRecordingPresetStore.getState().sacnEnabled).toBe(true);

    flags.sacnEnabled = false;
    expect(() => rerender()).not.toThrow();
    expect(useRecordingPresetStore.getState().sacnEnabled).toBe(false);
    expect(() => unmount()).not.toThrow();
  });
});
