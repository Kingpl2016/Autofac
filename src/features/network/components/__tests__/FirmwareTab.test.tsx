// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({
  netdevInspectFirmware: vi.fn(),
  netdevStatus: vi.fn(),
  netdevOtaStatus: vi.fn(),
  netdevOtaConfirm: vi.fn(),
  netdevOtaUpload: vi.fn(),
}));
const pickers = vi.hoisted(() => ({ pickFirmwareFile: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<typeof import("../../lib/api")>()), ...api }));
vi.mock("@/shared/tauri/pickers", () => pickers);

import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import type { DeviceStatus, FirmwareInfo, NetDevice } from "../../lib/types";
import { useDeviceSessionStore } from "../../stores/useDeviceSessionStore";
import { useTransferStore } from "../../stores/useTransferStore";
import { useUpgradeStore } from "../../stores/useUpgradeStore";
import { FirmwareTab } from "../firmware/FirmwareTab";

const main: NetDevice = { id: "d1", name: "主舞台", host: "10.0.0.2", port: 80, hasToken: true };
const side: NetDevice = { id: "d2", name: "侧台", host: "10.0.0.3", port: 80, hasToken: true };
const backup: NetDevice = { id: "d3", name: "备份", host: "10.0.0.4", port: 80, hasToken: false };

const firmware: FirmwareInfo = {
  fileName: "artnet_p4-1.5.0.bin",
  size: 1_500_000,
  version: "1.5.0",
  projectName: "artnet_p4",
  buildTime: "12:30:00",
  buildDate: "Oct 27 2026",
  idfVersion: "v5.5.1",
};

const access: DeviceAccess = {
  state: "ok",
  canRead: true,
  canWrite: true,
  status: { status: null, online: true, error: null, isLoading: false, refetch: vi.fn() },
  tokenSet: true,
  forceWrite: false,
  setForceWrite: vi.fn(),
  markRebooting: vi.fn(),
};

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FirmwareTab device={main} devices={[main, side, backup]} access={access} />
    </QueryClientProvider>,
  );
}

const status = (version: string) => ({ version }) as DeviceStatus;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useUpgradeStore.setState({ stage: "idle", firmware: null, path: null, targets: [], stopRequested: false });
  useTransferStore.setState({ items: [] });
  useDeviceSessionStore.setState({ rebooting: {}, forceWrite: {} });
  api.netdevOtaStatus.mockResolvedValue({
    running: "ota_0",
    version: "1.4.2",
    compileTime: "Oct 20 2026",
    pendingVerify: false,
    rollbackEnabled: true,
  });
  api.netdevStatus.mockImplementation(async (id: string) => {
    if (id === "d1") return status("1.4.2");
    if (id === "d2") return status("1.5.0");
    throw { code: "network", message: "offline" };
  });
});
afterEach(() => cleanup());

async function chooseFirmware() {
  pickers.pickFirmwareFile.mockResolvedValue("C:\\fw\\artnet_p4-1.5.0.bin");
  api.netdevInspectFirmware.mockResolvedValue(firmware);
  fireEvent.click(await screen.findByRole("button", { name: "选择 .bin 固件" }));
  await screen.findByText("artnet_p4-1.5.0.bin");
}

describe("FirmwareTab 选择固件", () => {
  it("显示当前固件；待确认时可以手动确认", async () => {
    api.netdevOtaStatus.mockResolvedValue({
      running: "ota_1",
      version: "1.4.2",
      compileTime: "Oct 20 2026",
      pendingVerify: true,
      rollbackEnabled: true,
    });
    api.netdevOtaConfirm.mockResolvedValue(undefined);
    renderTab();
    expect(await screen.findByText("新固件等待确认")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "手动确认" }));
    await waitFor(() => expect(api.netdevOtaConfirm).toHaveBeenCalledWith("d1"));
  });

  it("选择后展示预检信息", async () => {
    renderTab();
    await chooseFirmware();
    expect(screen.getByText("artnet_p4")).toBeTruthy();
    expect(screen.getByText("v5.5.1")).toBeTruthy();
    expect(screen.getByText("Oct 27 2026 12:30:00")).toBeTruthy();
  });

  it("预检不通过时显示原因，不出现设备列表", async () => {
    pickers.pickFirmwareFile.mockResolvedValue("C:\\fw\\bad.bin");
    api.netdevInspectFirmware.mockRejectedValue({ code: "invalid", message: "不是 ESP 应用固件" });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "选择 .bin 固件" }));
    expect(await screen.findByText("不是 ESP 应用固件")).toBeTruthy();
    expect(screen.queryByText("目标设备")).toBeNull();
  });

  it("取消选择文件不改变状态", async () => {
    pickers.pickFirmwareFile.mockResolvedValue(null);
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "选择 .bin 固件" }));
    expect(api.netdevInspectFirmware).not.toHaveBeenCalled();
  });
});

