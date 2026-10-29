// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";

import i18n from "@/shared/i18n";
import { stubResizeObserver } from "@/test/mockTauriEvents";
import { renderWithProviders } from "@/test/renderWithProviders";
import { makeDevice } from "@/test/factories";

stubResizeObserver();

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

import type { DeviceConfig, DeviceStatus } from "../../lib/types";
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

const config: DeviceConfig = {
  artnetEnabled: true,
  sacnEnabled: false,
  targetMode: 0,
  sacnMulticast: 1,
  sacnPriority: 100,
  stopBehavior: 0,
  keepaliveMs: 1000,
  sourceName: "ArtNet Core",
  uartOutputEnabled: true,
  netOutputEnabled: true,
  forwardUniStart: 0,
  forwardUniCount: 8,
  forwardSacn: false,
  dhcp: true,
  ip: "0.0.0.0",
  netmask: "255.255.255.0",
  gateway: "192.168.1.1",
  hostname: "artnet-core",
  tokenSet: true,
};

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.search}</output>;
}

function renderView(initial = "/network") {
  return renderWithProviders(
    <>
      <NetworkView />
      <Where />
    </>,
    { route: initial },
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useActiveDeviceStore.setState({ activeId: null });
  useDeviceSessionStore.setState({ rebooting: {} });
  useTransferStore.setState({ items: [] });
  useEngineDataStore.setState({ devices: [] });
  localStorage.clear();
  api.netdevList.mockResolvedValue([dev("d1", "主舞台", "10.0.0.2"), dev("d2", "侧台", "10.0.0.3")]);
  api.netdevStatus.mockImplementation(async (id: string) => {
    if (id === "d2") throw { code: "unauthorized", message: "x" };
    return status();
  });
  api.netdevGetConfig.mockResolvedValue(config);
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

const rail = () => screen.findByRole("complementary", { name: "设备" });
const mainRegion = () => screen.findByRole("region", { name: "主舞台" });

describe("NetworkView 布局与设备栏", () => {
  it("没有设备：整页空状态与添加入口", async () => {
    api.netdevList.mockResolvedValue([]);
    renderView();
    expect(await screen.findAllByText("还没有设备")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "添加设备" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("设备栏显示每台设备的状态：在线 / 需要 Token；页头汇总计数", async () => {
    renderView();
    const r = await rail();
    await within(r).findByText("固件 1.4.2");
    expect(within(r).getByText("在线")).toBeTruthy();
    expect((await within(r).findAllByText("需要 Token")).length).toBeGreaterThan(0);

    const fleet = screen.getByRole("group", { name: "设备状态汇总" });
    await waitFor(() => expect(fleet.textContent).toContain("1 需 Token"));
    expect(fleet.textContent).toContain("2 台");
    expect(fleet.textContent).toContain("1 在线");
  });

  it("设备栏键盘：↓ 移到下一台，F2 编辑，Delete 移除（先确认）", async () => {
    renderView();
    const r = await rail();
    const first = await within(r).findByRole("button", { name: /^主舞台/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = within(r).getByRole("button", { name: /^侧台/ });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: "F2" });
    expect(await screen.findByRole("dialog", { name: "编辑设备" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.keyDown(second, { key: "Delete" });
    expect((await screen.findByRole("dialog")).textContent).toContain("侧台");
    expect(api.netdevRemove).not.toHaveBeenCalled();
  });

  it("移除设备在“⋯”菜单里，并且要确认", async () => {
    api.netdevRemove.mockResolvedValue(undefined);
    renderView();
    const r = await rail();
    await within(r).findByText("固件 1.4.2");
    fireEvent.keyDown(within(r).getByRole("button", { name: "更多操作: 主舞台" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: /^移除设备/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("不会改动设备本身");
    expect(api.netdevRemove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));
    await waitFor(() => expect(api.netdevRemove).toHaveBeenCalledWith("d1"));
  });

  it("设备超过 5 台时出现搜索框，按名称或 IP 过滤", async () => {
    api.netdevList.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => dev(`d${i}`, `舞台 ${i}`, `10.0.1.${i}`)),
    );
    api.netdevStatus.mockResolvedValue(status());
    renderView();
    const r = await rail();
    const search = await within(r).findByRole("searchbox", { name: "搜索名称或 IP" });
    fireEvent.change(search, { target: { value: "10.0.1.3" } });
    expect(within(r).getByRole("button", { name: /^舞台 3/ })).toBeTruthy();
    expect(within(r).queryByRole("button", { name: /^舞台 2/ })).toBeNull();
    fireEvent.change(search, { target: { value: "没有这台" } });
    expect(within(r).getByText("没有匹配的设备")).toBeTruthy();
  });

  it("设备发现页的 Art-Net 节点出现在候选里，点击添加预填表单", async () => {
    useEngineDataStore.setState({
      devices: [
        makeDevice({ ip: "10.0.0.50", hostname: "ans-node-50", artnetPorts: 1 }),
        // 已保存的、离线的、非 Art-Net 的都不应出现
        makeDevice({ ip: "10.0.0.2", hostname: "x", artnetPorts: 1 }),
        makeDevice({ ip: "10.0.0.60", hostname: "y", artnetPorts: 1, online: false }),
        makeDevice({ ip: "10.0.0.70", hostname: "z", category: "computer" }),
      ],
    });
    renderView();
    const r = await rail();
    await within(r).findByText("固件 1.4.2");
    // 已有设备时候选默认收起，标题上显示数量
    expect(within(r).getByText("(1)")).toBeTruthy();
    expect(within(r).queryByText("ans-node-50")).toBeNull();
    fireEvent.click(within(r).getByRole("button", { name: /发现的设备/ }));
    expect(await within(r).findByText("ans-node-50")).toBeTruthy();
    expect(within(r).queryByText("10.0.0.60")).toBeNull();
    expect(within(r).queryByText("10.0.0.70")).toBeNull();

    fireEvent.click(within(r).getByRole("button", { name: "添加" }));
    const dialog = await screen.findByRole("dialog", { name: "添加设备" });
    expect((within(dialog).getByLabelText("主机 / IP") as HTMLInputElement).value).toBe("10.0.0.50");
  });
});

describe("NetworkView 设备头与 Tab", () => {
  it("默认选中第一台设备：设备头、4 张指标卡与 5 个 Tab", async () => {
    renderView();
    const region = await mainRegion();
    expect(await within(region).findByText("节目")).toBeTruthy();
    expect(within(region).getByText("可播放 SD 卡上的节目")).toBeTruthy();
    expect(within(region).getByText("剩余 600 B")).toBeTruthy();
    expect(await within(region).findByText("已验证")).toBeTruthy();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["文件", "播放控制", "配置", "诊断与日志", "固件"]);
    expect(screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected")).toBe("true");
  });

  it("Tab 写入 URL；非法值回退；旧版 tab=commands&sub=logs 改写为诊断", async () => {
    renderView("/network?tab=commands&sub=logs");
    const diag = await screen.findByRole("tab", { name: "诊断与日志" });
    expect(diag.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("?tab=diag"));

    fireEvent.mouseDown(screen.getByRole("tab", { name: "播放控制" }), { button: 0 });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("?tab=control"));

    fireEvent.mouseDown(screen.getByRole("tab", { name: "文件" }), { button: 0 });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(""));
    cleanup();

    renderView("/network?tab=bogus");
    expect((await screen.findByRole("tab", { name: "文件" })).getAttribute("aria-selected")).toBe("true");
  });

  it("选中需要 Token 的设备：显示提示条，按钮打开编辑对话框", async () => {
    renderView();
    const r = await rail();
    fireEvent.click(await within(r).findByRole("button", { name: /^侧台/ }));
    expect(await screen.findByText("设备要求 Token")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "设置 Token" }));
    expect(await screen.findByRole("dialog", { name: "编辑设备" })).toBeTruthy();
  });

  it("设备没配置 Token：默认可写，不显示只读提示", async () => {
    api.netdevGetConfig.mockResolvedValue({ ...config, tokenSet: false });
    renderView();
    const region = await mainRegion();
    await within(region).findByText("节目");
    expect(screen.queryByText("只读模式：设备尚未配置 Token")).toBeNull();
    expect(screen.queryByText("设备当前不可写，无法上传")).toBeNull();
  });

  it("播放中：显示“正在播放”条（可暂停 / 停止）；切到播放控制 Tab 时由完整播放器代替", async () => {
    api.netdevStatus.mockImplementation(async (id: string) => {
      if (id === "d2") throw { code: "unauthorized", message: "x" };
      return status({ player: { state: 2, programNo: 1, posMs: 30_000, durMs: 120_000 } });
    });
    api.netdevPlayer.mockResolvedValue({
      state: 2,
      programNo: 1,
      repeat: 1,
      speedX100: 100,
      posMs: 30_000,
      durMs: 120_000,
      universes: 4,
      frames: 10,
      badFrames: 0,
    });
    api.netdevListFiles.mockResolvedValue([{ name: "开场秀.artrec", size: 1, isDir: false, program: 1 }]);
    renderView();
    const bar = await screen.findByRole("region", { name: "正在播放" });
    expect(await within(bar).findByText("开场秀.artrec")).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "暂停" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "停止" })).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "播放控制" }), { button: 0 });
    await waitFor(() => expect(screen.queryByRole("region", { name: "正在播放" })).toBeNull());
  });

  it("配置有未保存的更改时，切走后 Tab 上有提示，回来草稿还在", async () => {
    renderView();
    await mainRegion();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "配置" }), { button: 0 });
    const field = await screen.findByLabelText("sACN 优先级");
    fireEvent.change(field, { target: { value: "150" } });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "文件" }), { button: 0 });
    await waitFor(() => expect(screen.getByRole("tab", { name: /配置/ }).textContent).toContain("有未保存的更改"));

    fireEvent.mouseDown(screen.getByRole("tab", { name: /配置/ }), { button: 0 });
    expect((screen.getByLabelText("sACN 优先级") as HTMLInputElement).value).toBe("150");
  });
});
