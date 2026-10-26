// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({
  netdevListFiles: vi.fn(),
  netdevDeleteFile: vi.fn(),
  netdevRenameFile: vi.fn(),
  netdevProgramOp: vi.fn(),
  netdevSetWorkmode: vi.fn(),
  netdevUploadFile: vi.fn(),
  netdevDownloadFile: vi.fn(),
}));
const pickers = vi.hoisted(() => ({ pickArtrecFiles: vi.fn(), pickSavePath: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<typeof import("../../lib/api")>()), ...api }));
vi.mock("@/shared/tauri/pickers", () => pickers);
vi.mock("@/shared/tauri/dragDrop", () => ({ listenFileDrop: vi.fn().mockResolvedValue(() => undefined) }));

import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import type { DeviceStatus, NetDevice, NetFile } from "../../lib/types";
import { useTransferStore } from "../../stores/useTransferStore";
import { FilesTab } from "../files/FilesTab";

const device: NetDevice = { id: "d1", name: "主舞台", host: "10.0.0.2", port: 80, hasToken: true };

const file = (name: string, program: number | null): NetFile => ({ name, size: 2048, isDir: false, program });

function accessWith(over: Partial<Omit<DeviceAccess, "status">> & { status?: Partial<DeviceStatus> } = {}): DeviceAccess {
  const { status, ...rest } = over;
  const full: DeviceStatus = {
    version: "1.4.2",
    workMode: 4,
    ip: "10.0.0.2",
    netmask: "255.255.255.0",
    gateway: "10.0.0.1",
    viaDhcp: true,
    linkUp: true,
    sdMounted: true,
    sdTotal: 1000,
    sdFree: 500,
    player: { state: 0, programNo: 0, posMs: 0, durMs: 0 },
    ...status,
  };
  return {
    state: "ok",
    canRead: true,
    canWrite: true,
    status: { status: full, online: true, error: null, isLoading: false, refetch: vi.fn() },
    tokenSet: true,
    forceWrite: false,
    setForceWrite: vi.fn(),
    markRebooting: vi.fn(),
    ...rest,
  };
}

function renderTab(access: DeviceAccess = accessWith()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FilesTab device={device} access={access} />
    </QueryClientProvider>,
  );
}

const row = (name: string) => screen.getByText(name).closest("li") as HTMLElement;
const dialogButton = (name: string) => within(screen.getByRole("dialog")).getByRole("button", { name });

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useTransferStore.setState({ items: [] });
  api.netdevListFiles.mockResolvedValue([
    file("b.artrec", 2),
    file("a.artrec", 1),
    file("new.artrec", null),
    { name: "DIR", size: 0, isDir: true, program: null },
  ]);
});
afterEach(() => cleanup());

