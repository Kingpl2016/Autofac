// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

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
const flags = vi.hoisted(() => ({ sacnEnabled: false }));
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
// 偏好存储不落盘：测试里用内存即可
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));
vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: flags.sacnEnabled }),
}));
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => nav.navigate,
}));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import type { Device } from "@/shared/domain/device";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { DEFAULT_PREFS, useDiscoveryPrefs } from "../../stores/useDiscoveryPrefs";
import { useScanSession } from "../../stores/useScanSession";
import { DiscoveryView } from "../DiscoveryView";

const dev = (over: Partial<Device> & { ip: string }): Device => ({
  hostname: null,
  customName: null,
  mac: null,
  category: "artNet",
  artnetPorts: null,
  online: true,
  lastSeenMs: 0,
  ...over,
});

const summary = (over: Partial<Record<string, unknown>> = {}) => ({
  targets: 2,
  sent: 6,
  responded: 3,
  totalArtnet: 5,
  errors: [],
  ...over,
});

const renderView = () =>
  render(
    <MemoryRouter>
      <DiscoveryView />
    </MemoryRouter>,
  );

/** 表体里的数据行（不含表头）。 */
const dataRows = () =>
  screen
    .getAllByRole("row")
    .filter((r) => r.getAttribute("data-ip") !== null);

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  flags.sacnEnabled = false;
  api.getDevices.mockResolvedValue([]);
  useEngineDataStore.setState({ devices: [] });
  useDiscoveryPrefs.setState({ ...DEFAULT_PREFS });
  useScanSession.setState({ scanning: false, last: null, noReplyDismissed: false });
});

afterEach(() => cleanup());

