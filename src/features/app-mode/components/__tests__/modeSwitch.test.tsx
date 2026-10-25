// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}));
const api = vi.hoisted(() => ({
  appModeSet: vi.fn(),
  appModeGet: vi.fn(),
  stopRecordingForModeChange: vi.fn(),
}));
const announcer = vi.hoisted(() => ({ announce: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/stores/announcerStore", () => announcer);
vi.mock("../../lib/api", () => api);

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useAppModeStore } from "../../stores/useAppModeStore";
import { useModeDialogStore } from "../../stores/useModeDialogStore";
import { ModeConfirmDialog } from "../ModeConfirmDialog";
import { ModeSwitch } from "../ModeSwitch";

function Probe() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

function renderSwitch(initial = "/forwarding") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <ModeSwitch />
      <ModeConfirmDialog />
      <Probe />
    </MemoryRouter>,
  );
}

const path = () => screen.getByTestId("path").textContent;
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLButtonElement;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useEngineStatusStore.setState({
    appMode: "live",
    receivers: "bound",
    sender: "ready",
    recording: false,
    playing: false,
    packetRate: 0,
  });
  useEngineDataStore.setState({ universes: [], devices: [] });
  useAppModeStore.setState({ transitioning: false });
  useModeDialogStore.setState({ request: null });
  api.appModeSet.mockResolvedValue({ mode: "player", receivers: "suspended", sender: "ready" });
  api.stopRecordingForModeChange.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("ModeSwitch", () => {
  it("是带名称的 radiogroup，当前模式被选中，只有当前项在 Tab 序列里", () => {
    renderSwitch();
    expect(screen.getByRole("radiogroup", { name: "运行模式" })).toBeTruthy();
    expect(radio("实时").getAttribute("aria-checked")).toBe("true");
    expect(radio("播放器").getAttribute("aria-checked")).toBe("false");
    expect([radio("实时").tabIndex, radio("播放器").tabIndex]).toEqual([0, -1]);
  });

  it("键盘：方向键只移动焦点，不会触发切换；点击 / Enter 才打开确认", () => {
    renderSwitch();
    radio("实时").focus();
    fireEvent.keyDown(radio("实时"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(radio("播放器"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.appModeSet).not.toHaveBeenCalled();

    fireEvent.click(radio("播放器"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(api.appModeSet).not.toHaveBeenCalled();
  });

  it("进入播放器模式一律先确认：正文写明后果，默认聚焦“取消”", async () => {
    useEngineDataStore.setState({
      universes: [
        { universe: 1, protocol: "artNet", sourceIps: [], sourceCount: 0, activeChannels: 1, conflictChannels: 0, totalPackets: 1 },
        { universe: 2, protocol: "artNet", sourceIps: [], sourceCount: 0, activeChannels: 1, conflictChannels: 0, totalPackets: 1 },
      ],
      devices: [],
    });
    useEngineStatusStore.setState({ packetRate: 88 });
    renderSwitch();

    fireEvent.click(radio("播放器"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("进入播放器模式？");
    expect(dialog.textContent).toContain("当前正在接收 2 个 Universe（88 包/秒），这些实时信号会被清空。");
    expect(dialog.textContent).toContain("释放 Art-Net / sACN 接收端口");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" })));
  });

  it("取消或按 Esc 都不会切换", async () => {
    renderSwitch();
    fireEvent.click(radio("播放器"));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(radio("播放器"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.appModeSet).not.toHaveBeenCalled();
  });

  it("确认后切换到播放器模式：跳转到播放器页、提示并向读屏播报", async () => {
    renderSwitch("/forwarding");
    fireEvent.click(radio("播放器"));
    fireEvent.click(await screen.findByRole("button", { name: "进入播放器模式" }));

    await waitFor(() => expect(api.appModeSet).toHaveBeenCalledWith("player"));
    await waitFor(() => expect(path()).toBe("/player"));
    expect(toast.success).toHaveBeenCalledWith("已进入播放器模式");
    expect(announcer.announce).toHaveBeenCalledWith("已进入播放器模式");
    expect(useAppModeStore.getState().transitioning).toBe(false);
  });

  it("已在播放器模式时点“播放器”：不再确认、不调用后端，直接回到播放器页", () => {
    useEngineStatusStore.setState({ appMode: "player", receivers: "suspended" });
    renderSwitch("/forwarding");

    expect(radio("播放器").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("播放器"));
    expect(path()).toBe("/player");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.appModeSet).not.toHaveBeenCalled();
  });

  it("录制中：对话框说明会先停止并保存，确认后先停录制再切换", async () => {
    useEngineStatusStore.setState({ recording: true });
    const order: string[] = [];
    api.stopRecordingForModeChange.mockImplementation(async () => void order.push("stop"));
    api.appModeSet.mockImplementation(async () => {
      order.push("set");
      return { mode: "player", receivers: "suspended", sender: "ready" };
    });
    renderSwitch();

    fireEvent.click(radio("播放器"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("正在进行的录制会先停止并保存。");
    // 停止并保存录制不是销毁数据：主按钮用默认（主色）而不是危险色
    const confirm = screen.getByRole("button", { name: "停止录制并进入" });
    expect(confirm.className).not.toContain("destructive");
    fireEvent.click(confirm);
    await waitFor(() => expect(order).toEqual(["stop", "set"]));
  });

  it("忙碌时整组禁用并声明 aria-busy，结束后恢复", async () => {
    let resolve!: (v: unknown) => void;
    api.appModeSet.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSwitch();
    fireEvent.click(radio("播放器"));
    fireEvent.click(await screen.findByRole("button", { name: "进入播放器模式" }));

    await waitFor(() => expect(screen.getByRole("radiogroup").getAttribute("aria-busy")).toBe("true"));
    expect(radio("实时").disabled && radio("播放器").disabled).toBe(true);

    await act(async () => resolve({ mode: "player", receivers: "suspended", sender: "ready" }));
    await waitFor(() => expect(screen.getByRole("radiogroup").getAttribute("aria-busy")).toBeNull());
    expect(radio("实时").disabled).toBe(false);
  });

  it("失败时给出可读错误，且不跳转", async () => {
    api.appModeSet.mockRejectedValue(new Error("recording_active"));
    renderSwitch("/forwarding");
    fireEvent.click(radio("播放器"));
    fireEvent.click(await screen.findByRole("button", { name: "进入播放器模式" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("录制进行中，请先停止录制再切换。"));
    expect(path()).toBe("/forwarding");
    expect(useAppModeStore.getState().transitioning).toBe(false);
  });

  it("退出播放器模式：没有在播放就直接切回，不弹确认；在播放器页会回到仪表盘", async () => {
    useEngineStatusStore.setState({ appMode: "player", receivers: "suspended" });
    api.appModeSet.mockResolvedValue({ mode: "live", receivers: "bound", sender: "ready" });
    renderSwitch("/player");

    fireEvent.click(radio("实时"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(api.appModeSet).toHaveBeenCalledWith("live"));
    await waitFor(() => expect(path()).toBe("/"));
    expect(announcer.announce).toHaveBeenCalledWith("已回到实时模式");
  });

  it("退出播放器模式：正在播放时需确认，说明会停止输出并关闭节目", async () => {
    useEngineStatusStore.setState({ appMode: "player", receivers: "suspended", playing: true });
    api.appModeSet.mockResolvedValue({ mode: "live", receivers: "bound", sender: "ready" });
    renderSwitch("/forwarding");

    fireEvent.click(radio("实时"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("退出播放器模式？");
    expect(dialog.textContent).toContain("停止输出、关闭节目");
    expect(api.appModeSet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "退出播放器模式" }));
    await waitFor(() => expect(api.appModeSet).toHaveBeenCalledWith("live"));
    // 不在播放器页时留在原页面
    expect(path()).toBe("/forwarding");
  });

  it("接收重建失败：显示“接收未绑定”和重试，重试走幂等的切换到实时模式", async () => {
    useEngineStatusStore.setState({ appMode: "live", receivers: "failed" });
    api.appModeSet.mockResolvedValue({ mode: "live", receivers: "bound", sender: "ready" });
    renderSwitch();

    expect(screen.getByText("接收未绑定")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.appModeSet).toHaveBeenCalledWith("live"));
  });

  it("切换进行中再次请求会被忽略", async () => {
    let resolve!: (v: unknown) => void;
    api.appModeSet.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSwitch();
    fireEvent.click(radio("播放器"));
    fireEvent.click(await screen.findByRole("button", { name: "进入播放器模式" }));
    await waitFor(() => expect(useAppModeStore.getState().transitioning).toBe(true));

    // 此时模拟另一个入口再次请求
    useModeDialogStore.getState().open({ target: "player" });
    await act(async () => resolve({ mode: "player", receivers: "suspended", sender: "ready" }));
    expect(api.appModeSet).toHaveBeenCalledTimes(1);
  });
});
