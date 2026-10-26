// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/shared/i18n";

const api = vi.hoisted(() => ({
  recordingsList: vi.fn(),
  playerOverview: vi.fn(),
  playerSetViewed: vi.fn(),
  playerOpen: vi.fn(),
}));
const modeApi = vi.hoisted(() => ({
  appModeSet: vi.fn(),
  appModeGet: vi.fn(),
  stopRecordingForModeChange: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
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
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));
vi.mock("@/features/app-mode/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/features/app-mode/lib/api")>()),
  ...modeApi,
}));

import { ModeConfirmDialog, useAppModeStore } from "@/features/app-mode";
import { useModeDialogStore } from "@/features/app-mode/stores/useModeDialogStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { usePlayerStore } from "../../stores/usePlayerStore";
import { EMPTY_PLAYBACK } from "../../lib/types";
import { PlayerModeView } from "../PlayerModeView";

function renderView(extra?: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PlayerModeView />
        <ModeConfirmDialog />
        {extra}
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

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
  sources: [],
  recovered: false,
  valid: true,
};

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.recordingsList.mockResolvedValue([entry]);
  api.playerOverview.mockRejectedValue(new Error("no overview"));
  api.playerSetViewed.mockResolvedValue(undefined);
  api.playerOpen.mockResolvedValue(undefined);
  modeApi.appModeSet.mockResolvedValue({ mode: "player", receivers: "suspended", sender: "ready" });
  usePlayerStore.setState({ status: EMPTY_PLAYBACK, channels: {} });
  useEngineStatusStore.setState({ appMode: "live", recording: false, playing: false, sender: "ready" });
  useAppModeStore.setState({ transitioning: false });
  useModeDialogStore.setState({ request: null });
  stubMatchMedia(true);
});

afterEach(() => cleanup());

describe("PlayerModeView", () => {
  it("实时模式：显示入口卡片而不是回放面板；节目库仍在右侧", async () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "播放器" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "进入播放器模式" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "播放" })).toBeNull();
    expect(await screen.findByText("开场秀")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "节目库" })).toBeTruthy();
  });

  it("实时模式下从入口卡片进入：先确认，再切换", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "进入播放器模式" }));
    const dialog = await screen.findByRole("dialog");
    expect(modeApi.appModeSet).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "进入播放器模式" }));
    await waitFor(() => expect(modeApi.appModeSet).toHaveBeenCalledWith("player"));
  });

  it("实时模式下直接在节目库里回放：同样先确认", async () => {
    renderView();
    await screen.findByText("开场秀");
    fireEvent.click(screen.getAllByRole("button", { name: "回放此节目" })[0]);
    expect(await screen.findByText("进入播放器模式？")).toBeTruthy();
    expect(api.playerOpen).not.toHaveBeenCalled();
  });

  it("播放器模式：显示常驻横幅与回放面板（空状态引导去节目库）", async () => {
    useEngineStatusStore.setState({ appMode: "player", receivers: "suspended" });
    renderView();
    expect(screen.queryByRole("heading", { level: 2, name: "进入播放器模式" })).toBeNull();
    expect(screen.getByText("播放器模式")).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出播放器模式" })).toBeTruthy();
    expect(screen.getByText(/还没有打开节目/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "前往节目库" }));
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "节目库" }));
    expect(await screen.findByText("开场秀")).toBeTruthy();
  });

  it("窄屏：页头按钮打开节目库抽屉", async () => {
    stubMatchMedia(false);
    renderView();
    expect(screen.queryByRole("complementary", { name: "节目库" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "节目库" }));
    await waitFor(() => expect(screen.getByText("开场秀")).toBeTruthy());
  });
});
