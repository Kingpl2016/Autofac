// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";

const win = vi.hoisted(() => ({ setTitle: vi.fn() }));
const invoke = vi.hoisted(() => vi.fn());
const bus = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("../../__tests__/helpers").createEventBus> }));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("@/shared/tauri/events", () => ({
  onEvent: (name: string, cb: (p: unknown) => void) => bus.current!.onEvent(name, cb),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/features/settings", () => ({
  useSettingsQuery: () => ({ data: { display: { valueFormat: "decimal" } } }),
}));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { DEFAULT_DRAFT } from "../../lib/draft";
import {
  createEventBus,
  makeFrame,
  makePatterns,
  makeStatus,
  renderWithQuery,
} from "../../__tests__/helpers";
import { useCheckerFormStore } from "../../stores/useCheckerFormStore";
import { useSenderStore } from "../../stores/useSenderStore";
import { SignalCheckerRoot } from "../SignalCheckerRoot";
import { SignalCheckerView } from "../SignalCheckerView";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  // 根组件会把 i18n 同步到偏好里的语言，测试环境的默认偏好取自 navigator.language，这里固定为中文
  usePrefsStore.setState({ language: "zh" });
  vi.clearAllMocks();
  bus.current = createEventBus();
  win.setTitle.mockResolvedValue(undefined);
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "signal_checker_status") return makeStatus();
    if (cmd === "signal_checker_validate") return 1;
    if (cmd === "signal_checker_list_patterns") return makePatterns();
    if (cmd === "signal_checker_frame") return makeFrame();
    return undefined;
  });
  useCheckerFormStore.setState({ draft: { ...DEFAULT_DRAFT } });
  useSenderStore.setState({ status: null, error: null, preview: null });
});

afterEach(() => cleanup());

describe("SignalCheckerView", () => {
  it("组装顶栏、连接区与底栏，并把原生窗口标题设为本地化文案", async () => {
    renderWithQuery(<SignalCheckerView />);
    expect(screen.getByRole("heading", { level: 1, name: "信号检测器" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "连接" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始发送" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "自动模式", selected: true })).toBeTruthy();
    expect(await screen.findByText("正弦波")).toBeTruthy();
    await waitFor(() => expect(win.setTitle).toHaveBeenCalledWith("信号检测器"));
    expect(document.title).toBe("信号检测器");
  });

  it("切换语言后标题跟着变", async () => {
    await i18n.changeLanguage("en");
    renderWithQuery(<SignalCheckerView />);
    expect(screen.getByRole("heading", { level: 1, name: "Signal Checker" })).toBeTruthy();
    await waitFor(() => expect(win.setTitle).toHaveBeenCalledWith("Signal Checker"));
  });

  it("设置原生标题失败（或不在 Tauri 里）时不影响渲染", async () => {
    win.setTitle.mockRejectedValue(new Error("no window"));
    renderWithQuery(<SignalCheckerView />);
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    await waitFor(() => expect(win.setTitle).toHaveBeenCalled());
  });

  it("订阅后端事件：状态推送更新顶栏，错误推送显示错误条", async () => {
    renderWithQuery(<SignalCheckerView />);
    await waitFor(() => expect(bus.current!.has("signal-checker:status")).toBe(true));
    expect(bus.current!.has("signal-checker:error")).toBe(true);
    expect(bus.current!.has("signal-checker:preview")).toBe(true);

    act(() =>
      bus.current!.emit(
        "signal-checker:status",
        makeStatus({ running: true, packetsSent: 88, measuredHz: 44, universeCount: 4 }),
      ),
    );
    // 顶栏和图案面板各有一个“发送中”状态
    await waitFor(() => expect(screen.getAllByText("发送中").length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText("88 包")).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止发送" })).toBeTruthy();

    act(() => bus.current!.emit("signal-checker:error", { universe: 2, message: "网络不可达" }));
    expect((await screen.findByRole("alert")).textContent).toContain("网络不可达");
  });

  it("窗口打开时取一次初始状态；底栏显示生效配置", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "signal_checker_status"
        ? makeStatus({
            config: { targetIp: "10.0.0.9", port: 5568, protocol: "sacn", universes: "1-4" },
          })
        : undefined,
    );
    renderWithQuery(<SignalCheckerView />);
    expect(await screen.findByText("sACN → 10.0.0.9:5568")).toBeTruthy();
    expect(screen.getByText(/^Uni 1-4 · 图案：正弦波$/)).toBeTruthy();
  });

  it("卸载时取消订阅", async () => {
    const { unmount } = renderWithQuery(<SignalCheckerView />);
    await waitFor(() => expect(bus.current!.has("signal-checker:status")).toBe(true));
    unmount();
    await waitFor(() => expect(bus.current!.has("signal-checker:status")).toBe(false));
  });

  it("根组件带一个状态播报区，开始 / 停止时读屏软件会朗读", async () => {
    renderWithQuery(<SignalCheckerRoot />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");

    await waitFor(() => expect(bus.current!.has("signal-checker:status")).toBe(true));
    act(() => bus.current!.emit("signal-checker:status", makeStatus({ running: false })));
    act(() => bus.current!.emit("signal-checker:status", makeStatus({ running: true })));
    await waitFor(() => expect(region.textContent).toContain("已开始发送：Art-Net → 127.0.0.1:6454"));
    act(() => bus.current!.emit("signal-checker:status", makeStatus({ running: false })));
    await waitFor(() => expect(region.textContent).toContain("已停止发送"));
  });

  it("页面有顶栏 / 主体 / 底栏三个地标，标题可被程序聚焦", () => {
    renderWithQuery(<SignalCheckerView />);
    // 面板内的 <header> 在测试库里也被当作 banner（浏览器只认页面级的那一个），所以取第一个
    const banner = screen.getAllByRole("banner")[0];
    expect(within(banner).getByRole("heading", { level: 1 }).tabIndex).toBe(-1);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
  });
});