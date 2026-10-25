// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

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
import type { CheckerContext, SenderStatus, SignalConfig } from "../../lib/types";
import { DEFAULTS, useCheckerFormStore } from "../../stores/useCheckerFormStore";
import { useGuardStore } from "../../stores/useGuardStore";
import { useSenderStore } from "../../stores/useSenderStore";
import { makePatterns, makeStatus, renderWithQuery } from "../../__tests__/helpers";
import { ConnectionCard } from "../ConnectionCard";

/** 一个可编程的假后端：记录调用顺序，按配置文本决定校验结果。 */
let status: SenderStatus;
let calls: string[];
let configureError: unknown;
let context: CheckerContext | Error;

const defaultContext = (): CheckerContext => ({
  appMode: "live",
  receiveInterface: "0.0.0.0",
  multiNic: false,
  forwardingEnabled: 0,
  localIps: ["127.0.0.1", "192.168.1.10"],
});

function installBackend() {
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    switch (cmd) {
      case "signal_checker_validate": {
        const c = args!.config as SignalConfig;
        if (c.universes === "x") throw { code: "invalidRange", fragment: "x" };
        if (c.universes === "70000") {
          throw { code: "outOfRange", universe: 70000, min: 0, max: 32767 };
        }
        return c.universes === "0-2" ? 3 : 1;
      }
      case "signal_checker_configure":
        if (configureError) throw configureError;
        status = { ...status, config: args!.config as SignalConfig };
        return undefined;
      case "signal_checker_start":
        status = { ...status, running: true };
        return undefined;
      case "signal_checker_stop":
        status = { ...status, running: false };
        return undefined;
      case "signal_checker_status":
        return status;
      case "signal_checker_context":
        if (context instanceof Error) throw context;
        return context;
      case "signal_checker_list_patterns":
        return makePatterns();
      default:
        return undefined;
    }
  });
}

const start = () => screen.getByRole("button", { name: "开始发送" }) as HTMLButtonElement;
const apply = () => screen.getByRole("button", { name: "应用" }) as HTMLButtonElement;
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const setStatus = (s: SenderStatus) => {
  status = s;
  useSenderStore.setState({ status: s });
};

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  calls = [];
  configureError = undefined;
  context = defaultContext();
  status = makeStatus();
  installBackend();
  useCheckerFormStore.setState({ ...DEFAULTS, draft: { ...DEFAULT_DRAFT } });
  useGuardStore.setState({ strobeAcknowledged: false });
  useSenderStore.setState({ status, error: null, preview: null });
});

afterEach(() => cleanup());

describe("ConnectionCard：草稿与校验", () => {
  it("显示默认草稿：本机回环、6454、Art-Net、Universe 0", () => {
    renderWithQuery(<ConnectionCard />);
    expect(input("目标 IP").value).toBe("127.0.0.1");
    expect(input("端口").value).toBe("6454");
    expect(input("Universe 范围").value).toBe("0");
    expect(screen.getByRole("radio", { name: "Art-Net" }).getAttribute("aria-checked")).toBe("true");
  });

  it("切换协议时端口自动换成该协议的默认端口", () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(screen.getByRole("radio", { name: "sACN" }));
    expect(input("端口").value).toBe("5568");
    expect(useCheckerFormStore.getState().draft.protocol).toBe("sacn");
    fireEvent.click(screen.getByRole("radio", { name: "Art-Net" }));
    expect(input("端口").value).toBe("6454");
  });

  it("边输入边向后端校验，通过时显示将发送的 Universe 数量", async () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("Universe 范围"), { target: { value: "0-2" } });
    expect(await screen.findByText("共 3 个 Universe")).toBeTruthy();
  });

  it("后端校验不通过：错误就地显示在对应输入框下，并禁用“开始发送”", async () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("Universe 范围"), { target: { value: "x" } });
    expect(await screen.findByText(/无法识别“x”/)).toBeTruthy();
    expect(input("Universe 范围").getAttribute("aria-invalid")).toBe("true");
    expect(input("目标 IP").getAttribute("aria-invalid")).toBeNull();
    expect(start().disabled).toBe(true);
    // 错误文案与输入框关联，读屏能读到
    const describedBy = input("Universe 范围").getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toContain("无法识别");
  });

  it("越界错误带上协议名和允许的范围", async () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("Universe 范围"), { target: { value: "70000" } });
    expect(
      await screen.findByText("Universe 70000 超出 Art-Net 允许的 0 到 32767"),
    ).toBeTruthy();
  });

  it("端口格式不对时直接提示，不必往返后端", async () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("端口"), { target: { value: "abc" } });
    expect(await screen.findByText("端口须是 1 到 65535 的整数")).toBeTruthy();
    expect(input("端口").getAttribute("aria-invalid")).toBe("true");
    expect(start().disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 300)); // 超过防抖时间
    const validated = invoke.mock.calls.filter(([cmd]) => cmd === "signal_checker_validate");
    expect(validated.every(([, a]) => (a as { config: SignalConfig }).config.port === 6454)).toBe(true);
  });
});

