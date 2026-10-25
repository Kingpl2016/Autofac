// @vitest-environment jsdom
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
  recordingsList: vi.fn(),
  recordingsRename: vi.fn(),
  recordingsDelete: vi.fn(),
  controllerUploadRecording: vi.fn(),
  playerOpen: vi.fn(),
  recordingStop: vi.fn(),
}));
const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
const controller = vi.hoisted(() => ({
  connected: true,
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/invoke", () => tauri);
vi.mock("@/features/controller", () => ({
  useControllerStatus: () => ({
    status: { host: "", tcpPort: 1227, httpPort: 80, connected: controller.connected },
    refresh: vi.fn(),
  }),
}));
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  ...api,
}));

import { usePlayerStore } from "../hooks/usePlayerStore";
import { useRecordingStore } from "../hooks/useRecordingStore";
import { EMPTY_PLAYBACK, EMPTY_STATUS } from "../lib/types";
import { LibraryPanel } from "./LibraryPanel";

const entry = (over: Partial<Record<string, unknown>> = {}) => ({
  path: "D:/rec/show.artrec",
  fileName: "show.artrec",
  name: "开场秀",
  notes: "",
  bytes: 2048,
  modifiedUnixMs: 1_700_000_000_000,
  durationUs: 65_000_000,
  frames: 120,
  universes: [1, 2],
  sources: ["10.0.0.1"],
  recovered: false,
  valid: true,
  ...over,
});

function renderPanel(onPlayed?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LibraryPanel onPlayed={onPlayed} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  tauri.isTauri.mockReturnValue(true);
  controller.connected = true;
  usePlayerStore.setState({ status: EMPTY_PLAYBACK });
  useRecordingStore.setState({ status: EMPTY_STATUS });
  api.recordingsList.mockResolvedValue([entry(), entry({ path: "D:/rec/bad.artrec", name: "bad", valid: false })]);
});

afterEach(() => cleanup());

describe("LibraryPanel", () => {
  it("列出节目并标记损坏文件，损坏文件不可上传", async () => {
    renderPanel();
    expect(await screen.findByText("开场秀")).toBeTruthy();
    expect(screen.getByText("文件损坏")).toBeTruthy();
    const uploads = screen.getAllByRole("button", { name: "上传到核心板" }) as HTMLButtonElement[];
    expect(uploads[0].disabled).toBe(false);
    expect(uploads[1].disabled).toBe(true);
  });

  it("未连接核心板时禁用上传", async () => {
    controller.connected = false;
    renderPanel();
    await screen.findByText("开场秀");
    const uploads = screen.getAllByRole("button", { name: "上传到核心板" }) as HTMLButtonElement[];
    expect(uploads.every((b) => b.disabled)).toBe(true);
  });

  it("删除需要二次确认", async () => {
    api.recordingsDelete.mockResolvedValue(undefined);
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    expect(await screen.findByText("删除节目？")).toBeTruthy();
    expect(api.recordingsDelete).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "删除")!);
    await waitFor(() => expect(api.recordingsDelete).toHaveBeenCalledWith("D:/rec/show.artrec"));
  });

  it("重命名冲突时提示同名节目已存在", async () => {
    api.recordingsRename.mockRejectedValue(new Error("already_exists"));
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "重命名" })[0]);
    const input = screen.getByRole("textbox", { name: "重命名" });
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("同名节目已存在"));
    expect(api.recordingsRename).toHaveBeenCalledWith("D:/rec/show.artrec", "新名字");
  });

  it("上传成功后提示文件名", async () => {
    api.controllerUploadRecording.mockResolvedValue("show.artrec");
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "上传到核心板" })[0]);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success.mock.calls[0][0]).toContain("show.artrec");
  });
});

describe("LibraryPanel 回放入口", () => {
  it("首次回放需确认进入回放模式，确认后打开节目并通知父组件", async () => {
    api.playerOpen.mockResolvedValue(undefined);
    const onPlayed = vi.fn();
    renderPanel(onPlayed);
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    expect(await screen.findByText("进入回放模式？")).toBeTruthy();
    expect(api.playerOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "进入回放" }));
    await waitFor(() => expect(api.playerOpen).toHaveBeenCalledWith("D:/rec/show.artrec"));
    await waitFor(() => expect(onPlayed).toHaveBeenCalledTimes(1));
    expect(api.recordingStop).not.toHaveBeenCalled();
  });

  it("损坏的文件不能回放", async () => {
    renderPanel();
    await screen.findByText("开场秀");
    const plays = screen.getAllByRole("button", { name: "回放此节目" }) as HTMLButtonElement[];
    expect(plays[0].disabled).toBe(false);
    expect(plays[1].disabled).toBe(true);
  });

  it("录制进行中：确认后先停止录制再进入回放", async () => {
    useRecordingStore.setState({ status: { ...EMPTY_STATUS, recording: true } });
    const order: string[] = [];
    api.recordingStop.mockImplementation(async () => {
      order.push("stop");
    });
    api.playerOpen.mockImplementation(async () => {
      order.push("open");
    });
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    expect(await screen.findByText(/当前正在录制/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止录制并回放" }));
    await waitFor(() => expect(order).toEqual(["stop", "open"]));
  });

  it("已处于回放模式时直接切换节目，不再弹确认", async () => {
    usePlayerStore.setState({ status: { ...EMPTY_PLAYBACK, loaded: true } });
    api.playerOpen.mockResolvedValue(undefined);
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    await waitFor(() => expect(api.playerOpen).toHaveBeenCalledWith("D:/rec/show.artrec"));
    expect(screen.queryByText("进入回放模式？")).toBeNull();
  });

  it("后端提示录制进行中时给出可读文案", async () => {
    api.playerOpen.mockRejectedValue(new Error("recording_active"));
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "进入回放" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("录制进行中");
  });
});