describe("DiscoveryView 网络扫描", () => {
  it("“实时 · 扫描状态”紧挨在页头的“网络扫描”按钮左侧，不再单独占一行", () => {
    renderView();
    const scanButton = screen.getByRole("button", { name: "网络扫描" });
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("尚未扫描");
    // 与扫描按钮同在页头右侧操作区
    expect(scanButton.parentElement?.contains(status)).toBe(true);
    expect(scanButton.parentElement?.textContent).toContain("实时");
  });

  it("扫描期间按钮禁用并显示“扫描中…”，完成后状态条显示响应与新增数量", async () => {
    useEngineDataStore.setState({ devices: [dev({ ip: "10.0.0.1" })] });
    let resolve!: (v: unknown) => void;
    api.scanNetwork.mockReturnValue(new Promise((r) => (resolve = r)));
    api.getDevices.mockResolvedValue([dev({ ip: "10.0.0.1" }), dev({ ip: "10.0.0.2" })]);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "网络扫描" }));

    const busy = await screen.findByRole("button", { name: "扫描中…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("正在向各网卡广播");

    resolve(summary());
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("响应 3/5 · 新增 1"),
    );
    expect(screen.getByRole("button", { name: "网络扫描" })).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("没有节点响应时显示常驻排查提示，可关闭；不弹 toast", async () => {
    api.scanNetwork.mockResolvedValue(summary({ responded: 0, totalArtnet: 0 }));
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "网络扫描" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("UDP 6454");
    expect(toast.warning).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole("button", { name: "知道了" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("部分网卡发送失败时用 toast 警告", async () => {
    api.scanNetwork.mockResolvedValue(summary({ errors: ["eth1: denied"] }));
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "网络扫描" }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.warning.mock.calls[0][0]).toContain("eth1: denied");
  });

  it("后端错误码被翻译为可读文案", async () => {
    api.scanNetwork.mockRejectedValue(new Error("artnet_disabled"));
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "网络扫描" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("Art-Net 未启用");
    // 失败后按钮恢复可点
    expect(
      (screen.getByRole("button", { name: "网络扫描" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

});

describe("DiscoveryView sACN 开关", () => {
  it("sACN 关闭时不显示 sACN 筛选标签，副标题只提 Art-Net", () => {
    flags.sacnEnabled = false;
    renderView();

    expect(screen.queryByRole("button", { name: /sACN/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Art-Net/ })).toBeTruthy();
    expect(screen.queryByText(/sACN/)).toBeNull();
  });

  it("sACN 开启时显示 sACN 筛选标签与完整副标题", () => {
    flags.sacnEnabled = true;
    renderView();

    expect(screen.getByRole("button", { name: /sACN/ })).toBeTruthy();
    expect(screen.getByText(/Art-Net \/ sACN/)).toBeTruthy();
  });

  it("停在 sACN 标签时关闭 sACN，列表回落到“全部”", () => {
    useDiscoveryPrefs.setState({ category: "sacn" });
    useEngineDataStore.setState({
      devices: [dev({ ip: "10.0.0.1" }), dev({ ip: "10.0.0.2", category: "sacn" })],
    });
    flags.sacnEnabled = false;
    renderView();

    expect(dataRows()).toHaveLength(2);
  });
});

describe("DiscoveryView 空状态", () => {
  it("一台设备都没有时引导去扫描", async () => {
    api.scanNetwork.mockResolvedValue(summary());
    renderView();

    expect(screen.getByText("还没有发现设备")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "立即扫描" }));
    await waitFor(() => expect(api.scanNetwork).toHaveBeenCalled());
  });

  it("筛选后为空时给出清除筛选入口", () => {
    useEngineDataStore.setState({ devices: [dev({ ip: "10.0.0.1" })] });
    renderView();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索设备" }), {
      target: { value: "没有这台设备" },
    });

    expect(screen.getByText("没有符合条件的设备")).toBeTruthy();
    const empty = screen.getByText("没有符合条件的设备").parentElement!.parentElement!;
    fireEvent.click(within(empty).getByRole("button", { name: "清除筛选" }));
    expect(dataRows()).toHaveLength(1);
  });
});

describe("DiscoveryView 筛选与排序", () => {
  const list = [
    dev({ ip: "10.0.0.10", hostname: "Stage-Left", online: true }),
    dev({ ip: "10.0.0.2", customName: "舞台右", online: false, category: "cluster" }),
    dev({ ip: "10.0.0.5", hostname: "Truss", online: true, category: "computer" }),
  ];

  beforeEach(() => useEngineDataStore.setState({ devices: list }));

  it("按分类、在线状态和搜索词过滤，并显示“已筛选”提示", () => {
    renderView();
    expect(dataRows()).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: /^在线\s*2$/ }));
    expect(dataRows()).toHaveLength(2);
    expect(screen.getByText("已筛选 2 / 3 台")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^计算机/ }));
    expect(dataRows()).toHaveLength(1);

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索设备" }), {
      target: { value: "truss" },
    });
    expect(dataRows()).toHaveLength(1);

    fireEvent.click(screen.getAllByRole("button", { name: "清除筛选" })[0]);
    expect(dataRows()).toHaveLength(3);
  });

  it("点表头排序并更新 aria-sort；再点一次反向", () => {
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "按“IP 地址”排序" }));
    const ipHeader = screen.getByRole("columnheader", { name: /IP 地址/ });
    expect(ipHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(dataRows().map((r) => r.getAttribute("data-ip"))).toEqual([
      "10.0.0.2",
      "10.0.0.5",
      "10.0.0.10",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "按“IP 地址”排序" }));
    expect(ipHeader.getAttribute("aria-sort")).toBe("descending");
    expect(dataRows()[0].getAttribute("data-ip")).toBe("10.0.0.10");
  });

  it("筛选 / 排序写入偏好 store（由插件落盘）", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: /^离线/ }));
    fireEvent.click(screen.getByRole("button", { name: "按“设备”排序" }));

    const s = useDiscoveryPrefs.getState();
    expect(s.status).toBe("offline");
    expect(s.sort).toEqual({ key: "name", dir: "asc" });
  });

  it("已保存的偏好在打开页面时直接生效", () => {
    useDiscoveryPrefs.setState({ status: "offline" });
    renderView();
    expect(dataRows().map((r) => r.getAttribute("data-ip"))).toEqual(["10.0.0.2"]);
  });
});

