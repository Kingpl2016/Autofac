// @vitest-environment jsdom
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
const api = vi.hoisted(() => ({
  playerPlay: vi.fn(),
  playerPause: vi.fn(),
  playerStop: vi.fn(),
  playerClose: vi.fn(),
  playerSeek: vi.fn(),
  playerSetSpeed: vi.fn(),
  playerSetLoop: vi.fn(),
  playerSetTarget: vi.fn(),
  playerSetViewed: vi.fn(),
  playerOverview: vi.fn(),
}));
const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/invoke", () => tauri);
vi.mock("@/features/settings", () => ({
  useSettingsQuery: () => ({ data: { display: { valueFormat: "decimal" } } }),
}));
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  ...api,
}));

import { usePlayerStore } from "../hooks/usePlayerStore";
import { EMPTY_PLAYBACK, type Overview, type PlaybackStatus } from "../lib/types";
import { PlayerPanel } from "./PlayerPanel";

const loaded = (over: Partial<PlaybackStatus> = {}): PlaybackStatus => ({
  ...EMPTY_PLAYBACK,
  loaded: true,
  path: "D:/rec/show.artrec",
  name: "开场秀",
  durationUs: 60_000_000,
  universes: [5, 6],
  destinations: 1,
  ...over,
});

const sampleOverview = (): Overview => ({
  durationUs: 60_000_000,
  buckets: 4,
  universes: [5, 6],
  change: [Uint8Array.from([255, 0, 0, 0]), Uint8Array.from([0, 0, 0, 0])],
  level: [Uint8Array.from([200, 200, 0, 0]), Uint8Array.from([0, 0, 0, 0])],
  frames: 3,
  skippedFrames: 0,
});

function renderPanel(go: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: ReactElement) => (
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
  const result = render(wrap(<PlayerPanel onGoLibrary={go} />));
  return {
    ...result,
    rerenderPanel: () => result.rerender(wrap(<PlayerPanel onGoLibrary={go} />)),
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  for (const fn of Object.values(api)) fn.mockResolvedValue(undefined);
  api.playerOverview.mockResolvedValue(sampleOverview());
  tauri.isTauri.mockReturnValue(true);
  usePlayerStore.setState({ status: EMPTY_PLAYBACK, channels: {} });
});

afterEach(() => cleanup());

describe("PlayerPanel", () => {
  it("未打开节目时给出引导并可跳转节目库", () => {
    const go = vi.fn();
    renderPanel(go);
    expect(screen.getByText(/还没有打开节目/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "前往节目库" }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("停止态点播放发送 play；播放态显示暂停并发送 pause", async () => {
    usePlayerStore.setState({ status: loaded() });
    const { rerenderPanel } = renderPanel();
    expect(screen.getByText("开场秀")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await waitFor(() => expect(api.playerPlay).toHaveBeenCalledTimes(1));

    usePlayerStore.setState({ status: loaded({ state: "playing" }) });
    rerenderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));
    await waitFor(() => expect(api.playerPause).toHaveBeenCalledTimes(1));
  });

  it("循环开关与退出回放分别发送对应命令", async () => {
    usePlayerStore.setState({ status: loaded() });
    renderPanel();

    fireEvent.click(screen.getByRole("switch", { name: "循环" }));
    await waitFor(() => expect(api.playerSetLoop).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "退出回放" }));
    await waitFor(() => expect(api.playerClose).toHaveBeenCalledTimes(1));
  });

  it("拖动进度条会发送 seek，并显示时间", async () => {
    usePlayerStore.setState({ status: loaded({ posUs: 5_000_000 }) });
    renderPanel();

    const bar = screen.getByRole("slider", { name: "播放进度" }) as HTMLInputElement;
    expect(bar.getAttribute("aria-valuetext")).toContain("0:05.0");
    fireEvent.change(bar, { target: { value: "30000000" } });
    await waitFor(() => expect(api.playerSeek).toHaveBeenCalledWith(30_000_000));
  });

  it("走转发表但没有启用的目的地时给出警告", () => {
    usePlayerStore.setState({ status: loaded({ destinations: 0 }) });
    renderPanel();
    expect(screen.getByText(/没有启用的目的地/)).toBeTruthy();
  });

  it("默认查看第一路 Universe 并同步到后端", async () => {
    usePlayerStore.setState({ status: loaded() });
    renderPanel();
    await waitFor(() => expect(api.playerSetViewed).toHaveBeenCalledWith([5]));
  });

  it("有损坏帧时提示已沿用上一帧", () => {
    usePlayerStore.setState({ status: loaded({ corruptFrames: 3 }) });
    renderPanel();
    expect(screen.getByText(/3 帧数据损坏/)).toBeTruthy();
  });
});

