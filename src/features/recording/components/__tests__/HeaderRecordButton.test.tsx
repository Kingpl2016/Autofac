// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({ recordingStart: vi.fn(), recordingStop: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppModeStore } from "@/features/app-mode";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { EMPTY_STATUS, type RecordingStatus } from "../../lib/types";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { HeaderRecordButton } from "../HeaderRecordButton";

const renderButton = () =>
  render(
    <TooltipProvider>
      <HeaderRecordButton />
    </TooltipProvider>,
  );

const live = (over: Partial<RecordingStatus> = {}): RecordingStatus => ({
  ...EMPTY_STATUS,
  recording: true,
  elapsedUs: 83_400_000,
  universes: [1, 2, 3],
  stats: { ...EMPTY_STATUS.stats, frames: 321, bytes: 2048 },
  ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useRecordingStore.setState({ status: EMPTY_STATUS, last: null, sources: [] });
  useEngineStatusStore.setState({ appMode: "live", recording: false });
  useAppModeStore.setState({ transitioning: false });
  api.recordingStart.mockResolvedValue({ plan: { accepted: [1, 2] } });
  api.recordingStop.mockResolvedValue({ files: [{ frames: 10 }] });
});

afterEach(() => cleanup());

describe("HeaderRecordButton", () => {
  it("空闲：点击以快速录制开始，并提示结果", async () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "录制" }));
    await waitFor(() => expect(api.recordingStart).toHaveBeenCalledTimes(1));
    const args = api.recordingStart.mock.calls[0][0];
    expect(args.filter).toEqual({ sources: [], excludeSources: false, universes: [], protocols: [] });
    expect(args.fileStem).toMatch(/^\d{8}-\d{6}$/);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("开始失败时给出可读错误", async () => {
    api.recordingStart.mockRejectedValue(new Error("no_universes"));
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "录制" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("Universe");
  });

  it("启动过程中忙碌（防重复提交）", async () => {
    let resolve!: (v: unknown) => void;
    api.recordingStart.mockReturnValue(new Promise((r) => (resolve = r)));
    renderButton();
    const btn = screen.getByRole("button", { name: "录制" }) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(btn);
    await act(async () => resolve({ plan: { accepted: [1] } }));
    expect(api.recordingStart).toHaveBeenCalledTimes(1);
  });

  it("录制中：显示停止按钮与时间码，点击停止", async () => {
    useRecordingStore.setState({ status: live() });
    renderButton();
    const stop = screen.getByRole("button", { name: "停止录制" });
    expect(stop.textContent).toContain("1:23.4");
    fireEvent.click(stop);
    await waitFor(() => expect(api.recordingStop).toHaveBeenCalledTimes(1));
  });

  it("录制详情用 Popover：点击展开，列出时长 / 帧数 / 丢帧 / 大小 / Universe 数", async () => {
    useRecordingStore.setState({ status: live({ dropped: 0 }) });
    renderButton();
    expect(screen.queryByText("帧数")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "录制详情" }));
    const dl = (await screen.findByText("帧数")).closest("dl")!;
    expect(dl.textContent).toContain("321");
    expect(dl.textContent).toContain("2.0 KiB");
    expect(dl.textContent).toContain("1:23.4");
    expect(dl.textContent).toContain("3");
  });

  it("有丢帧或空间偏低时，在详情里用图标 + 文字标出，而不只是变色", async () => {
    useRecordingStore.setState({
      status: live({ dropped: 5, diskFreeBytes: 800_000_000, diskLevel: "low" }),
    });
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "录制详情" }));
    const dl = (await screen.findByText("帧数")).closest("dl")!;
    const dropped = dl.querySelector("dt.text-warning")!;
    expect(dropped).toBeTruthy();
    expect(dl.textContent).toContain("5");
    expect(dl.textContent).toContain("800 MB");
    expect(dl.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
  });

  it("分段录制：停止按钮显示会话总时长，旁边标出 P2；详情同时列出本段与会话时长", async () => {
    useRecordingStore.setState({
      status: live({
        part: 2,
        elapsedUs: 5_000_000,
        sessionElapsedUs: 65_000_000,
        partStartsUs: [0, 60_000_000],
      }),
    });
    renderButton();
    expect(screen.getByRole("button", { name: "停止录制" }).textContent).toContain("1:05.0");
    expect(screen.getByLabelText("第 2 段").textContent).toBe("P2");
    fireEvent.click(screen.getByRole("button", { name: "录制详情" }));
    const dl = (await screen.findByText("会话总时长")).closest("dl")!;
    expect(dl.textContent).toContain("第 2 段时长");
    expect(dl.textContent).toContain("0:05.0");
    expect(screen.getAllByTestId("record-head-strip").length).toBeGreaterThan(0);
  });

  it("有丢帧时顶栏直接用图标 + 文字标出丢帧数；没有分段时不显示 P1", () => {
    useRecordingStore.setState({ status: live({ part: 1, dropped: 7 }) });
    renderButton();
    const badge = screen.getByTestId("header-rec-dropped");
    expect(badge.textContent).toContain("丢帧 7");
    expect(badge.querySelector("svg")).toBeTruthy();
    expect(screen.queryByText("P1")).toBeNull();
  });

  it("播放器模式：不隐藏，用 aria-disabled 保持可聚焦，名称里写明原因，点击不会开始录制", () => {
    useEngineStatusStore.setState({ appMode: "player" });
    renderButton();
    const btn = screen.getByRole("button", { name: /录制：播放器模式下无法录制/ }) as HTMLButtonElement;
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.disabled).toBe(false); // 仍可聚焦，键盘用户也能读到原因
    fireEvent.click(btn);
    expect(api.recordingStart).not.toHaveBeenCalled();
  });

  it("模式切换进行中禁用", () => {
    useAppModeStore.setState({ transitioning: true });
    renderButton();
    expect((screen.getByRole("button", { name: "录制" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
