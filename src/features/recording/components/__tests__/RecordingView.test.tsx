// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/shared/i18n";

const api = vi.hoisted(() => ({
  recordingsList: vi.fn(),
  playerOverview: vi.fn(),
  playerSetViewed: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/features/settings", () => ({
  useSettingsQuery: () => ({ data: { display: { valueFormat: "decimal" } } }),
  useProtocolFlags: () => ({ sacnEnabled: false }),
}));
vi.mock("@/features/network", () => ({
  useActiveDevice: () => ({ device: null, setActive: vi.fn() }),
  useDeviceStatus: () => ({ online: false, status: null, error: null, isLoading: false, refetch: vi.fn() }),
  netdevUploadRecording: vi.fn(),
  errorText: () => "",
  useTransferStore: { getState: () => ({ run: vi.fn() }) },
}));
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

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { usePlayerStore } from "../../stores/usePlayerStore";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { EMPTY_PLAYBACK, EMPTY_STATUS } from "../../lib/types";
import { RecordingView } from "../RecordingView";

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <RecordingView />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** 让 `(min-width: …)` 媒体查询按指定结果返回。 */
function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const entry = {
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
};

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.recordingsList.mockResolvedValue([entry]);
  api.playerOverview.mockRejectedValue(new Error("no overview"));
  api.playerSetViewed.mockResolvedValue(undefined);
  usePlayerStore.setState({ status: EMPTY_PLAYBACK, channels: {} });
  useRecordingStore.setState({ status: EMPTY_STATUS, last: null, sources: [] });
  useEngineDataStore.setState({ universes: [], devices: [] });
  useEngineStatusStore.setState({ appMode: "live", recording: false, playing: false });
  stubMatchMedia(true);
});

afterEach(() => cleanup());

describe("RecordingView", () => {
  it("宽屏：显示录制表单，节目库作为常驻侧栏显示节目；回放在播放器页", async () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "录制" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始录制" })).toBeTruthy();
    // 没有“录制 / 回放”页内分段切换；实时模式下页头也没有播放器入口（从顶栏进入播放模式）
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("link", { name: "前往播放器" })).toBeNull();
    const aside = screen.getByRole("complementary", { name: "节目库" });
    expect(await screen.findByText("开场秀")).toBeTruthy();
    expect(aside.contains(screen.getByText("开场秀"))).toBe(true);
  });

  it("播放器模式下录制区域换成说明面板，但工作区保持挂载、仅本次的备注不丢失，节目库仍可用", async () => {
    renderView();
    fireEvent.change(screen.getByLabelText("备注（仅本次）"), { target: { value: "彩排" } });

    act(() => useEngineStatusStore.setState({ appMode: "player" }));
    expect(screen.getByText("播放器模式下实时接收已停止")).toBeTruthy();
    expect(screen.getByText("播放器模式下无法录制。退出播放器模式后即可录制。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出播放器模式" })).toBeTruthy();
    // 工作区只是隐藏，并未卸载
    const input = screen.getByLabelText("备注（仅本次）", { selector: "input" }) as HTMLInputElement;
    expect(input.closest("[hidden]")).toBeTruthy();
    expect(input.value).toBe("彩排");
    // 节目库仍在，可管理节目
    expect(await screen.findByText("开场秀")).toBeTruthy();

    act(() => useEngineStatusStore.setState({ appMode: "live" }));
    expect(screen.queryByText("播放器模式下实时接收已停止")).toBeNull();
    expect((screen.getByLabelText("备注（仅本次）") as HTMLInputElement).value).toBe("彩排");
  });

  it("录制状态只由走带条表达，页头不再重复状态胶囊；时间码取会话总时长", () => {
    useRecordingStore.setState({
      status: {
        ...EMPTY_STATUS,
        recording: true,
        part: 2,
        elapsedUs: 2_300_000,
        sessionElapsedUs: 62_300_000,
        partStartsUs: [0, 60_000_000],
        universes: [1],
      },
    });
    renderView();
    expect(screen.getAllByText("录制中")).toHaveLength(1);
    expect(screen.getByText("1:02.3")).toBeTruthy();
    expect(screen.queryByText("0:02.3")).toBeNull();
  });

  it("窄屏：有尚未查看的新录制时节目库按钮带提示点，打开抽屉后消失", async () => {
    stubMatchMedia(false);
    useRecordingStore.setState({
      last: {
        files: [{ path: "D:/rec/show.artrec", durationUs: 1, frames: 1, bytes: 1, sources: [] }],
        error: null,
        dropped: 0,
        stoppedBy: null,
      },
    });
    renderView();
    expect(screen.getByTestId("library-new-dot")).toBeTruthy();
    expect(screen.getByRole("button", { name: /节目库.*有新录制的节目/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /节目库/ }));
    await screen.findByRole("dialog");
    expect(screen.queryByTestId("library-new-dot")).toBeNull();
  });

  it("窄屏：没有常驻侧栏，页头按钮打开节目库抽屉", async () => {
    stubMatchMedia(false);
    renderView();
    expect(screen.queryByRole("complementary", { name: "节目库" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "节目库" }));
    const drawer = await screen.findByRole("dialog");
    expect(drawer).toBeTruthy();
    await waitFor(() => expect(screen.getByText("开场秀")).toBeTruthy());
  });
});