describe("PlayerPanel 时间线", () => {
  const timeline = () => screen.findByRole("slider", { name: /^时间线/ });

  it("加载概览后显示时间线与每路 Universe 的文字摘要", async () => {
    usePlayerStore.setState({ status: loaded() });
    renderPanel();
    expect(await timeline()).toBeTruthy();
    expect(api.playerOverview).toHaveBeenCalledWith("D:/rec/show.artrec");
    // 屏幕阅读器文字替代：Universe 5 在 1/4 的时间里有变化
    const row = (await screen.findByRole("rowheader", { name: "5" })).closest("tr")!;
    expect(row.textContent).toContain("25%");
    expect(row.textContent).toContain("200");
  });

  it("点击时间线按位置换算并 seek", async () => {
    usePlayerStore.setState({ status: loaded() });
    renderPanel();
    const tl = await timeline();
    tl.getBoundingClientRect = () =>
      ({ left: 100, width: 200, top: 0, height: 20, right: 300, bottom: 20, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;
    tl.setPointerCapture = vi.fn();

    fireEvent.pointerDown(tl, { clientX: 200, pointerId: 1 }); // 中点
    await waitFor(() => expect(api.playerSeek).toHaveBeenCalledWith(30_000_000));
    fireEvent.pointerUp(tl, { clientX: 300, pointerId: 1 }); // 末端（松开时一定发出最终位置）
    await waitFor(() => expect(api.playerSeek).toHaveBeenLastCalledWith(60_000_000));
  });

  it("方向键微调 1%，Home / End 回到两端", async () => {
    usePlayerStore.setState({ status: loaded({ posUs: 10_000_000 }) });
    renderPanel();
    const tl = await timeline();

    fireEvent.keyDown(tl, { key: "ArrowRight" });
    expect(api.playerSeek).toHaveBeenLastCalledWith(10_600_000);
    fireEvent.keyDown(tl, { key: "ArrowLeft" });
    expect(api.playerSeek).toHaveBeenLastCalledWith(9_400_000);
    fireEvent.keyDown(tl, { key: "Home" });
    expect(api.playerSeek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(tl, { key: "End" });
    expect(api.playerSeek).toHaveBeenLastCalledWith(60_000_000);
  });

  it("点击行标签切换通道栅格查看的 Universe", async () => {
    usePlayerStore.setState({ status: loaded() });
    renderPanel();
    await timeline();

    fireEvent.click(screen.getByRole("button", { name: "切换查看 Universe 6" }));
    await waitFor(() => expect(api.playerSetViewed).toHaveBeenLastCalledWith([5, 6]));
    fireEvent.click(screen.getByRole("button", { name: "切换查看 Universe 5" }));
    await waitFor(() => expect(api.playerSetViewed).toHaveBeenLastCalledWith([6]));
  });

  it("概览失败时给出提示而不是崩溃", async () => {
    api.playerOverview.mockRejectedValue(new Error("boom"));
    usePlayerStore.setState({ status: loaded() });
    renderPanel();
    expect(await screen.findByText("无法生成时间线概览")).toBeTruthy();
  });
});
