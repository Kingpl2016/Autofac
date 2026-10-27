// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const api = vi.hoisted(() => ({
  playerOpen: vi.fn(),
  playerSeek: vi.fn(),
  playerPlay: vi.fn(),
  playerPause: vi.fn(),
  playerStop: vi.fn(),
  playerClose: vi.fn(),
}));
vi.mock("@/features/recording/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/features/recording/lib/api")>()),
  ...api,
}));

import { usePlayerStore } from "@/features/recording";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { EMPTY_PLAYBACK } from "@/features/recording/lib/types";
import { useSegmentPreview } from "../useSegmentPreview";

const PATH = "D:/rec/a.artrec";
const SEGMENTS = [
  { startUs: 0, endUs: 3_000_000 },
  { startUs: 5_000_000, endUs: 8_000_000 },
];

/** 模式切换会用到路由。 */
const wrapper = ({ children }: { children: ReactNode }) => createElement(MemoryRouter, null, children);

/** 模拟后端推送一次回放状态。 */
const push = (posUs: number, state: "playing" | "stopped" = "playing") =>
  act(() => usePlayerStore.setState({ status: { ...EMPTY_PLAYBACK, loaded: true, path: PATH, state, posUs } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  for (const fn of Object.values(api)) fn.mockResolvedValue(undefined);
  usePlayerStore.setState({ status: { ...EMPTY_PLAYBACK, loaded: true, path: PATH, state: "stopped" } });
  // 编辑页已处于播放器模式
  useEngineStatusStore.setState({ appMode: "player" });
});
afterEach(() => vi.useRealTimers());

describe("剪辑预览", () => {
  it("只播放保留的片段：接近片段末尾跳到下一段，最后一段播完回到第一段，落进间隙也跳走", async () => {
    const onPosition = vi.fn();
    const { result } = renderHook(() => useSegmentPreview(PATH, SEGMENTS, onPosition), { wrapper });

    // 节目已打开：直接从播放头所在片段开始，不需要模式切换确认
    await act(async () => result.current.start(1_000_000));
    expect(api.playerOpen).not.toHaveBeenCalled();
    expect(api.playerSeek).toHaveBeenLastCalledWith(1_000_000);
    expect(api.playerPlay).toHaveBeenCalled();

    push(1_500_000);
    expect(result.current.active).toBe(true);
    api.playerSeek.mockClear();
    await act(async () => vi.advanceTimersByTime(80));
    expect(api.playerSeek).not.toHaveBeenCalled();
    expect(onPosition).toHaveBeenCalled();

    push(2_990_000);
    await act(async () => vi.advanceTimersByTime(80));
    expect(api.playerSeek).toHaveBeenLastCalledWith(5_000_000);

    push(7_990_000);
    await act(async () => vi.advanceTimersByTime(80));
    expect(api.playerSeek).toHaveBeenLastCalledWith(0);

    push(4_000_000);
    await act(async () => vi.advanceTimersByTime(80));
    expect(api.playerSeek).toHaveBeenLastCalledWith(5_000_000);
  });

  it("从间隙开始预览时从下一段开头播放；停止后暂停，卸载时卸载预览节目", async () => {
    const { result, unmount } = renderHook(() => useSegmentPreview(PATH, SEGMENTS, () => undefined), { wrapper });
    await act(async () => result.current.start(4_000_000));
    expect(api.playerSeek).toHaveBeenLastCalledWith(5_000_000);
    push(5_100_000);
    act(() => result.current.stop());
    expect(api.playerPause).toHaveBeenCalled();
    expect(result.current.active).toBe(false);

    await act(async () => result.current.start(0));
    unmount();
    expect(api.playerClose).toHaveBeenCalled();
  });
});
