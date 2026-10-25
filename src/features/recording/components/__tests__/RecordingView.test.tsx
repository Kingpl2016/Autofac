// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
vi.mock("@/features/controller", () => ({
  useControllerStatus: () => ({
    status: { host: "", tcpPort: 1227, httpPort: 80, connected: false },
    refresh: vi.fn(),
  }),
  controllerUploadRecording: vi.fn(),
}));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { usePlayerStore } from "../../stores/usePlayerStore";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { EMPTY_PLAYBACK, EMPTY_STATUS } from "../../lib/types";
import { RecordingView } from "../RecordingView";

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecordingView />
    </QueryClientProvider>,
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
  stubMatchMedia(true);
});

afterEach(() => cleanup());

describe("RecordingView", () => {
  it("宽屏：默认是录制模式，节目库作为常驻侧栏显示节目", async () => {
    renderView();
    expect(screen.getByRole("tab", { name: "录制", selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始录制" })).toBeTruthy();
    const aside = screen.getByRole("complementary", { name: "节目库" });
    expect(await screen.findByText("开场秀")).toBeTruthy();
    expect(aside.contains(screen.getByText("开场秀"))).toBe(true);
  });

  it("切换到回放模式不会丢失录制表单的输入", () => {
    renderView();
    const nameInput = screen.getByLabelText("节目名称") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "彩排" } });

    fireEvent.mouseDown(screen.getByRole("tab", { name: /^回放/ }), { button: 0 });
    expect(screen.getByRole("tab", { name: /^回放/, selected: true })).toBeTruthy();
    expect(screen.getByText(/还没有打开节目/)).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "录制" }), { button: 0 });
    expect((screen.getByLabelText("节目名称") as HTMLInputElement).value).toBe("彩排");
  });

  it("回放空状态的“前往节目库”在宽屏下聚焦侧栏", () => {
    renderView();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^回放/ }), { button: 0 });
    fireEvent.click(screen.getByRole("button", { name: "前往节目库" }));
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "节目库" }));
  });

  it("录制中在页头显示状态胶囊与时间", () => {
    useRecordingStore.setState({
      status: { ...EMPTY_STATUS, recording: true, elapsedUs: 12_300_000, universes: [1] },
    });
    renderView();
    expect(screen.getAllByText("录制中").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0:12.3").length).toBeGreaterThan(0);
  });

  it("已打开节目时，回放标签带“回放中”标记", () => {
    usePlayerStore.setState({
      status: { ...EMPTY_PLAYBACK, loaded: true, path: "x", name: "n", universes: [1] },
    });
    renderView();
    expect(screen.getByRole("img", { name: "回放中" })).toBeTruthy();
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
