// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/shared/i18n";

// Radix Switch / Select 依赖 ResizeObserver，jsdom 没有
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
  netdevSetWorkmode: vi.fn(),
  netdevProgramOp: vi.fn(),
  netdevBoardOp: vi.fn(),
  netdevPutConfig: vi.fn(),
  netdevGetConfig: vi.fn(),
  netdevPlayer: vi.fn(),
  netdevSeek: vi.fn(),
  netdevSpeed: vi.fn(),
  netdevListFiles: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<typeof import("../../lib/api")>()), ...api }));

import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import type { DeviceConfig, DeviceStatus, NetDevice } from "../../lib/types";
import { BoardOpsPanel } from "../commands/BoardOpsPanel";
import { ConfigPanel } from "../commands/ConfigPanel";
import { PlayerPanel } from "../commands/PlayerPanel";
import { ProgramPanel } from "../commands/ProgramPanel";
import { WorkModePanel } from "../commands/WorkModePanel";

const device: NetDevice = { id: "d1", name: "主舞台", host: "10.0.0.2", port: 80, hasToken: true };

function accessWith(workMode = 4, canWrite = true): DeviceAccess {
  const status = { workMode, version: "1.4.2" } as DeviceStatus;
  return {
    state: canWrite ? "ok" : "offline",
    canRead: true,
    canWrite,
    status: { status, online: true, error: null, isLoading: false, refetch: vi.fn() },
    tokenSet: true,
    markRebooting: vi.fn(),
  };
}

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

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

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.netdevGetConfig.mockResolvedValue(config);
  api.netdevListFiles.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe("WorkModePanel", () => {
  it("显示当前模式及说明；方向键只移动焦点，Enter 才应用", async () => {
    api.netdevSetWorkmode.mockResolvedValue(undefined);
    wrap(<WorkModePanel device={device} access={accessWith(4)} />);
    const current = screen.getByRole("radio", { name: "节目", checked: true });
    expect(screen.getByText(/节目：停止转发/)).toBeTruthy();

    fireEvent.keyDown(current, { key: "ArrowLeft" });
    expect(api.netdevSetWorkmode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "Art-Net 转发" }));
    await waitFor(() => expect(api.netdevSetWorkmode).toHaveBeenCalledWith("d1", 1));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("已切换到“Art-Net 转发”"));
  });

  it("失败时提示原因", async () => {
    api.netdevSetWorkmode.mockRejectedValue({ code: "unauthorized", message: "x" });
    wrap(<WorkModePanel device={device} access={accessWith(4)} />);
    fireEvent.click(screen.getByRole("radio", { name: "场景" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("只读时整组不可操作", () => {
    wrap(<WorkModePanel device={device} access={accessWith(4, false)} />);
    expect((screen.getByRole("radio", { name: "场景" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ProgramPanel", () => {
  it("节目号越界时禁用按钮并提示", async () => {
    wrap(<ProgramPanel device={device} access={accessWith(4)} />);
    const input = screen.getByLabelText("节目号");
    fireEvent.change(input, { target: { value: "300" } });
    fireEvent.blur(input);
    expect(await screen.findByText("节目号必须是 1 到 255 的整数")).toBeTruthy();
    expect((screen.getByRole("button", { name: "单次播放" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("发送动作码：停止 0 / 暂停 1 / 单次 2 / 循环 3", async () => {
    api.netdevProgramOp.mockResolvedValue(undefined);
    wrap(<ProgramPanel device={device} access={accessWith(4)} />);
    fireEvent.change(screen.getByLabelText("节目号"), { target: { value: "7" } });
    for (const [name, action] of [
      ["停止", 0],
      ["暂停", 1],
      ["单次播放", 2],
      ["循环播放", 3],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(api.netdevProgramOp).toHaveBeenCalledWith("d1", 7, action));
    }
  });

  it("非节目模式：播放类按钮禁用并说明，删除不受影响", () => {
    wrap(<ProgramPanel device={device} access={accessWith(1)} />);
    expect(screen.getByText(/播放类操作被设备拒绝/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "单次播放" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "删除节目文件" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("删除节目文件要二次确认，文案说明会删文件", async () => {
    api.netdevProgramOp.mockResolvedValue(undefined);
    wrap(<ProgramPanel device={device} access={accessWith(1)} />);
    fireEvent.click(screen.getByRole("button", { name: "删除节目文件" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("删除设备 SD 卡上该节目对应的文件");
    expect(api.netdevProgramOp).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.netdevProgramOp).toHaveBeenCalledWith("d1", 1, 4));
  });
});

describe("BoardOpsPanel", () => {
  it("自检直接执行", async () => {
    api.netdevBoardOp.mockResolvedValue(undefined);
    wrap(<BoardOpsPanel device={device} access={accessWith()} />);
    fireEvent.click(screen.getByRole("button", { name: "自检" }));
    await waitFor(() => expect(api.netdevBoardOp).toHaveBeenCalledWith("d1", 2));
  });

  it("复位要确认，确认后进入重启跟踪", async () => {
    api.netdevBoardOp.mockResolvedValue(undefined);
    const access = accessWith();
    wrap(<BoardOpsPanel device={device} access={access} />);
    fireEvent.click(screen.getByRole("button", { name: "复位" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.netdevBoardOp).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "复位" }));
    await waitFor(() => expect(api.netdevBoardOp).toHaveBeenCalledWith("d1", 0));
    await waitFor(() => expect(access.markRebooting).toHaveBeenCalled());
  });

  it("恢复出厂必须输入设备名才能确认", async () => {
    api.netdevBoardOp.mockResolvedValue(undefined);
    const access = accessWith();
    wrap(<BoardOpsPanel device={device} access={access} />);
    fireEvent.click(screen.getAllByRole("button", { name: "恢复出厂设置" })[0]);
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "恢复出厂设置" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/输入设备名/), { target: { value: "别的名字" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/输入设备名/), { target: { value: "主舞台" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(api.netdevBoardOp).toHaveBeenCalledWith("d1", 1));
    expect(access.markRebooting).toHaveBeenCalled();
  });

  it("只读时全部禁用", () => {
    wrap(<BoardOpsPanel device={device} access={accessWith(4, false)} />);
    for (const b of screen.getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PlayerPanel", () => {
  const player = (over = {}) => ({
    state: 2,
    programNo: 1,
    repeat: 1,
    speedX100: 100,
    posMs: 30_000,
    durMs: 120_000,
    universes: 4,
    frames: 1234,
    badFrames: 0,
    ...over,
  });

  it("显示状态、时间码与帧统计，并用文件名代替节目号", async () => {
    api.netdevPlayer.mockResolvedValue(player());
    api.netdevListFiles.mockResolvedValue([{ name: "开场秀.artrec", size: 1, isDir: false, program: 1 }]);
    wrap(<PlayerPanel device={device} access={accessWith()} />);
    expect(await screen.findByText("0:30 / 2:00")).toBeTruthy();
    expect(screen.getByText("播放中")).toBeTruthy();
    expect(await screen.findByText("开场秀.artrec")).toBeTruthy();
    expect(screen.getByText("1,234")).toBeTruthy();
  });

  it("拖动进度条松手才提交 seek", async () => {
    api.netdevPlayer.mockResolvedValue(player());
    api.netdevSeek.mockResolvedValue(undefined);
    wrap(<PlayerPanel device={device} access={accessWith()} />);
    const bar = await screen.findByRole("slider", { name: "播放位置" });
    fireEvent.change(bar, { target: { value: "90000" } });
    fireEvent.change(bar, { target: { value: "95000" } });
    expect(api.netdevSeek).not.toHaveBeenCalled();
    fireEvent.pointerUp(bar);
    await waitFor(() => expect(api.netdevSeek).toHaveBeenCalledTimes(1));
    expect(api.netdevSeek).toHaveBeenCalledWith("d1", 95_000);
  });

  it("选择倍速", async () => {
    api.netdevPlayer.mockResolvedValue(player());
    api.netdevSpeed.mockResolvedValue(undefined);
    wrap(<PlayerPanel device={device} access={accessWith()} />);
    await screen.findByRole("slider", { name: "播放位置" });
    fireEvent.click(screen.getByRole("radio", { name: "1.5×" }));
    await waitFor(() => expect(api.netdevSpeed).toHaveBeenCalledWith("d1", 150));
  });

  it("坏帧大于 0 时提示", async () => {
    api.netdevPlayer.mockResolvedValue(player({ badFrames: 3 }));
    wrap(<PlayerPanel device={device} access={accessWith()} />);
    expect(await screen.findByText(/有迟到帧/)).toBeTruthy();
  });

  it("没有加载节目时禁用进度条与控制", async () => {
    api.netdevPlayer.mockResolvedValue(player({ state: 0, programNo: 0, durMs: 0, posMs: 0 }));
    wrap(<PlayerPanel device={device} access={accessWith()} />);
    const bar = (await screen.findByRole("slider", { name: "播放位置" })) as HTMLInputElement;
    expect(bar.disabled).toBe(true);
    expect(screen.getByText("尚未加载节目")).toBeTruthy();
  });
});

describe("ConfigPanel", () => {
  it("没有改动时保存按钮禁用；只提交改动字段", async () => {
    api.netdevPutConfig.mockResolvedValue({ ok: true, netRebootRequired: false });
    wrap(<ConfigPanel device={device} access={accessWith()} />);
    const save = (await screen.findByRole("button", { name: "保存更改" })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("sACN 优先级"), { target: { value: "150" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(api.netdevPutConfig).toHaveBeenCalledWith("d1", { sacnPriority: 150 }));
    expect(screen.queryByText(/需要重启设备后才会生效/)).toBeNull();
  });

  it("校验失败：显示可聚焦的错误摘要，不发请求", async () => {
    wrap(<ConfigPanel device={device} access={accessWith()} />);
    await screen.findByRole("button", { name: "保存更改" });
    fireEvent.change(screen.getByLabelText("sACN 优先级"), { target: { value: "999" } });
    fireEvent.change(screen.getByLabelText("主机名"), { target: { value: "a.b" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    const summary = await screen.findByText("有 2 项需要修正");
    expect(summary).toBeTruthy();
    expect(screen.getAllByText("必须是 0 到 200 的整数").length).toBeGreaterThan(0);
    expect(api.netdevPutConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /主机名：/ }));
    expect(document.activeElement?.id).toBe("cfg-hostname");
  });

  it("改网络字段后显示需重启横幅，立即重启要确认", async () => {
    api.netdevPutConfig.mockResolvedValue({ ok: true, netRebootRequired: true });
    api.netdevBoardOp.mockResolvedValue(undefined);
    const access = accessWith();
    wrap(<ConfigPanel device={device} access={access} />);
    await screen.findByRole("button", { name: "保存更改" });
    fireEvent.change(screen.getByLabelText("主机名"), { target: { value: "new-name" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    expect(await screen.findByText("网络设置已保存，需要重启设备后才会生效。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "立即重启" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "复位" }));
    await waitFor(() => expect(api.netdevBoardOp).toHaveBeenCalledWith("d1", 0));
    await waitFor(() => expect(access.markRebooting).toHaveBeenCalled());
  });

  it("关闭 DHCP 后静态地址才可编辑，并校验 IP", async () => {
    wrap(<ConfigPanel device={device} access={accessWith()} />);
    await screen.findByRole("button", { name: "保存更改" });
    expect((screen.getByLabelText("静态 IP") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "使用 DHCP" }));
    const ip = screen.getByLabelText("静态 IP") as HTMLInputElement;
    expect(ip.disabled).toBe(false);
    fireEvent.change(ip, { target: { value: "0.0.0.0" } });
    fireEvent.blur(ip);
    expect(await screen.findByText("关闭 DHCP 时 IP 不能是 0.0.0.0")).toBeTruthy();
  });

  it("Token：设置走 httpToken 补丁；清除要先确认", async () => {
    api.netdevPutConfig.mockResolvedValue({ ok: true, netRebootRequired: false });
    wrap(<ConfigPanel device={device} access={accessWith()} />);
    const input = await screen.findByLabelText("更换 Token");
    fireEvent.change(input, { target: { value: "newtoken99" } });
    fireEvent.click(screen.getByRole("button", { name: "更换" }));
    await waitFor(() => expect(api.netdevPutConfig).toHaveBeenCalledWith("d1", { httpToken: "newtoken99" }));

    fireEvent.click(screen.getByRole("button", { name: "清除 Token" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("不再需要 Token");
    fireEvent.click(within(dialog).getByRole("button", { name: "清除 Token" }));
    await waitFor(() => expect(api.netdevPutConfig).toHaveBeenCalledWith("d1", { httpToken: "" }));
  });
});