describe("DiscoveryView 详情面板", () => {
  const node = dev({
    ip: "10.0.0.7",
    hostname: "Node-7",
    mac: "AA:BB:CC:00:00:07",
    shortName: "N7",
    firmware: "2.5",
    nodeReport: "#0001 [0003] OK",
    ports: [
      { index: 0, direction: "output", universe: (1 << 8) | (2 << 4) | 3, active: true },
      { index: 1, direction: "input", universe: 4, active: false },
    ],
  });

  beforeEach(() => useEngineDataStore.setState({ devices: [node, dev({ ip: "10.0.0.8" })] }));

  const openPanel = () => {
    renderView();
    fireEvent.click(dataRows()[0]);
    return screen.getByRole("complementary", { name: "设备详情" });
  };

  it("点击行打开面板，展示扩展字段与端口表", () => {
    const panel = openPanel();
    expect(within(panel).getByRole("heading", { name: "Node-7", level: 2 })).toBeTruthy();
    expect(within(panel).getByText("AA:BB:CC:00:00:07")).toBeTruthy();
    expect(within(panel).getByText("2.5")).toBeTruthy();
    expect(within(panel).getByText("#0001 [0003] OK")).toBeTruthy();
    expect(within(panel).getByText("1:2:3")).toBeTruthy();
    expect(within(panel).getByText("端口 1")).toBeTruthy();
    expect(dataRows()[0].getAttribute("aria-current")).toBe("true");
  });

  it("再次点击同一行或按 Esc 关闭面板", () => {
    openPanel();
    fireEvent.click(dataRows()[0]);
    expect(screen.queryByRole("complementary")).toBeNull();

    fireEvent.click(dataRows()[0]);
    const panel = screen.getByRole("complementary");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("键盘：Enter 打开详情，↓ 移动焦点到下一行", () => {
    renderView();
    const rows = dataRows();
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(screen.getByRole("complementary")).toBeTruthy();
  });

  it("重命名：Enter 提交，调用后端并立即更新界面", () => {
    api.setDeviceName.mockResolvedValue(undefined);
    const panel = openPanel();

    fireEvent.click(within(panel).getByRole("button", { name: "重命名" }));
    const input = within(panel).getByRole("textbox");
    fireEvent.change(input, { target: { value: "  主舞台  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(api.setDeviceName).toHaveBeenCalledWith("10.0.0.7", "主舞台");
    expect(
      within(screen.getByRole("complementary")).getByRole("heading", { level: 2 }).textContent,
    ).toBe("主舞台");
  });

  it("重命名时按 Esc 只取消编辑，不关闭面板，也不保存", () => {
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "重命名" }));
    fireEvent.keyDown(within(panel).getByRole("textbox"), { key: "Escape" });

    expect(screen.getByRole("complementary")).toBeTruthy();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(api.setDeviceName).not.toHaveBeenCalled();
  });

  it("F2 在列表行上直接进入重命名", () => {
    renderView();
    const row = dataRows()[0];
    row.focus();
    fireEvent.keyDown(row, { key: "F2" });
    expect(within(screen.getByRole("complementary")).getByRole("textbox")).toBeTruthy();
  });

  it("“添加为转发目的地”跳转转发页并携带预填信息", () => {
    const panel = openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "添加为转发目的地" }));

    expect(nav.navigate).toHaveBeenCalledWith("/forwarding", {
      state: { prefill: { name: "Node-7", targetIp: "10.0.0.7" } },
    });
  });
});

