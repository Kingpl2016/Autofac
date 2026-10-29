// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";

import i18n from "@/shared/i18n";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({
  recordingsList: vi.fn(),
  recordingsEdit: vi.fn(),
  recordingsEditCancel: vi.fn(),
  playerOverview: vi.fn(),
  playerClose: vi.fn(),
  playerOpen: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
// 进度事件走 Tauri 事件；测试里没有 Tauri，订阅直接返回空的取消函数
vi.mock("@/shared/tauri/events", async () => (await import("@/test/mockTauriEvents")).tauriEventsModule);
vi.mock("@/features/network", () => ({
  useActiveDevice: () => ({ device: null, setActive: vi.fn() }),
  useDeviceStatus: () => ({ online: false, status: null, error: null, isLoading: false, refetch: vi.fn() }),
  netdevUploadRecording: vi.fn(),
  errorText: (_t: unknown, e: unknown) => String(e),
  useTransferStore: { getState: () => ({ run: vi.fn() }) },
}));
const modeApi = vi.hoisted(() => ({ appModeSet: vi.fn(), stopRecordingForModeChange: vi.fn() }));
vi.mock("@/features/app-mode/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/features/app-mode/lib/api")>()),
  ...modeApi,
}));
vi.mock("@/features/recording/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/features/recording/lib/api")>()),
  ...api,
}));

import type { LibraryEntry } from "@/features/recording";
import { ModeConfirmDialog } from "@/features/app-mode";
import { useModeDialogStore } from "@/features/app-mode/stores/useModeDialogStore";
import { resetPlayerRouteMode } from "@/features/app-mode/lib/playerRouteMode";
import { usePlayerStore } from "@/features/recording";
import { EMPTY_PLAYBACK } from "@/features/recording/lib/types";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useEditDraftStore } from "../../stores/useEditDraftStore";
import { ProgramEditView } from "../edit/ProgramEditView";

const PATH = "D:/rec/开场秀.artrec";
const ENTRY: LibraryEntry = {
  path: PATH,
  fileName: "开场秀.artrec",
  name: "开场秀",
  notes: "",
  bytes: 4096,
  modifiedUnixMs: 0,
  durationUs: 10_000_000,
  frames: 200,
  universes: [1, 2],
  sources: [],
  recovered: false,
  valid: true,
  editable: false,
  exported: true,
  header: null,
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderEdit(entry: LibraryEntry = ENTRY, extra: React.ReactNode = null) {
  api.recordingsList.mockResolvedValue([entry]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: "/library/edit",
        element: (
          <>
            <ProgramEditView />
            {extra}
          </>
        ),
      },
      { path: "/player", element: <LocationProbe /> },
      { path: "/library", element: <LocationProbe /> },
    ],
    { initialEntries: [`/library/edit?path=${encodeURIComponent(entry.path)}`] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** 把播放头向右移动若干秒（Shift + →，每次 1 秒）。 */
const seekSeconds = (n: number) => {
  for (let i = 0; i < n; i += 1) fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
};

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useEditDraftStore.getState().reset("", 0, []);
  useEngineStatusStore.setState({ appMode: "live", recording: false, playing: false });
  api.playerOpen.mockResolvedValue(undefined);
  useModeDialogStore.getState().close();
  resetPlayerRouteMode();
  usePlayerStore.setState({ status: EMPTY_PLAYBACK });
  modeApi.appModeSet.mockResolvedValue({ mode: "player", receivers: "suspended", sender: "ready" });
  api.playerOverview.mockResolvedValue({
    durationUs: 10_000_000,
    buckets: 4,
    universes: [1, 2],
    change: [new Uint8Array([1, 0, 0, 0]), new Uint8Array([0, 0, 0, 0])],
    level: [new Uint8Array([200, 10, 0, 0]), new Uint8Array([0, 0, 0, 0])],
    frames: 200,
    skippedFrames: 0,
  });
});
afterEach(() => cleanup());

