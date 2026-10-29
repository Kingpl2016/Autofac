// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { stubResizeObserver } from "@/test/mockTauriEvents";
import { renderWithProviders } from "@/test/renderWithProviders";

// 行内“⋯”菜单（Radix Popper）依赖 ResizeObserver，jsdom 没有
stubResizeObserver();

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({
  netdevListFiles: vi.fn(),
  netdevDeleteFile: vi.fn(),
  netdevRenameFile: vi.fn(),
  netdevAssignPrograms: vi.fn(),
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
    markRebooting: vi.fn(),
    ...rest,
  };
}

function renderTab(access: DeviceAccess = accessWith()) {
  return renderWithProviders(<FilesTab device={device} access={access} />);
}

const row = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
const dialogButton = (name: string) => within(screen.getByRole("dialog")).getByRole("button", { name });
/** 打开某一行的“⋯”菜单（Radix 菜单在 jsdom 里用键盘打开最稳）。 */
const openMenu = (name: string) =>
  fireEvent.keyDown(within(row(name)).getByRole("button", { name: `更多操作: ${name}` }), { key: "Enter" });
/** 菜单项（名称里带着快捷键提示，所以按前缀匹配）。 */
const menuItem = (label: string) => screen.getByRole("menuitem", { name: new RegExp(`^${label}`) });

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
    const names = screen.getAllByRole("row").map((li) => li.textContent ?? "");
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

  it("不可写：上传 / 重命名 / 删除 / 播放全部禁用，下载仍可用", async () => {
    renderTab(accessWith({ state: "offline", canWrite: false }));
    await screen.findByText("a.artrec");
    expect((screen.getByRole("button", { name: "上传文件" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("设备当前不可写，无法上传")).toBeTruthy();
    const r = within(row("a.artrec"));
    expect((r.getByRole("button", { name: /单次播放/ }) as HTMLButtonElement).disabled).toBe(true);
    openMenu("a.artrec");
    expect(menuItem("重命名").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("删除").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("循环播放").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("下载").getAttribute("aria-disabled")).toBeNull();
  });

  it("没有节目号的文件不能播放，并在行内说明原因", async () => {
    renderTab();
    await screen.findByText("new.artrec");
    const play = within(row("new.artrec")).getByRole("button", { name: /单次播放/ }) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    const hint = document.getElementById(play.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("未分配节目号");
  });

  it("每行只有一个主按钮和一个“⋯”菜单；删除在分隔线之后", async () => {
    renderTab();
    await screen.findByText("a.artrec");
    const buttons = within(row("a.artrec"))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(buttons).toEqual(["拖动排序: a.artrec", "修改节目号: a.artrec", "单次播放: a.artrec", "更多操作: a.artrec"]);
    openMenu("a.artrec");
    const menu = screen.getByRole("menu");
    const children = Array.from(menu.children).map((el) => el.getAttribute("role"));
    expect(children.at(-2)).toBe("separator");
    expect(menu.lastElementChild?.textContent).toMatch(/^删除/);
  });

  it("筛选：只显示匹配的文件，并停用拖动排序", async () => {
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.change(screen.getByRole("searchbox", { name: "筛选文件名" }), { target: { value: "B." } });
    expect(screen.queryByText("a.artrec")).toBeNull();
    expect(screen.getByText("b.artrec")).toBeTruthy();
    expect((within(row("b.artrec")).getByRole("button", { name: /拖动排序/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("显示 1 / 3 个文件")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "筛选文件名" }), { target: { value: "zzz" } });
    expect(screen.getByText("没有匹配的文件")).toBeTruthy();
  });

  it("行内快捷键：F2 重命名、Delete 删除（先确认）", async () => {
    renderTab();
    await screen.findByText("a.artrec");
    const play = within(row("a.artrec")).getByRole("button", { name: /单次播放/ });
    fireEvent.keyDown(play, { key: "F2" });
    expect(screen.getByRole("textbox", { name: "重命名" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "重命名" }), { key: "Escape" });

    fireEvent.keyDown(within(row("b.artrec")).getByRole("button", { name: /单次播放/ }), { key: "Delete" });
    expect((await screen.findByRole("dialog")).textContent).toContain("b.artrec");
    expect(api.netdevDeleteFile).not.toHaveBeenCalled();
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
    openMenu("b.artrec");
    fireEvent.click(menuItem("循环播放"));
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
    openMenu("a.artrec");
    fireEvent.click(menuItem("删除"));
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
    openMenu("a.artrec");
    fireEvent.click(menuItem("删除"));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("先停止播放");
  });

  it("重命名：Enter 提交；非法文件名在本地被拦下", async () => {
    api.netdevRenameFile.mockResolvedValue(undefined);
    renderTab();
    await screen.findByText("a.artrec");
    openMenu("a.artrec");
    fireEvent.click(menuItem("重命名"));
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
    openMenu("a.artrec");
    fireEvent.click(menuItem("重命名"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "重命名" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "重命名" })).toBeNull();
    expect(api.netdevRenameFile).not.toHaveBeenCalled();
  });
});

describe("FilesTab 修改节目号与拖动手柄", () => {
  const openEditor = (name: string) =>
    fireEvent.click(within(row(name)).getByRole("button", { name: new RegExp(`修改节目号: ${name}`) }));
  const editorInput = () => screen.getByRole("spinbutton", { name: "节目号" }) as HTMLInputElement;

  it("只有有节目号的文件有拖动手柄；没有节目号的排在后面且不能拖", async () => {
    renderTab();
    await screen.findByText("a.artrec");
    expect(within(row("a.artrec")).getByRole("button", { name: /拖动排序: a.artrec/ })).toBeTruthy();
    expect(within(row("b.artrec")).getByRole("button", { name: /拖动排序: b.artrec/ })).toBeTruthy();
    expect(within(row("new.artrec")).queryByRole("button", { name: /拖动排序/ })).toBeNull();
  });

  it("不可写时手柄和节目号都不能操作", async () => {
    renderTab(accessWith({ state: "offline", canWrite: false }));
    await screen.findByText("a.artrec");
    const handle = within(row("a.artrec")).getByRole("button", { name: /拖动排序/ }) as HTMLButtonElement;
    expect(handle.disabled).toBe(true);
    expect(within(row("a.artrec")).queryByRole("button", { name: /修改节目号/ })).toBeNull();
  });

  it("目标号空闲：只暂存，不发请求；点“提交更改”才提交一条分配", async () => {
    api.netdevAssignPrograms.mockResolvedValue(undefined);
    renderTab();
    await screen.findByText("a.artrec");
    openEditor("a.artrec");
    fireEvent.change(editorInput(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    // 列表立刻显示新号并标记待提交，但设备还没收到任何请求
    expect(await within(row("a.artrec")).findByText("#7")).toBeTruthy();
    expect(within(row("a.artrec")).getByText("待提交")).toBeTruthy();
    expect(screen.getByRole("region", { name: /1 个文件的节目号有未提交的更改/ })).toBeTruthy();
    expect(api.netdevAssignPrograms).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "提交更改" }));
    await waitFor(() =>
      expect(api.netdevAssignPrograms).toHaveBeenCalledWith("d1", [{ no: 7, file: "a.artrec" }]),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("已提交 1 个文件的节目号更改"));
    await waitFor(() => expect(screen.queryByRole("region", { name: /未提交的更改/ })).toBeNull());
  });

  it("目标号被占用：写明将与对方互换，确认后暂存两条分配，提交时一次发出", async () => {
    api.netdevAssignPrograms.mockResolvedValue(undefined);
    renderTab();
    await screen.findByText("a.artrec");
    openEditor("a.artrec");
    fireEvent.change(editorInput(), { target: { value: "2" } });
    expect(await screen.findByText(/#2 已被“b.artrec”使用，确认后两个文件互换节目号/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "互换" }));
    expect(api.netdevAssignPrograms).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "提交更改" }));
    await waitFor(() => expect(api.netdevAssignPrograms).toHaveBeenCalledTimes(1));
    // 原子批量重排与顺序无关，只要这两条一起发出
    const sent = api.netdevAssignPrograms.mock.calls[0][1] as Array<{ no: number; file: string }>;
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(
      expect.arrayContaining([
        { no: 2, file: "a.artrec" },
        { no: 1, file: "b.artrec" },
      ]),
    );
  });

  it("多次修改合并成一次提交；暂存的文件在提交前不能播放", async () => {
    api.netdevAssignPrograms.mockResolvedValue(undefined);
    renderTab();
    await screen.findByText("a.artrec");
    openEditor("a.artrec");
    fireEvent.change(editorInput(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await within(row("a.artrec")).findByText("#7");
    openEditor("new.artrec");
    fireEvent.change(editorInput(), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await within(row("new.artrec")).findByText("#9");

    expect(screen.getByRole("region", { name: /2 个文件的节目号有未提交的更改/ })).toBeTruthy();
    expect((within(row("a.artrec")).getByRole("button", { name: /单次播放/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.netdevAssignPrograms).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "提交更改" }));
    await waitFor(() => expect(api.netdevAssignPrograms).toHaveBeenCalledTimes(1));
    expect(api.netdevAssignPrograms).toHaveBeenCalledWith("d1", [
      { no: 7, file: "a.artrec" },
      { no: 9, file: "new.artrec" },
    ]);
  });

  it("放弃更改：恢复设备上的节目号，不发请求", async () => {
    renderTab();
    await screen.findByText("a.artrec");
    openEditor("a.artrec");
    fireEvent.change(editorInput(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await within(row("a.artrec")).findByText("#7");

    fireEvent.click(screen.getByRole("button", { name: "放弃更改" }));
    expect(within(row("a.artrec")).getByText("#1")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /未提交的更改/ })).toBeNull();
    expect(api.netdevAssignPrograms).not.toHaveBeenCalled();
  });

  it("没有节目号的文件不能抢别人的号；不合法的号也不能提交", async () => {
    renderTab();
    await screen.findByText("new.artrec");
    openEditor("new.artrec");
    // 预填最小空闲号 3
    expect(editorInput().value).toBe("3");
    fireEvent.change(editorInput(), { target: { value: "1" } });
    expect((await screen.findByRole("alert")).textContent).toContain("#1 已被“a.artrec”使用");
    expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(editorInput(), { target: { value: "300" } });
    expect((await screen.findByRole("alert")).textContent).toContain("1~255");
    expect((screen.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.netdevAssignPrograms).not.toHaveBeenCalled();
  });

  it("正在播放的节目不能改号（含被它占用的号）", async () => {
    renderTab(accessWith({ status: { player: { state: 2, programNo: 1, posMs: 0, durMs: 0 } } }));
    await screen.findByText("a.artrec");
    openEditor("b.artrec");
    fireEvent.change(editorInput(), { target: { value: "1" } });
    expect((await screen.findByRole("alert")).textContent).toContain("正在播放的节目 #1");
    expect((screen.getByRole("button", { name: "互换" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.netdevAssignPrograms).not.toHaveBeenCalled();
  });

  it("设备提交失败：提示原因，暂存的更改保留以便重试", async () => {
    api.netdevAssignPrograms.mockRejectedValue({ code: "busy", message: "x" });
    renderTab();
    await screen.findByText("a.artrec");
    openEditor("a.artrec");
    fireEvent.change(editorInput(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await within(row("a.artrec")).findByText("#7");
    fireEvent.click(screen.getByRole("button", { name: "提交更改" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // 草稿还在：号码仍是暂存值，提示条仍在
    await waitFor(() => expect(screen.getByRole("region", { name: /未提交的更改/ })).toBeTruthy());
    expect(within(row("a.artrec")).getByText("#7")).toBeTruthy();

    api.netdevAssignPrograms.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "提交更改" }));
    await waitFor(() => expect(api.netdevAssignPrograms).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("region", { name: /未提交的更改/ })).toBeNull());
  });
});

describe("FilesTab 上传", () => {
  const handle = (result: unknown) => ({ id: "t", promise: Promise.resolve(result), cancel: vi.fn() });

  it("选择文件后顺序上传，并刷新列表", async () => {
    pickers.pickArtrecFiles.mockResolvedValue(["C:\\rec\\one.artrec", "C:\\rec\\two.artrec"]);
    api.netdevUploadFile.mockImplementation((_id: string, name: string) => handle({ name, size: 1, program: 9 }));
    renderTab();
    await screen.findByText("a.artrec");
    fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
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
    fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("notes.txt");
    expect(api.netdevUploadFile).not.toHaveBeenCalled();
  });

  it("同名文件先确认覆盖：取消则不上传，确认才上传", async () => {
    pickers.pickArtrecFiles.mockResolvedValue(["C:\\rec\\A.ARTREC"]);
    api.netdevUploadFile.mockImplementation((_id: string, name: string) => handle({ name, size: 1, program: 1 }));
    renderTab();
    await screen.findByText("a.artrec");

    fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("a.artrec");
    fireEvent.click(dialogButton("取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.netdevUploadFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
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
    fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(api.netdevUploadFile).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][0]).toContain("空间不足");
  });
});