describe("FilesTab 列表", () => {
  it("按节目号排序，未分配节目号的排在最后，目录不显示", async () => {
    renderTab();
    await screen.findByText("a.artrec");
    const names = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const order = ["a.artrec", "b.artrec", "new.artrec"].map((n) => names.findIndex((t) => t.includes(n)));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(screen.queryByText("DIR")).toBeNull();
  });

  it("没有文件时给出上传引导；SD 卡未挂载时给出原因", async () => {
    api.netdevListFiles.mockResolvedValue([]);
    renderTab();
    expect(await screen.findByText("设备上还没有节目文件")).toBeTruthy();
    cleanup();

    renderTab(accessWith({ status: { sdMounted: false } }));
    expect(await screen.findAllByText("SD 卡未挂载")).toBeTruthy();
  });

  it("只读模式：上传 / 重命名 / 删除 / 播放全部禁用，下载仍可用", async () => {
    renderTab(accessWith({ state: "readonly", canWrite: false }));
    await screen.findByText("a.artrec");
    expect((screen.getByRole("button", { name: "选择文件" }) as HTMLButtonElement).disabled).toBe(true);
    const r = within(row("a.artrec"));
    expect((r.getByRole("button", { name: /单次播放/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((r.getByRole("button", { name: /重命名/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((r.getByRole("button", { name: /删除/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((r.getByRole("button", { name: /下载/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("没有节目号的文件不能播放，并说明原因", async () => {
    renderTab();
    await screen.findByText("new.artrec");
    const play = within(row("new.artrec")).getByRole("button", { name: /单次播放/ }) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(play.title).toBe("设备尚未给这个文件分配节目号");
  });

  it("正在播放的文件显示状态并提供停止", async () => {
    renderTab(accessWith({ status: { player: { state: 2, programNo: 1, posMs: 0, durMs: 0 } } }));
    await screen.findByText("a.artrec");
    const r = within(row("a.artrec"));
    expect(r.getByText("播放中")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: /停止/ }));
    await waitFor(() => expect(api.netdevProgramOp).toHaveBeenCalledWith("d1", 1, 0));
  });
});

describe("FilesTab 播放", () => {
  it("节目模式下直接播放；循环用动作 3", async () => {
    api.netdevProgramOp.mockResolvedValue(undefined);
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.click(within(row("a.artrec")).getByRole("button", { name: /单次播放/ }));
    await waitFor(() => expect(api.netdevProgramOp).toHaveBeenCalledWith("d1", 1, 2));
    fireEvent.click(within(row("b.artrec")).getByRole("button", { name: /循环播放/ }));
    await waitFor(() => expect(api.netdevProgramOp).toHaveBeenCalledWith("d1", 2, 3));
    expect(api.netdevSetWorkmode).not.toHaveBeenCalled();
  });

  it("转发模式下先确认；确认后先切到节目模式再播放", async () => {
    const order: string[] = [];
    api.netdevSetWorkmode.mockImplementation(async () => void order.push("mode"));
    api.netdevProgramOp.mockImplementation(async () => void order.push("play"));
    renderTab(accessWith({ status: { workMode: 1 } }));
    await screen.findByText("a.artrec");

    fireEvent.click(within(row("a.artrec")).getByRole("button", { name: /单次播放/ }));
    expect(await screen.findByText("切换到节目模式后播放？")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Art-Net 转发");
    expect(api.netdevProgramOp).not.toHaveBeenCalled();

    fireEvent.click(dialogButton("切换并播放"));
    await waitFor(() => expect(order).toEqual(["mode", "play"]));
    expect(api.netdevSetWorkmode).toHaveBeenCalledWith("d1", 4);
  });

  it("取消确认不会改模式也不会播放", async () => {
    renderTab(accessWith({ status: { workMode: 2 } }));
    await screen.findByText("a.artrec");
    fireEvent.click(within(row("a.artrec")).getByRole("button", { name: /单次播放/ }));
    await screen.findByRole("dialog");
    fireEvent.click(dialogButton("取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.netdevSetWorkmode).not.toHaveBeenCalled();
    expect(api.netdevProgramOp).not.toHaveBeenCalled();
  });

  it("切换模式失败时不播放，并提示原因", async () => {
    api.netdevSetWorkmode.mockRejectedValue({ code: "unauthorized", message: "x" });
    renderTab(accessWith({ status: { workMode: 1 } }));
    await screen.findByText("a.artrec");
    fireEvent.click(within(row("a.artrec")).getByRole("button", { name: /单次播放/ }));
    fireEvent.click(await screen.findByRole("button", { name: "切换并播放" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("要求鉴权");
    expect(api.netdevProgramOp).not.toHaveBeenCalled();
  });
});

describe("FilesTab 删除与重命名", () => {
  it("删除需二次确认，文案说明无法恢复", async () => {
    api.netdevDeleteFile.mockResolvedValue(undefined);
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.click(within(row("a.artrec")).getByRole("button", { name: /删除/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("无法恢复");
    expect(api.netdevDeleteFile).not.toHaveBeenCalled();
    fireEvent.click(dialogButton("删除"));
    await waitFor(() => expect(api.netdevDeleteFile).toHaveBeenCalledWith("d1", "a.artrec"));
  });

  it("文件正在播放时删除返回 busy，提示先停止播放", async () => {
    api.netdevDeleteFile.mockRejectedValue({ code: "busy", message: "x" });
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.click(within(row("a.artrec")).getByRole("button", { name: /删除/ }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("先停止播放");
  });

  it("重命名：Enter 提交；非法文件名在本地被拦下", async () => {
    api.netdevRenameFile.mockResolvedValue(undefined);
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.click(within(row("a.artrec")).getByRole("button", { name: /重命名/ }));
    const input = screen.getByRole("textbox", { name: "重命名" });

    fireEvent.change(input, { target: { value: "bad.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("文件名须以 .artrec 结尾"));
    expect(api.netdevRenameFile).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "开场.artrec" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.netdevRenameFile).toHaveBeenCalledWith("d1", "a.artrec", "开场.artrec"));
  });

  it("重命名：Esc 取消", async () => {
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.click(within(row("a.artrec")).getByRole("button", { name: /重命名/ }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "重命名" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "重命名" })).toBeNull();
    expect(api.netdevRenameFile).not.toHaveBeenCalled();
  });
});

describe("FilesTab 上传", () => {
  const handle = (result: unknown) => ({ id: "t", promise: Promise.resolve(result), cancel: vi.fn() });

  it("选择文件后顺序上传，并刷新列表", async () => {
    pickers.pickArtrecFiles.mockResolvedValue(["C:\\rec\\one.artrec", "C:\\rec\\two.artrec"]);
    api.netdevUploadFile.mockImplementation((_id: string, name: string) => handle({ name, size: 1, program: 9 }));
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await waitFor(() => expect(api.netdevUploadFile).toHaveBeenCalledTimes(2));
    expect(api.netdevUploadFile.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["one.artrec", "C:\\rec\\one.artrec"],
      ["two.artrec", "C:\\rec\\two.artrec"],
    ]);
    await waitFor(() => expect(api.netdevListFiles.mock.calls.length).toBeGreaterThan(1));
  });

  it("文件名不合规的文件被拦下，不发请求", async () => {
    pickers.pickArtrecFiles.mockResolvedValue(["C:\\rec\\notes.txt"]);
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("notes.txt");
    expect(api.netdevUploadFile).not.toHaveBeenCalled();
  });

  it("同名文件先确认覆盖：取消则不上传，确认才上传", async () => {
    pickers.pickArtrecFiles.mockResolvedValue(["C:\\rec\\A.ARTREC"]);
    api.netdevUploadFile.mockImplementation((_id: string, name: string) => handle({ name, size: 1, program: 1 }));
    renderTab();
    await screen.findByText("a.artrec");

    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("a.artrec");
    fireEvent.click(dialogButton("取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.netdevUploadFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "覆盖并上传" }));
    await waitFor(() => expect(api.netdevUploadFile).toHaveBeenCalledTimes(1));
  });

  it("致命错误（如设备空间不足）中止后续文件", async () => {
    pickers.pickArtrecFiles.mockResolvedValue(["C:\\rec\\one.artrec", "C:\\rec\\two.artrec"]);
    api.netdevUploadFile.mockImplementation(() => ({
      id: "t",
      promise: Promise.reject({ code: "no_space", message: "满" }),
      cancel: vi.fn(),
    }));
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(api.netdevUploadFile).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][0]).toContain("空间不足");
  });
});