describe("编辑导出页", () => {
  it("切割、删除片段、去掉一个 Universe 后另存；完成后留在本页，可去节目库查看新节目", async () => {
    api.recordingsEdit.mockResolvedValue({ path: "D:/rec/开场秀（编辑）.artrec", durationUs: 5_000_000, frames: 90, bytes: 1, universes: [1] });
    const router = renderEdit();
    expect(await screen.findByRole("heading", { name: "编辑：开场秀" })).toBeTruthy();
    expect(screen.getByText("结果 0:10.000 · 2 个 Universe")).toBeTruthy();

    seekSeconds(5);
    fireEvent.click(screen.getByRole("button", { name: "在播放头处切割" }));
    // 切开后选中右半段，删除它
    expect(screen.getByRole("button", { name: "片段 2：0:05.000 至 0:10.000" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "删除选中片段" }));
    expect(screen.getByText("结果 0:05.000 · 2 个 Universe")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /U2/ }));
    expect(screen.getByText("结果 0:05.000 · 1 个 Universe")).toBeTruthy();

    expect((screen.getByRole("textbox", { name: "新节目名称" }) as HTMLInputElement).value).toBe("开场秀（编辑）");
    expect(screen.getByText("将保存为 开场秀（编辑）.artrec（重名时自动加编号）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "另存为新节目" }));
    await waitFor(() => expect(api.recordingsEdit).toHaveBeenCalledTimes(1));
    const req = api.recordingsEdit.mock.calls[0][0] as Record<string, unknown>;
    expect(req).toMatchObject({
      path: PATH,
      segments: [{ startUs: 0, endUs: 5_000_000 }],
      universes: [1],
      output: { kind: "new", name: "开场秀（编辑）" },
    });
    expect(typeof req.jobId).toBe("string");
    expect(await screen.findByText("已另存为新节目")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/library/edit");
    expect(toast.success).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "在节目库中查看" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
    expect(new URLSearchParams(router.state.location.search).get("sel")).toBe("D:/rec/开场秀（编辑）.artrec");
  });

  it("撤销 / 重做片段修改", async () => {
    renderEdit();
    await screen.findByRole("heading", { name: "编辑：开场秀" });
    seekSeconds(3);
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getAllByRole("button", { name: /^片段 \d：/ })).toHaveLength(2);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.getAllByRole("button", { name: /^片段 \d：/ })).toHaveLength(1);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(screen.getAllByRole("button", { name: /^片段 \d：/ })).toHaveLength(2);
  });

  it("片段边缘可用键盘修剪，时间码输入可精确设置", async () => {
    renderEdit();
    await screen.findByRole("heading", { name: "编辑：开场秀" });
    const handle = screen.getByRole("slider", { name: "片段 1 开始" });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle.getAttribute("aria-valuetext")).toBe("0:01.000");

    const end = screen.getByRole("textbox", { name: "结束" });
    fireEvent.change(end, { target: { value: "8.5" } });
    fireEvent.keyDown(end, { key: "Enter" });
    expect(screen.getByText("结果 0:07.500 · 2 个 Universe")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "开始" }), { target: { value: "abc" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "开始" }));
    expect(screen.getByRole("alert").textContent).toContain("格式为");
  });

  it("编辑器节目不能替换原节目；有未导出修改时离开需要确认", async () => {
    const router = renderEdit({ ...ENTRY, editable: true });
    await screen.findByRole("heading", { name: "编辑：开场秀" });
    expect((screen.getByRole("radio", { name: /^替换原节目/ }) as HTMLInputElement).disabled).toBe(true);

    seekSeconds(2);
    fireEvent.keyDown(window, { key: "i" });
    await act(() => router.navigate("/library"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("放弃未导出的修改？")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/library/edit"));
  });

  it("替换失败时给出可读原因", async () => {
    api.recordingsEdit.mockRejectedValue("in_use");
    renderEdit();
    await screen.findByRole("heading", { name: "编辑：开场秀" });
    fireEvent.click(screen.getByRole("radio", { name: /^替换原节目/ }));
    // 还没有修改时不能替换
    expect((screen.getByRole("button", { name: "替换原节目" }) as HTMLButtonElement).disabled).toBe(true);
    seekSeconds(2);
    fireEvent.keyDown(window, { key: "i" });
    fireEvent.click(screen.getByRole("button", { name: "替换原节目" }));
    // 替换前二次确认
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("移入系统回收站");
    expect(api.recordingsEdit).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "替换原节目" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("导出失败：节目正在播放器中打开，请先关闭后再替换"));
    expect(api.recordingsEdit.mock.calls[0][0]).toMatchObject({ output: { kind: "replace" }, universes: null });
  });

  it("进入编辑页直接进入播放器模式（不弹确认），打开节目并留在本页", async () => {
    const router = renderEdit(ENTRY, <ModeConfirmDialog />);
    await screen.findByRole("heading", { name: "编辑：开场秀" });
    await waitFor(() => expect(modeApi.appModeSet).toHaveBeenCalledWith("player"));
    await waitFor(() => expect(api.playerOpen).toHaveBeenCalledWith(PATH));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(router.state.location.pathname).toBe("/library/edit");
    expect(await screen.findByText("播放器模式 · 实时接收已暂停")).toBeTruthy();
  });

  it("进入播放器模式失败时提示原因，并可在本页重试", async () => {
    modeApi.appModeSet.mockRejectedValueOnce("transition_in_progress");
    renderEdit();
    await screen.findByRole("heading", { name: "编辑：开场秀" });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByText(/当前不在播放器模式/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "进入播放器模式" }));
    await waitFor(() => expect(api.playerOpen).toHaveBeenCalledWith(PATH));
  });

  it("Ctrl+S 另存；名称为空时不能导出并说明原因；导出后再修改会回到导出表单", async () => {
    api.recordingsEdit.mockResolvedValue({ path: "D:/rec/x.artrec", durationUs: 10_000_000, frames: 1, bytes: 1, universes: [1, 2] });
    renderEdit();
    await screen.findByRole("heading", { name: "编辑：开场秀" });
    const nameBox = screen.getByRole("textbox", { name: "新节目名称" });
    fireEvent.change(nameBox, { target: { value: " " } });
    expect((screen.getByRole("button", { name: "另存为新节目" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("请填写新节目名称").length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(api.recordingsEdit).not.toHaveBeenCalled();

    fireEvent.change(nameBox, { target: { value: "新的" } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.recordingsEdit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已另存为新节目")).toBeTruthy();

    seekSeconds(3);
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.queryByText("已另存为新节目")).toBeNull();
    expect(screen.getByRole("button", { name: "另存为新节目" })).toBeTruthy();
  });

  it("离开编辑页时卸载预览打开的节目", async () => {
    const router = renderEdit();
    await screen.findByRole("heading", { name: "编辑：开场秀" });
    act(() => usePlayerStore.setState({ status: { ...EMPTY_PLAYBACK, loaded: true, path: PATH } }));
    await act(() => router.navigate("/library"));
    expect(api.playerClose).toHaveBeenCalled();
  });

  it("已在播放器模式且播放器空闲时直接打开节目，不再确认", async () => {
    useEngineStatusStore.setState({ appMode: "player" });
    renderEdit(ENTRY, <ModeConfirmDialog />);
    await screen.findByRole("heading", { name: "编辑：开场秀" });
    await waitFor(() => expect(api.playerOpen).toHaveBeenCalledWith(PATH));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("播放器模式 · 实时接收已暂停")).toBeTruthy();
  });
});