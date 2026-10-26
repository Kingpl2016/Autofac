// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

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
  playerOpen: vi.fn(),
}));
const modeApi = vi.hoisted(() => ({
  appModeSet: vi.fn(),
  stopRecordingForModeChange: vi.fn(),
}));
const net = vi.hoisted(() => ({
  online: true,
  upload: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/features/network", () => ({
  useActiveDevice: () => ({
    device: { id: "d1", name: "主舞台", host: "10.0.0.2", port: 80, hasToken: true },
    setActive: vi.fn(),
  }),
  useDeviceStatus: () => ({ online: net.online, status: null, error: null, isLoading: false, refetch: vi.fn() }),
  netdevUploadRecording: net.upload,
  errorText: (_t: unknown, e: unknown) => (e as { message?: string })?.message ?? String(e),
  // 与真实实现等价：直接执行传输并返回结果
  useTransferStore: {
    getState: () => ({
      run: (_meta: unknown, start: (cb: () => void) => { promise: Promise<unknown> }) => start(() => undefined).promise,
    }),
  },
}));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));
vi.mock("@/features/app-mode/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/features/app-mode/lib/api")>()),
  ...modeApi,
}));

import { ModeConfirmDialog, useAppModeStore } from "@/features/app-mode";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { usePlayerStore } from "../../stores/usePlayerStore";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { EMPTY_PLAYBACK, EMPTY_STATUS } from "../../lib/types";
import { LibraryPanel } from "../LibraryPanel";

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
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <LibraryPanel onPlayed={onPlayed} />
        {/* 回放走统一的模式切换，确认对话框由布局挂载；测试里补上 */}
        <ModeConfirmDialog />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  net.online = true;
  usePlayerStore.setState({ status: EMPTY_PLAYBACK });
  useRecordingStore.setState({ status: EMPTY_STATUS });
  useEngineStatusStore.setState({ appMode: "live", recording: false, playing: false });
  useAppModeStore.setState({ transitioning: false });
  modeApi.appModeSet.mockResolvedValue({ mode: "player", receivers: "suspended", sender: "ready" });
  modeApi.stopRecordingForModeChange.mockResolvedValue(undefined);
  api.recordingsList.mockResolvedValue([entry(), entry({ path: "D:/rec/bad.artrec", name: "bad", valid: false })]);
});

afterEach(() => cleanup());

describe("LibraryPanel", () => {
  it("列出节目并标记损坏文件，损坏文件不可上传", async () => {
    renderPanel();
    expect(await screen.findByText("开场秀")).toBeTruthy();
    expect(screen.getByText("文件损坏")).toBeTruthy();
    const uploads = screen.getAllByRole("button", { name: "上传到设备" }) as HTMLButtonElement[];
    expect(uploads[0].disabled).toBe(false);
    expect(uploads[1].disabled).toBe(true);
  });

  it("没有在线的网络设备时禁用上传", async () => {
    net.online = false;
    renderPanel();
    await screen.findByText("开场秀");
    const uploads = screen.getAllByRole("button", { name: "上传到设备" }) as HTMLButtonElement[];
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
    expect(dialog.textContent).toContain("移入系统回收站");
    expect(dialog.textContent).toContain("可在回收站中恢复");
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "删除")!);
    await waitFor(() => expect(api.recordingsDelete).toHaveBeenCalledWith("D:/rec/show.artrec"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("已将“开场秀”移入回收站"));
  });

  it("无法移入回收站时提示原因，并说明节目已原样保留（不会永久删除）", async () => {
    api.recordingsDelete.mockRejectedValue(new Error("trash_failed: 回收站不可用"));
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "删除")!);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("无法移入回收站，节目已原样保留：回收站不可用"),
    );
    expect(toast.success).not.toHaveBeenCalled();
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
    net.upload.mockReturnValue({ id: "t1", promise: Promise.resolve("show.artrec"), cancel: vi.fn() });
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "上传到设备" })[0]);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success.mock.calls[0][0]).toContain("show.artrec");
  });
});

describe("LibraryPanel 连播标记", () => {
  const three = () => [
    entry({ path: "D:/rec/a.artrec", fileName: "a.artrec", name: "第一个" }),
    entry({ path: "D:/rec/bad.artrec", fileName: "bad.artrec", name: "损坏的", valid: false }),
    entry({ path: "D:/rec/c.artrec", fileName: "c.artrec", name: "第三个" }),
  ];
  const playing = (repeat: "off" | "loop" | "playlist") =>
    usePlayerStore.setState({
      status: { ...EMPTY_PLAYBACK, loaded: true, path: "D:/rec/a.artrec", name: "第一个", repeat },
    });

  it("连播模式下，只在播放中节目之后的下一个有效节目上显示“下一个”（跳过损坏文件）", async () => {
    api.recordingsList.mockResolvedValue(three());
    playing("playlist");
    renderPanel();
    await screen.findByText("第三个");
    const badges = screen.getAllByText("下一个");
    expect(badges).toHaveLength(1);
    expect(badges[0].closest("li")!.textContent).toContain("第三个");
  });

  it("关闭或循环模式下不显示“下一个”", async () => {
    api.recordingsList.mockResolvedValue(three());
    playing("loop");
    renderPanel();
    await screen.findByText("第三个");
    expect(screen.queryByText("下一个")).toBeNull();
  });

  it("播放中的已是最后一个有效节目时没有“下一个”", async () => {
    api.recordingsList.mockResolvedValue(three());
    usePlayerStore.setState({
      status: { ...EMPTY_PLAYBACK, loaded: true, path: "D:/rec/c.artrec", name: "第三个", repeat: "playlist" },
    });
    renderPanel();
    await screen.findByText("第三个");
    expect(screen.queryByText("下一个")).toBeNull();
  });
});