describe("ConnectionCard：开始 / 停止 / 应用", () => {
  it("开始发送：先应用当前草稿再启动，成功后按钮变成“停止发送”", async () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("目标 IP"), { target: { value: " 127.0.0.1 " } });
    fireEvent.click(start());

    expect(await screen.findByRole("button", { name: "停止发送" })).toBeTruthy();
    const order = calls.filter((c) => c === "signal_checker_configure" || c === "signal_checker_start");
    expect(order).toEqual(["signal_checker_configure", "signal_checker_start"]);
    // 发给后端的配置：IP 去掉空白、端口是数字
    const configure = invoke.mock.calls.find(([cmd]) => cmd === "signal_checker_configure")!;
    expect(configure[1]).toEqual({
      config: { targetIp: "127.0.0.1", port: 6454, protocol: "artNet", universes: "0" },
    });
    expect(screen.queryByRole("dialog")).toBeNull(); // 发给本机且没有风险：不打扰
  });

  it("后端拒绝配置时就地提示原因，不会启动", async () => {
    configureError = { code: "tooMany", count: 101, max: 100 };
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(start());
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("一次最多发送 100 个 Universe，当前是 101 个");
    expect(calls).not.toContain("signal_checker_start");
    expect(start().disabled).toBe(false); // 可以改完再试
  });

  it("无法创建套接字时说明原因", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "signal_checker_start") throw { code: "socket", message: "权限不足" };
      return undefined;
    });
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(start());
    expect((await screen.findByRole("alert")).textContent).toBe("无法创建发送套接字：权限不足");
  });

  it("发送中点“停止发送”调用停止", async () => {
    setStatus(makeStatus({ running: true }));
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(screen.getByRole("button", { name: "停止发送" }));
    await waitFor(() => expect(calls).toContain("signal_checker_stop"));
    expect(await screen.findByRole("button", { name: "开始发送" })).toBeTruthy();
  });

  it("“应用”：与生效配置一致时禁用，修改后启用；点击只应用、不启动", async () => {
    setStatus(makeStatus({ running: true }));
    renderWithQuery(<ConnectionCard />);
    expect(apply().disabled).toBe(true);

    fireEvent.change(input("目标 IP"), { target: { value: "10.0.0.2" } });
    await waitFor(() => expect(apply().disabled).toBe(false));
    expect(screen.getByText("发送中修改连接设置后，点“应用”才会生效")).toBeTruthy();

    fireEvent.click(apply());
    await waitFor(() => expect(calls).toContain("signal_checker_configure"));
    expect(calls).not.toContain("signal_checker_start");
    await waitFor(() => expect(apply().disabled).toBe(true)); // 应用后状态刷新，不再有差异
  });

  it("有校验错误时“应用”也禁用", async () => {
    setStatus(makeStatus({ running: true }));
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("Universe 范围"), { target: { value: "x" } });
    await screen.findByText(/无法识别/);
    expect(apply().disabled).toBe(true);
  });

  it("修改草稿会清掉上一次动作的错误提示", async () => {
    configureError = { code: "emptyRange" };
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(start());
    await screen.findByRole("alert");
    fireEvent.change(input("端口"), { target: { value: "6455" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ConnectionCard：发送前确认", () => {
  const confirmButton = () => screen.findByRole("button", { name: "仍然开始发送" });
  const started = () => calls.includes("signal_checker_start");

  it("目标不是本机：先弹确认；取消则什么都不发生", async () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("目标 IP"), { target: { value: "10.0.0.9" } });
    fireEvent.click(start());

    const dialog = await screen.findByRole("dialog", { name: "确认开始发送？" });
    expect(dialog.textContent).toContain("目标 10.0.0.9 不是本机");
    expect(calls).not.toContain("signal_checker_configure");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).not.toContain("signal_checker_configure");
    expect(started()).toBe(false);
  });

  it("确认后才应用配置并启动；每次开始都会再确认（不记住“已确认过这个设备”）", async () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("目标 IP"), { target: { value: "10.0.0.9" } });
    fireEvent.click(start());
    fireEvent.click(await confirmButton());

    expect(await screen.findByRole("button", { name: "停止发送" })).toBeTruthy();
    const order = calls.filter((c) => c === "signal_checker_configure" || c === "signal_checker_start");
    expect(order).toEqual(["signal_checker_configure", "signal_checker_start"]);

    fireEvent.click(screen.getByRole("button", { name: "停止发送" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始发送" }));
    expect(await screen.findByRole("dialog", { name: "确认开始发送？" })).toBeTruthy();
  });

  it("发给本机但转发表有启用的目的地：确认里写明会被转发", async () => {
    context = { ...defaultContext(), forwardingEnabled: 2 };
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(start());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("转发表里有 2 个启用的目的地");
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(started()).toBe(true));
  });

  it("每次都取最新的环境：转发表刚在主窗口里被关掉，就不再为它确认", async () => {
    context = { ...defaultContext(), forwardingEnabled: 2 };
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(start());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    context = defaultContext();
    fireEvent.click(start());
    await waitFor(() => expect(started()).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("频闪：本会话首次开始要确认，确认后再次开始不再提醒", async () => {
    useCheckerFormStore.setState({ pattern: "strobe" });
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(start());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("可能诱发光敏性癫痫");
    fireEvent.click(await confirmButton());
    await screen.findByRole("button", { name: "停止发送" });
    expect(useGuardStore.getState().strobeAcknowledged).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "停止发送" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始发送" }));
    await screen.findByRole("button", { name: "停止发送" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("取消频闪确认不会记住“已确认”", async () => {
    useCheckerFormStore.setState({ pattern: "strobe" });
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(start());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(useGuardStore.getState().strobeAcknowledged).toBe(false);
  });

  it("手动模式不涉及图案，选着频闪也不为它确认", async () => {
    useCheckerFormStore.setState({ pattern: "strobe", mode: "manual" });
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(start());
    await waitFor(() => expect(started()).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("取不到运行环境时保守处理：回环照常开始，其它地址要确认", async () => {
    context = new Error("no backend");
    renderWithQuery(<ConnectionCard />);
    fireEvent.click(start());
    await waitFor(() => expect(started()).toBe(true));

    fireEvent.click(await screen.findByRole("button", { name: "停止发送" }));
    fireEvent.change(input("目标 IP"), { target: { value: "192.168.1.10" } });
    fireEvent.click(await screen.findByRole("button", { name: "开始发送" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("ConnectionCard：空格键开始 / 停止", () => {
  /** 在指定元素上按一次空格（事件会冒泡到 window）。 */
  const space = (target: Element = document.body, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };

  it("焦点不在可交互元素上时，空格开始发送，再按一次停止", async () => {
    renderWithQuery(<ConnectionCard />);
    expect(space().defaultPrevented).toBe(true); // 拦下页面滚动
    await waitFor(() => expect(calls).toContain("signal_checker_start"));
    await screen.findByRole("button", { name: "停止发送" });

    space();
    await waitFor(() => expect(calls).toContain("signal_checker_stop"));
  });

  it("焦点在输入框里时空格就是普通字符，不触发", async () => {
    renderWithQuery(<ConnectionCard />);
    const e = space(input("目标 IP"));
    expect(e.defaultPrevented).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).not.toContain("signal_checker_start");
  });

  it("带修饰键或按住不放的重复事件不触发", async () => {
    renderWithQuery(<ConnectionCard />);
    space(document.body, { ctrlKey: true });
    space(document.body, { shiftKey: true });
    space(document.body, { repeat: true });
    space(document.body); // 这一次才算
    await waitFor(() => expect(calls).toContain("signal_checker_start"));
    expect(calls.filter((c) => c === "signal_checker_start")).toHaveLength(1);
  });

  it("有校验错误时空格不会开始发送", async () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("Universe 范围"), { target: { value: "x" } });
    await screen.findByText(/无法识别/);
    space();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).not.toContain("signal_checker_start");
  });

  it("确认对话框打开时，空格由对话框自己处理，不会再触发一次开始", async () => {
    renderWithQuery(<ConnectionCard />);
    fireEvent.change(input("目标 IP"), { target: { value: "10.0.0.9" } });
    fireEvent.click(start());
    const dialog = await screen.findByRole("dialog");
    space(dialog);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).not.toContain("signal_checker_start");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("开始按钮声明了空格快捷键，并提示给所有人看", () => {
    renderWithQuery(<ConnectionCard />);
    expect(start().getAttribute("aria-keyshortcuts")).toBe("Space");
    expect(screen.getByText("空格键 开始 / 停止")).toBeTruthy();
  });

  it("卸载后不再响应", async () => {
    const { unmount } = renderWithQuery(<ConnectionCard />);
    unmount();
    space();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).not.toContain("signal_checker_start");
  });
});