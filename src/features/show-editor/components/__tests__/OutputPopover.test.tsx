// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => null));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import type { ShowState } from "../../lib/playbackApi";
import { createEmptyProject } from "../../lib/project";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { OutputPopover } from "../OutputPopover";

/** 后端播放状态。 */
const showState = (over: Partial<ShowState> = {}): ShowState => ({
  loaded: true,
  transport: "stopped",
  positionMs: 0,
  durationMs: 1000,
  looping: false,
  locate: null,
  universes: [],
  warnings: [],
  outputting: false,
  outputEnabled: true,
  sending: false,
  destinations: 2,
  dropped: 0,
  ...over,
});

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  invoke.mockImplementation(async () => null);
  toast.error.mockReset();
  useProjectStore.getState().load(createEmptyProject("t"));
  usePlaybackStore.getState().reset();
  await act(async () => {
    await useEditorPrefsStore.setState({ outputAdvancedOpen: false });
  });
});

afterEach(() => cleanup());

const renderPopover = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OutputPopover />
    </QueryClientProvider>,
  );

const open = () => fireEvent.click(screen.getByRole("button", { name: "输出设置" }));

describe("输出设置：基本与高级", () => {
  it("高级默认收起；收起时列出改过默认值的项；展开状态会记住", () => {
    act(() => useProjectStore.getState().update((d) => void (d.output.latencyCompMs = 40)));
    renderPopover();
    open();
    const trigger = screen.getByRole("button", { name: /高级/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("延迟补偿 40 ms");
    expect(screen.queryByLabelText("Gamma 数值")).toBeNull();

    fireEvent.click(trigger);
    expect(useEditorPrefsStore.getState().outputAdvancedOpen).toBe(true);
    expect(screen.getByRole("switch", { name: "ArtSync" })).toBeTruthy();
    cleanup();
    renderPopover();
    open();
    expect(screen.getByRole("button", { name: /高级/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("Gamma 校正默认关闭（1.0）；打开取 2.2 并显示数值，关闭回到 1.0", () => {
    act(() => void useEditorPrefsStore.getState().setOutputAdvancedOpen(true));
    renderPopover();
    open();
    expect(useProjectStore.getState().project.output.gamma).toBe(1);
    const toggle = screen.getByRole("switch", { name: "Gamma 校正" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByLabelText("Gamma 数值")).toBeNull();

    fireEvent.click(toggle);
    expect(useProjectStore.getState().project.output.gamma).toBe(2.2);
    expect(screen.getByLabelText("Gamma 数值")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Gamma 校正" }));
    expect(useProjectStore.getState().project.output.gamma).toBe(1);
    expect(screen.queryByLabelText("Gamma 数值")).toBeNull();
  });

  it("收起时：Gamma 打开才列入改过的项", () => {
    act(() => useProjectStore.getState().update((d) => void (d.output.gamma = 2)));
    renderPopover();
    open();
    expect(screen.getByRole("button", { name: /高级/ }).textContent).toContain("Gamma 2.0");
  });

  it("通道锁定：添加、改值、解除，都是可撤销的编辑", () => {
    act(() => void useEditorPrefsStore.getState().setOutputAdvancedOpen(true));
    renderPopover();
    open();
    fireEvent.change(screen.getByLabelText("锁定的 Universe"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("锁定的通道"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("锁定的值（0~255）"), { target: { value: "128" } });
    fireEvent.click(screen.getByRole("button", { name: "锁定" }));
    expect(useProjectStore.getState().project.output.park).toEqual([{ universe: 1, channel: 20, value: 128 }]);

    fireEvent.change(screen.getByLabelText("锁定的值（0~255）"), { target: { value: "999" } });
    fireEvent.click(screen.getByRole("button", { name: "锁定" }));
    expect(useProjectStore.getState().project.output.park).toEqual([{ universe: 1, channel: 20, value: 255 }]);

    const list = screen.getByRole("list", { name: "已锁定的通道" });
    fireEvent.click(within(list).getByRole("button", { name: "解除 U1.20 的锁定" }));
    expect(useProjectStore.getState().project.output.park).toEqual([]);
    act(() => useProjectStore.temporal.getState().undo());
    expect(useProjectStore.getState().project.output.park).toHaveLength(1);
  });
});

describe("输出到网络开关", () => {
  beforeEach(() => useProjectStore.getState().load({ ...createEmptyProject("t"), output: { ...createEmptyProject("t").output, target: { kind: "forwarding" } } }));

  it("默认开启；关闭后工具条显示“仅预览”并提示只在本机预览", async () => {
    act(() => usePlaybackStore.getState().setState(showState({ transport: "playing", outputting: true, sending: true })));
    invoke.mockImplementation(async (cmd: unknown, args: unknown) =>
      cmd === "show_set_output_enabled"
        ? showState({ transport: "playing", outputting: true, outputEnabled: (args as { enabled: boolean }).enabled, sending: false })
        : null,
    );
    renderPopover();
    expect(screen.getByRole("img", { name: "正在输出灯光" })).toBeTruthy();
    open();
    const toggle = screen.getByRole("switch", { name: "输出到网络" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/正在发送 · 转发表 · 2 个目的地/)).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "输出到网络" }).getAttribute("aria-checked")).toBe("false"));
    expect(invoke).toHaveBeenCalledWith("show_set_output_enabled", { enabled: false });
    expect(screen.getByText("已关闭：只在本机预览，不向网络发送灯光数据。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "输出设置" }).textContent).toContain("仅预览");
  });

  it("录制进行中打开失败：提示原因，开关保持关闭", async () => {
    act(() => usePlaybackStore.getState().setState(showState({ transport: "playing", outputting: true, outputEnabled: false })));
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "show_set_output_enabled") throw "recording_active";
      return null;
    });
    renderPopover();
    open();
    fireEvent.click(screen.getByRole("switch", { name: "输出到网络" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(toast.error.mock.calls[0][0])).toContain("录制进行中");
    expect(screen.getByRole("switch", { name: "输出到网络" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("发送到", () => {
  beforeEach(() => useProjectStore.getState().load({ ...createEmptyProject("t"), output: { ...createEmptyProject("t").output, target: { kind: "forwarding" } } }));
  const radio = (name: string) => screen.getByRole("radio", { name });
  const target = () => useProjectStore.getState().project.output.target;

  it("转发表 / 按路由表直接切换；可撤销", () => {
    renderPopover();
    open();
    expect(radio("转发表").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("按路由表"));
    expect(target()).toEqual({ kind: "routed" });
    expect(screen.getByText(/当前按工程的 Universe 路由表输出/)).toBeTruthy();
    fireEvent.click(radio("转发表"));
    expect(target()).toEqual({ kind: "forwarding" });
    act(() => useProjectStore.temporal.getState().undo());
    expect(target()).toEqual({ kind: "routed" });
  });

  it("指定设备：填好 IP 回车才生效；不合法的 IP 不写入并提示", () => {
    renderPopover();
    open();
    fireEvent.click(radio("指定设备"));
    expect(target()).toEqual({ kind: "forwarding" });
    expect(radio("指定设备").getAttribute("aria-checked")).toBe("true");

    const ip = screen.getByLabelText("IP 地址");
    fireEvent.change(ip, { target: { value: "0.0.0.0" } });
    fireEvent.blur(ip);
    expect(screen.getByRole("alert").textContent).toContain("0.0.0.0 不能作为发送目标");
    expect(target()).toEqual({ kind: "forwarding" });

    fireEvent.change(ip, { target: { value: "192.168.1.9" } });
    fireEvent.keyDown(ip, { key: "Enter" });
    fireEvent.blur(ip);
    expect(target()).toEqual({ kind: "direct", ip: "192.168.1.9", protocol: "artNet", port: 6454 });

    const port = screen.getByLabelText("端口");
    fireEvent.change(port, { target: { value: "7000" } });
    fireEvent.blur(port);
    expect(target()).toMatchObject({ kind: "direct", port: 7000 });
  });
});