describe("LibraryPanel 搜索与高亮", () => {
  it("按名称搜索过滤节目，无匹配时给出提示", async () => {
    api.recordingsList.mockResolvedValue([
      entry(),
      entry({ path: "D:/rec/b.artrec", fileName: "b.artrec", name: "收尾曲" }),
    ]);
    renderPanel();
    await screen.findByText("开场秀");
    expect(screen.getByText("收尾曲")).toBeTruthy();

    const box = screen.getByRole("searchbox", { name: "搜索节目" });
    fireEvent.change(box, { target: { value: "收尾" } });
    expect(screen.queryByText("开场秀")).toBeNull();
    expect(screen.getByText("收尾曲")).toBeTruthy();

    fireEvent.change(box, { target: { value: "不存在的节目" } });
    expect(screen.getByText("没有匹配的节目")).toBeTruthy();
  });

  it("刚结束的录制在列表里带“刚录制”标记，其余节目没有", async () => {
    api.recordingsList.mockResolvedValue([
      entry({ path: "D:\\rec\\new.artrec", name: "新录的" }),
      entry({ path: "D:/rec/old.artrec", name: "旧的" }),
    ]);
    useRecordingStore.setState({
      last: {
        files: [{ path: "D:/rec/new.artrec", durationUs: 1, frames: 1, bytes: 1, sources: [] }],
        error: null,
        dropped: 0,
        stoppedBy: null,
      },
    });
    renderPanel();
    await screen.findByText("新录的");
    expect(screen.getAllByText("刚录制")).toHaveLength(1);
    const card = screen.getByText("新录的").closest("li")!;
    expect(card.textContent).toContain("刚录制");
    useRecordingStore.setState({ last: null });
  });

  it("正在回放的节目带“回放中”标记", async () => {
    usePlayerStore.setState({
      status: { ...EMPTY_PLAYBACK, loaded: true, path: "D:/rec/show.artrec" },
    });
    renderPanel();
    await screen.findByText("开场秀");
    expect(screen.getByText("回放中")).toBeTruthy();
  });
});

describe("LibraryPanel 回放入口", () => {
  it("实时模式下回放需确认进入播放器模式，确认后打开节目并通知父组件", async () => {
    api.playerOpen.mockResolvedValue(undefined);
    const onPlayed = vi.fn();
    renderPanel(onPlayed);
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    expect(await screen.findByText("进入播放器模式？")).toBeTruthy();
    expect(api.playerOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "进入播放器模式" }));
    await waitFor(() => expect(api.playerOpen).toHaveBeenCalledWith("D:/rec/show.artrec"));
    await waitFor(() => expect(onPlayed).toHaveBeenCalledTimes(1));
    expect(modeApi.stopRecordingForModeChange).not.toHaveBeenCalled();
    // 节目由后端 player_open 自动进入播放器模式，不需要再单独调用 app_mode_set
    expect(modeApi.appModeSet).not.toHaveBeenCalled();
  });

  it("取消确认不会打开节目", async () => {
    renderPanel();
    await screen.findByText("开场秀");
    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    await screen.findByText("进入播放器模式？");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("进入播放器模式？")).toBeNull());
    expect(api.playerOpen).not.toHaveBeenCalled();
  });

  it("损坏的文件不能回放", async () => {
    renderPanel();
    await screen.findByText("开场秀");
    const plays = screen.getAllByRole("button", { name: "回放此节目" }) as HTMLButtonElement[];
    expect(plays[0].disabled).toBe(false);
    expect(plays[1].disabled).toBe(true);
  });

  it("录制进行中：对话框说明会先停止并保存，确认后先停止录制再打开节目", async () => {
    useEngineStatusStore.setState({ recording: true });
    const order: string[] = [];
    modeApi.stopRecordingForModeChange.mockImplementation(async () => {
      order.push("stop");
    });
    api.playerOpen.mockImplementation(async () => {
      order.push("open");
    });
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    expect(await screen.findByText(/正在进行的录制会先停止并保存/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止录制并进入" }));
    await waitFor(() => expect(order).toEqual(["stop", "open"]));
  });

  it("已处于播放器模式时直接切换节目，不再弹确认，也不重复提示“已进入”", async () => {
    useEngineStatusStore.setState({ appMode: "player" });
    usePlayerStore.setState({ status: { ...EMPTY_PLAYBACK, loaded: true } });
    api.playerOpen.mockResolvedValue(undefined);
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    await waitFor(() => expect(api.playerOpen).toHaveBeenCalledWith("D:/rec/show.artrec"));
    expect(screen.queryByText("进入播放器模式？")).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("后端提示录制进行中时给出可读文案", async () => {
    api.playerOpen.mockRejectedValue(new Error("recording_active"));
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "进入播放器模式" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("录制进行中");
  });

  it("打不开节目时说明是哪个原因，而不是笼统的“切换模式失败”", async () => {
    api.playerOpen.mockRejectedValue(new Error("文件头损坏"));
    renderPanel();
    await screen.findByText("开场秀");

    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "进入播放器模式" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("文件头损坏");
    expect(toast.error.mock.calls[0][0]).not.toContain("切换模式失败");
  });
});
