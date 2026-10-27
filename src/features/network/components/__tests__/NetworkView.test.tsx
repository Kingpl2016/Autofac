// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";

import i18n from "@/shared/i18n";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({
  netdevList: vi.fn(),
  netdevSave: vi.fn(),
  netdevRemove: vi.fn(),
  netdevSetToken: vi.fn(),
  netdevProbe: vi.fn(),
  netdevStatus: vi.fn(),
  netdevGetConfig: vi.fn(),
  netdevListFiles: vi.fn(),
  netdevPlayer: vi.fn(),
  netdevOtaStatus: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<typeof import("../../lib/api")>()), ...api }));
vi.mock("@/shared/tauri/dragDrop", () => ({ listenFileDrop: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("@/shared/tauri/pickers", () => ({
  pickArtrecFiles: vi.fn(),
  pickFirmwareFile: vi.fn(),
  pickSavePath: vi.fn(),
}));
// 活动设备选择写入 Tauri Store，测试里用内存实现
vi.mock("@/shared/tauri/tauriStorage", () => {
  const mem = new Map<string, unknown>();
  return {
    createTauriPersistStorage: () => ({
      getItem: async (k: string) => mem.get(k) ?? null,
      setItem: async (k: string, v: unknown) => void mem.set(k, v),
      removeItem: async (k: string) => void mem.delete(k),
    }),
  };
});

import type { DeviceStatus } from "../../lib/types";
import { useActiveDeviceStore } from "../../stores/useActiveDeviceStore";
import { useDeviceSessionStore } from "../../stores/useDeviceSessionStore";
import { useTransferStore } from "../../stores/useTransferStore";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { NetworkView } from "../NetworkView";

const dev = (id: string, name: string, host: string, hasToken = true) => ({ id, name, host, port: 80, hasToken });

const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  version: "1.4.2",
  workMode: 4,
  ip: "10.0.0.2",
  netmask: "255.255.255.0",
  gateway: "10.0.0.1",
  viaDhcp: true,
  linkUp: true,
  sdMounted: true,
  sdTotal: 1000,
  sdFree: 600,
  player: { state: 0, programNo: 0, posMs: 0, durMs: 0 },
  ...over,
});

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.search}</output>;
}

function renderView(initial = "/network") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <NetworkView />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useActiveDeviceStore.setState({ activeId: null });
  useDeviceSessionStore.setState({ rebooting: {} });
  useTransferStore.setState({ items: [] });
  useEngineDataStore.setState({ devices: [] });
  api.netdevList.mockResolvedValue([dev("d1", "主舞台", "10.0.0.2"), dev("d2", "侧台", "10.0.0.3")]);
  api.netdevStatus.mockImplementation(async (id: string) => {
    if (id === "d2") throw { code: "unauthorized", message: "x" };
    return status();
  });
  api.netdevGetConfig.mockResolvedValue({ tokenSet: true });
  api.netdevListFiles.mockResolvedValue([]);
  api.netdevPlayer.mockResolvedValue({});
  api.netdevOtaStatus.mockResolvedValue({
    running: "ota_0",
    version: "1.4.2",
    compileTime: "x",
    pendingVerify: false,
    rollbackEnabled: true,
  });
});
afterEach(() => cleanup());

describe("NetworkView", () => {
  it("没有设备：整页空状态与添加入口", async () => {
    api.netdevList.mockResolvedValue([]);
    renderView();
    expect(await screen.findAllByText("还没有设备")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "添加设备" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("设备栏显示每台设备的状态：在线 / 需要 Token", async () => {
    renderView();
    const rail = await screen.findByRole("complementary", { name: "设备" });
    await within(rail).findByText("固件 1.4.2");
    expect(within(rail).getByText("在线")).toBeTruthy();
    expect(await within(rail).findByText("需要 Token")).toBeTruthy();
  });

  it("默认选中第一台设备并显示摘要与三个 Tab", async () => {
    renderView();
    expect(await screen.findByRole("region", { name: "主舞台" })).toBeTruthy();
    expect(await screen.findByText("4 · 节目")).toBeTruthy();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["文件操作", "指令操作", "固件升级"]);
    expect(screen.getByRole("tab", { name: "文件操作" }).getAttribute("aria-selected")).toBe("true");
  });

  it("Tab 与指令子分段写入 URL；非法值回退", async () => {
    renderView("/network?tab=bogus");
    await screen.findByRole("tab", { name: "文件操作" });
    expect(screen.getByRole("tab", { name: "文件操作" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "指令操作" }), { button: 0 });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("?tab=commands"));

    fireEvent.click(await screen.findByRole("radio", { name: "诊断" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("?tab=commands&sub=diag"));

    fireEvent.mouseDown(screen.getByRole("tab", { name: "文件操作" }), { button: 0 });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(""));
  });

  it("选中需要 Token 的设备：显示横幅，按钮打开编辑对话框", async () => {
    renderView();
    const rail = await screen.findByRole("complementary", { name: "设备" });
    fireEvent.click(await within(rail).findByRole("button", { name: /^侧台/ }));
    const banner = await screen.findByText("设备要求 Token");
    expect(banner).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "设置 Token" }));
    expect(await screen.findByRole("dialog", { name: "编辑设备" })).toBeTruthy();
  });

  it("设备没配置 Token：默认可写，不显示只读提示", async () => {
    api.netdevGetConfig.mockResolvedValue({ tokenSet: false });
    renderView();
    await screen.findByText("4 · 节目");
    expect(screen.queryByText("只读模式：设备尚未配置 Token")).toBeNull();
  });

  it("移除设备要确认；确认后调用删除", async () => {
    api.netdevRemove.mockResolvedValue(undefined);
    renderView();
    const rail = await screen.findByRole("complementary", { name: "设备" });
    await within(rail).findByText("固件 1.4.2");
    fireEvent.click(within(rail).getByRole("button", { name: "移除设备: 主舞台" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("不会改动设备本身");
    expect(api.netdevRemove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));
    await waitFor(() => expect(api.netdevRemove).toHaveBeenCalledWith("d1"));
  });

  it("设备发现页的 Art-Net 节点出现在候选里，点击添加预填表单", async () => {
    useEngineDataStore.setState({
      devices: [
        { ip: "10.0.0.50", hostname: "ans-node-50", customName: null, mac: null, category: "artNet", artnetPorts: 1, online: true, lastSeenMs: 0 },
        // 已保存的、离线的、非 Art-Net 的都不应出现
        { ip: "10.0.0.2", hostname: "x", customName: null, mac: null, category: "artNet", artnetPorts: 1, online: true, lastSeenMs: 0 },
        { ip: "10.0.0.60", hostname: "y", customName: null, mac: null, category: "artNet", artnetPorts: 1, online: false, lastSeenMs: 0 },
        { ip: "10.0.0.70", hostname: "z", customName: null, mac: null, category: "computer", artnetPorts: null, online: true, lastSeenMs: 0 },
      ],
    });
    renderView();
    const rail = await screen.findByRole("complementary", { name: "设备" });
    expect(await within(rail).findByText("ans-node-50")).toBeTruthy();
    expect(within(rail).queryByText("10.0.0.60")).toBeNull();
    expect(within(rail).queryByText("10.0.0.70")).toBeNull();

    fireEvent.click(within(rail).getByRole("button", { name: "添加" }));
    const dialog = await screen.findByRole("dialog", { name: "添加设备" });
    expect((within(dialog).getByLabelText("主机 / IP") as HTMLInputElement).value).toBe("10.0.0.50");
  });
});
