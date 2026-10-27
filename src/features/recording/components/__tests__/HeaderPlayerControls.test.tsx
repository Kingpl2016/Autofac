// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({
  playerPlay: vi.fn(),
  playerPause: vi.fn(),
  playerStop: vi.fn(),
  playerSeek: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { EMPTY_PLAYBACK, type PlaybackStatus } from "../../lib/types";
import { usePlayerStore } from "../../stores/usePlayerStore";
import { HeaderPlayerControls } from "../HeaderPlayerControls";

const loaded = (over: Partial<PlaybackStatus> = {}): PlaybackStatus => ({
  ...EMPTY_PLAYBACK,
  loaded: true,
  path: "D:\\rec\\a.artrec",
  name: "开场秀",
  state: "paused",
  posUs: 10_000_000,
  durationUs: 100_000_000,
  ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  for (const fn of Object.values(api)) fn.mockResolvedValue(undefined);
  useEngineStatusStore.setState({ appMode: "player" });
  usePlayerStore.setState({ status: loaded() });
});
afterEach(() => cleanup());

describe("HeaderPlayerControls", () => {
  it("只在播放器模式且已打开节目时出现", () => {
    useEngineStatusStore.setState({ appMode: "live" });
    const { container, rerender } = render(<HeaderPlayerControls />);
    expect(container.innerHTML).toBe("");
    useEngineStatusStore.setState({ appMode: "player" });
    usePlayerStore.setState({ status: EMPTY_PLAYBACK });
    rerender(<HeaderPlayerControls />);
    expect(container.innerHTML).toBe("");
    usePlayerStore.setState({ status: loaded() });
    rerender(<HeaderPlayerControls />);
    expect(screen.getByRole("group", { name: "播放控制" })).toBeTruthy();
    expect(screen.getByText("开场秀")).toBeTruthy();
  });

  it("播放 / 暂停 / 停止按钮调用对应命令", async () => {
    const { rerender } = render(<HeaderPlayerControls />);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await waitFor(() => expect(api.playerPlay).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.playerStop).toHaveBeenCalledTimes(1));

    usePlayerStore.setState({ status: loaded({ state: "playing" }) });
    rerender(<HeaderPlayerControls />);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(api.playerPause).toHaveBeenCalledTimes(1));
  });

  it("进度条：拖动时以本地位置显示并跳转，键盘方向键按 5 秒跳转", async () => {
    render(<HeaderPlayerControls />);
    const slider = screen.getByRole("slider", { name: "播放进度" });
    // 位置按内层轨道换算（外层两侧有留白，避免滑块贴到时间文字）
    const track = slider.firstElementChild as HTMLElement;
    track.getBoundingClientRect = () =>
      ({ left: 0, width: 100, top: 0, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    slider.setPointerCapture = () => {};

    fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 });
    expect(slider.getAttribute("aria-valuenow")).toBe("50000000");
    fireEvent.pointerUp(slider, { clientX: 75, pointerId: 1 });
    await waitFor(() => expect(api.playerSeek).toHaveBeenLastCalledWith(75_000_000));
    expect(slider.getAttribute("aria-valuenow")).toBe("10000000");

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await waitFor(() => expect(api.playerSeek).toHaveBeenLastCalledWith(15_000_000));
    fireEvent.keyDown(slider, { key: "Home" });
    await waitFor(() => expect(api.playerSeek).toHaveBeenLastCalledWith(0));
  });

  it("命令失败时给出提示", async () => {
    api.playerPlay.mockRejectedValue(new Error("no_player"));
    render(<HeaderPlayerControls />);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