describe("FirmwareTab 目标设备", () => {
  it("当前设备默认勾选；离线设备不可选；版本关系有文字", async () => {
    renderTab();
    await chooseFirmware();
    await screen.findByText("可升级");

    const cbMain = screen.getByLabelText(/主舞台/) as HTMLInputElement;
    const cbSide = screen.getByLabelText(/侧台/) as HTMLInputElement;
    const cbBackup = screen.getByLabelText(/备份/) as HTMLInputElement;
    expect(cbMain.checked).toBe(true);
    expect(cbSide.checked).toBe(false);
    expect(cbBackup.disabled).toBe(true);
    expect(screen.getByText("已是此版本")).toBeTruthy();
    expect(screen.getByText("离线")).toBeTruthy();
    expect(screen.getByRole("button", { name: "升级 1 台设备" })).toBeTruthy();

    fireEvent.click(cbSide);
    expect(screen.getByRole("button", { name: "升级 2 台设备" })).toBeTruthy();
  });

  it("确认对话框列出设备与版本；取消不会开始", async () => {
    renderTab();
    await chooseFirmware();
    await screen.findByText("可升级");
    fireEvent.click(screen.getByRole("button", { name: "升级 1 台设备" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("1.5.0");
    expect(dialog.textContent).toContain("主舞台");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.netdevOtaUpload).not.toHaveBeenCalled();
  });
});

describe("FirmwareTab 升级", () => {
  it("上传失败：显示失败原因与恢复提示，汇总后可以完成", async () => {
    api.netdevOtaUpload.mockImplementation(() => ({
      id: "t1",
      promise: Promise.reject({ code: "no_space", message: "满" }),
      cancel: vi.fn(),
    }));
    renderTab();
    await chooseFirmware();
    await screen.findByText("可升级");
    fireEvent.click(screen.getByRole("button", { name: "升级 1 台设备" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "开始升级" }));

    expect(await screen.findByText("设备存储空间不足。", { exact: false })).toBeTruthy();
    expect(screen.getByText(/设备通常仍在旧固件上运行/)).toBeTruthy();
    expect(await screen.findByText("成功 0 台，失败 1 台，跳过 0 台。")).toBeTruthy();
    expect(api.netdevOtaUpload).toHaveBeenCalledWith("d1", "C:\\fw\\artnet_p4-1.5.0.bin", expect.any(Function));

    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(useUpgradeStore.getState().stage).toBe("idle"));
  });

  it("升级进行中显示阶段与进度条；传输进入全局队列", async () => {
    let progress: (p: { done: number; total: number; speedBps: number }) => void = () => undefined;
    api.netdevOtaUpload.mockImplementation((_id: string, _path: string, cb: typeof progress) => {
      progress = cb;
      return { id: "t1", promise: new Promise(() => undefined), cancel: vi.fn() };
    });
    renderTab();
    await chooseFirmware();
    await screen.findByText("可升级");
    fireEvent.click(screen.getByRole("button", { name: "升级 1 台设备" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "开始升级" }));

    await waitFor(() => expect(api.netdevOtaUpload).toHaveBeenCalled());
    progress({ done: 40, total: 100, speedBps: 10 });
    const bar = await screen.findByRole("progressbar", { name: "主舞台" });
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByText(/第 1\/4 步/)).toBeTruthy();
    expect(useTransferStore.getState().items[0]).toMatchObject({ kind: "ota", deviceId: "d1", state: "running" });
    // 只有一台时没有"后续设备"可取消
    expect((screen.getByRole("button", { name: "取消后续设备" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
