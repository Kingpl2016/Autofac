// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
const api = vi.hoisted(() => ({
  scanNetwork: vi.fn(),
  getDevices: vi.fn(),
  clearOfflineDevices: vi.fn(),
  setDeviceName: vi.fn(),
}));
const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/invoke", () => tauri);
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  ...api,
}));

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { DiscoveryView } from "./DiscoveryView";

const summary = (over: Partial<Record<string, unknown>> = {}) => ({
  targets: 2,
  sent: 6,
  responded: 3,
  totalArtnet: 5,
  errors: [],
  ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  tauri.isTauri.mockReturnValue(true);
  useEngineDataStore.setState({ devices: [] });
});

afterEach(() => cleanup());

describe("DiscoveryView 网络扫描", () => {
  it("扫描期间按钮禁用并显示“扫描中…”，成功后提示响应数量", async () => {
    let resolve!: (v: unknown) => void;
    api.scanNetwork.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<DiscoveryView />);

    fireEvent.click(screen.getByRole("button", { name: "网络扫描" }));

    const busy = await screen.findByRole("button", { name: "扫描中…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    resolve(summary());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success.mock.calls[0][0]).toContain("3 个 Art-Net 节点响应");
    expect(screen.getByRole("button", { name: "网络扫描" })).toBeTruthy();
  });

  it("没有节点响应时给出排查提示（警告而非成功）", async () => {
    api.scanNetwork.mockResolvedValue(summary({ responded: 0, totalArtnet: 0 }));
    render(<DiscoveryView />);

    fireEvent.click(screen.getByRole("button", { name: "网络扫描" }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning.mock.calls[0][0]).toContain("UDP 6454");
  });

  it("后端错误码被翻译为可读文案", async () => {
    api.scanNetwork.mockRejectedValue(new Error("artnet_disabled"));
    render(<DiscoveryView />);

    fireEvent.click(screen.getByRole("button", { name: "网络扫描" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("Art-Net 未启用");
  });

  it("非桌面环境直接提示而不调用后端", () => {
    tauri.isTauri.mockReturnValue(false);
    render(<DiscoveryView />);

    fireEvent.click(screen.getByRole("button", { name: "网络扫描" }));

    expect(api.scanNetwork).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });
});
