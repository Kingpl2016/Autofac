// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { DEFAULT_DRAFT } from "../../lib/draft";
import type { CheckerContext } from "../../lib/types";
import { renderWithQuery } from "../../__tests__/helpers";
import { useCheckerFormStore } from "../../stores/useCheckerFormStore";
import { DiagnosticHints } from "../DiagnosticHints";

const context = (over: Partial<CheckerContext> = {}): CheckerContext => ({
  appMode: "live",
  receiveInterface: "0.0.0.0",
  multiNic: false,
  forwardingEnabled: 0,
  localIps: ["127.0.0.1", "192.168.1.10"],
  ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useCheckerFormStore.setState({ draft: { ...DEFAULT_DRAFT } });
});

afterEach(() => cleanup());

function backend(ctx: CheckerContext | Error) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd !== "signal_checker_context") return undefined;
    if (ctx instanceof Error) throw ctx;
    return ctx;
  });
}

describe("DiagnosticHints", () => {
  it("自测路径畅通时什么也不显示", async () => {
    backend(context());
    const { container } = renderWithQuery(<DiagnosticHints />);
    await act(async () => undefined);
    expect(container.firstChild).toBeNull();
  });

  it("播放器模式：说明发给本机的信号收不到", async () => {
    backend(context({ appMode: "player" }));
    renderWithQuery(<DiagnosticHints />);
    expect(await screen.findByText(/播放器模式下实时接收已停止/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "提示" })).toBeTruthy();
  });

  it("接收绑定在具体网卡：告诉用户改发哪个 IP", async () => {
    backend(context({ receiveInterface: "192.168.1.10" }));
    renderWithQuery(<DiagnosticHints />);
    expect(
      await screen.findByText(/接收端绑定在 192\.168\.1\.10，收不到发往 127\.0\.0\.1 的信号/),
    ).toBeTruthy();
  });

  it("多网卡模式用不带具体 IP 的说法", async () => {
    backend(context({ multiNic: true }));
    renderWithQuery(<DiagnosticHints />);
    expect(await screen.findByText(/多网卡模式下接收端绑定在各网卡自己的 IP 上/)).toBeTruthy();
  });

  it("转发表有启用的目的地：提醒信号会被转发出去", async () => {
    backend(context({ forwardingEnabled: 2 }));
    renderWithQuery(<DiagnosticHints />);
    expect(await screen.findByText(/转发表里有 2 个启用的目的地，发给本机的测试信号会被转发出去/)).toBeTruthy();
  });

  it("依据草稿里的目标：改成外部设备后提示消失，改回本机又出现", async () => {
    backend(context({ forwardingEnabled: 2 }));
    renderWithQuery(<DiagnosticHints />);
    await screen.findByText(/会被转发出去/);

    act(() => useCheckerFormStore.getState().setDraft({ targetIp: "10.0.0.9" }));
    await waitFor(() => expect(screen.queryByText(/会被转发出去/)).toBeNull());
    act(() => useCheckerFormStore.getState().setDraft({ targetIp: "127.0.0.1" }));
    expect(await screen.findByText(/会被转发出去/)).toBeTruthy();
  });

  it("端口写错（草稿无法转成配置）或取不到环境时不显示", async () => {
    backend(new Error("no backend"));
    const { container } = renderWithQuery(<DiagnosticHints />);
    await act(async () => undefined);
    expect(container.firstChild).toBeNull();

    backend(context({ forwardingEnabled: 2 }));
    act(() => useCheckerFormStore.getState().setDraft({ port: "abc" }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