describe("DiscoveryView 清理离线设备", () => {
  beforeEach(() =>
    useEngineDataStore.setState({
      devices: [dev({ ip: "10.0.0.1" }), dev({ ip: "10.0.0.2", online: false })],
    }),
  );

  it("先确认再清理，并写明数量", async () => {
    api.clearOfflineDevices.mockResolvedValue([dev({ ip: "10.0.0.1" })]);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "清理离线设备" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("1 台离线设备");
    expect(api.clearOfflineDevices).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "清理" }));
    });
    await waitFor(() => expect(api.clearOfflineDevices).toHaveBeenCalled());
    await waitFor(() => expect(dataRows()).toHaveLength(1));
  });

  it("没有离线设备时按钮禁用", () => {
    useEngineDataStore.setState({ devices: [dev({ ip: "10.0.0.1" })] });
    renderView();
    expect(
      (screen.getByRole("button", { name: "清理离线设备" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("DiscoveryView 信息列、MAC 开关与转发入口", () => {
  const node = dev({
    ip: "10.0.0.7",
    hostname: "Node-7",
    mac: "AA:BB:CC:00:00:07",
    firmware: "2.5",
    ports: [
      { index: 0, direction: "output", universe: 1, active: true },
      { index: 1, direction: "output", universe: 2, active: true },
      { index: 2, direction: "input", universe: 1, active: false },
    ],
  });
  const peer = dev({ ip: "10.0.0.9", category: "cluster", hostname: "HA-B" });
  const pc = dev({ ip: "10.0.0.20", category: "computer", hostname: "控台" });

  beforeEach(() => useEngineDataStore.setState({ devices: [node, peer, pc] }));

  it("“Art-Net 信息”列：Universe 数与固件；集群显示 HA 对端；其它设备为占位符", () => {
    renderView();
    expect(screen.getByRole("columnheader", { name: "Art-Net 信息" })).toBeTruthy();
    const cells = (ip: string) =>
      Array.from(
        (dataRows().find((r) => r.getAttribute("data-ip") === ip) as HTMLTableRowElement).cells,
      ).map((c) => c.textContent);
    expect(cells("10.0.0.7")).toContain("2 uni · fw 2.5");
    expect(cells("10.0.0.9")).toContain("HA 对端");
    expect(cells("10.0.0.20")).not.toContain("HA 对端");
    expect(cells("10.0.0.20").filter((c) => c === "—").length).toBeGreaterThanOrEqual(1);
  });

  it("打开详情面板后信息列与 MAC 列让位", () => {
    renderView();
    expect(screen.getByRole("columnheader", { name: "MAC" })).toBeTruthy();
    fireEvent.click(dataRows()[0]);
    expect(screen.queryByRole("columnheader", { name: "Art-Net 信息" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "MAC" })).toBeNull();
  });

  it("MAC 列开关：关闭后列消失，并保存到偏好", () => {
    renderView();
    const toggle = screen.getByRole("button", { name: "MAC 列" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("columnheader", { name: "MAC" })).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByRole("columnheader", { name: "MAC" })).toBeNull();
    expect(screen.getByRole("button", { name: "MAC 列" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(useDiscoveryPrefs.getState().showMac).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "MAC 列" }));
    expect(screen.getByRole("columnheader", { name: "MAC" })).toBeTruthy();
  });

  it("行尾按钮：不打开详情，直接跳转转发页并预填该设备", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "添加为转发目的地 Node-7" }));

    expect(nav.navigate).toHaveBeenCalledWith("/forwarding", {
      state: { prefill: { name: "Node-7", targetIp: "10.0.0.7" } },
    });
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("在行上按 F 同样跳转转发页", () => {
    renderView();
    const row = dataRows().find((r) => r.getAttribute("data-ip") === "10.0.0.7") as HTMLElement;
    row.focus();
    fireEvent.keyDown(row, { key: "f" });

    expect(nav.navigate).toHaveBeenCalledWith("/forwarding", {
      state: { prefill: { name: "Node-7", targetIp: "10.0.0.7" } },
    });
  });
});
describe("DiscoveryView 表内行内改名", () => {
  const node = dev({ ip: "10.0.0.7", hostname: "Node-7", customName: "舞台左" });
  const other = dev({ ip: "10.0.0.8", hostname: "Node-8" });

  beforeEach(() => useEngineDataStore.setState({ devices: [node, other] }));

  const rowOf = (ip: string) =>
    dataRows().find((r) => r.getAttribute("data-ip") === ip) as HTMLTableRowElement;
  const startEdit = (name: string) =>
    fireEvent.click(screen.getByRole("button", { name: `重命名 ${name}` }));

  it("有自定义名时主行显示自定义名，设备自己的名字以小字补充", () => {
    renderView();
    const cell = rowOf("10.0.0.7").cells[0];
    expect(cell.textContent).toContain("舞台左");
    expect(cell.textContent).toContain("Node-7");
  });

  it("点击铅笔：行内出现输入框并带出当前自定义名，不打开详情面板", () => {
    renderView();
    startEdit("舞台左");
    const input = within(rowOf("10.0.0.7")).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("舞台左");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("Enter 保存：调用后端、立即更新界面，焦点回到该行", async () => {
    api.setDeviceName.mockResolvedValue(undefined);
    renderView();
    startEdit("Node-8");
    const input = within(rowOf("10.0.0.8")).getByRole("textbox");
    fireEvent.change(input, { target: { value: "  舞台右  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(api.setDeviceName).toHaveBeenCalledWith("10.0.0.8", "舞台右");
    expect(within(rowOf("10.0.0.8")).queryByRole("textbox")).toBeNull();
    expect(rowOf("10.0.0.8").cells[0].textContent).toContain("舞台右");
    await waitFor(() => expect(document.activeElement).toBe(rowOf("10.0.0.8")));
  });

  it("清空后保存会清除自定义名，退回设备自己的名字", () => {
    api.setDeviceName.mockResolvedValue(undefined);
    renderView();
    startEdit("舞台左");
    const input = within(rowOf("10.0.0.7")).getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(api.setDeviceName).toHaveBeenCalledWith("10.0.0.7", "");
    expect(rowOf("10.0.0.7").cells[0].textContent).toContain("Node-7");
    expect(rowOf("10.0.0.7").cells[0].textContent).not.toContain("舞台左");
  });

  it("Esc 取消：不保存，且不会关闭已打开的详情面板", () => {
    renderView();
    fireEvent.click(rowOf("10.0.0.8"));
    expect(screen.getByRole("complementary")).toBeTruthy();

    startEdit("舞台左");
    fireEvent.keyDown(within(rowOf("10.0.0.7")).getByRole("textbox"), { key: "Escape" });

    expect(api.setDeviceName).not.toHaveBeenCalled();
    expect(within(rowOf("10.0.0.7")).queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("complementary")).toBeTruthy();
  });

  it("失去焦点视为取消", () => {
    renderView();
    startEdit("舞台左");
    const input = within(rowOf("10.0.0.7")).getByRole("textbox");
    fireEvent.change(input, { target: { value: "没提交" } });
    fireEvent.blur(input);

    expect(api.setDeviceName).not.toHaveBeenCalled();
    expect(rowOf("10.0.0.7").cells[0].textContent).toContain("舞台左");
  });

  it("编辑时按方向键不会触发表格的行间移动", () => {
    renderView();
    startEdit("舞台左");
    const input = within(rowOf("10.0.0.7")).getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(input);
  });

  it("编辑时在输入框里按 F / C 不会触发转发或复制", () => {
    renderView();
    startEdit("舞台左");
    const input = within(rowOf("10.0.0.7")).getByRole("textbox");
    fireEvent.keyDown(input, { key: "f" });
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it("铅笔按钮只在当前行成为 Tab 停靠点", () => {
    renderView();
    const pencils = screen.getAllByRole("button", { name: /^重命名 / });
    expect(pencils.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });
});