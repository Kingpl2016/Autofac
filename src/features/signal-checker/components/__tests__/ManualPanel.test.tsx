// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
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
import { makeFrame, makeStatus, renderWithQuery } from "../../__tests__/helpers";
import { DEFAULTS, useCheckerFormStore } from "../../stores/useCheckerFormStore";
import { useSenderStore } from "../../stores/useSenderStore";
import { ManualPanel } from "../ManualPanel";

/** 假后端：手动数据存在内存里，读回帧时反映最近的写入。 */
let manual: Record<number, number>;
let writeError: unknown;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  manual = {};
  writeError = undefined;
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "signal_checker_set_channel":
        if (writeError) throw writeError;
        manual[(args!.channel as number) - 1] = args!.value as number;
        return undefined;
      case "signal_checker_set_all":
        for (let i = 0; i < 512; i += 1) manual[i] = args!.value as number;
        return undefined;
      case "signal_checker_clear":
        manual = {};
        return undefined;
      case "signal_checker_frame":
        return makeFrame(manual);
      default:
        return undefined;
    }
  });
  useCheckerFormStore.setState({ ...DEFAULTS, mode: "manual" });
  useSenderStore.setState({ status: makeStatus({ mode: "manual", universes: [0, 1] }), error: null, preview: null });
});

afterEach(() => cleanup());

const channel = () => screen.getByLabelText("通道（1-512）") as HTMLInputElement;
const value = () => screen.getByLabelText("数值（0-255）") as HTMLInputElement;
const cell = (ch: number) => document.querySelector<HTMLElement>(`[data-ch="${ch}"]`)!;
const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

describe("ManualPanel：输入与校验", () => {
  it("默认通道 1、数值 255，按钮写明将要设置的内容", async () => {
    renderWithQuery(<ManualPanel />);
    expect(channel().value).toBe("1");
    expect(value().value).toBe("255");
    expect(screen.getByRole("button", { name: "设置 ch1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "整个 Universe 设为 255" })).toBeTruthy();
    expect(screen.getByText("约 100%")).toBeTruthy();
  });

  it.each(["0", "513", "abc", "", "1.5", "-1"])("通道 %j 不合法：标为无效，设置按钮置灰", (bad) => {
    renderWithQuery(<ManualPanel />);
    fireEvent.change(channel(), { target: { value: bad } });
    expect(channel().getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "设置 ch?" }) as HTMLButtonElement).disabled).toBe(true);
    // 数值合法时，整个 Universe 仍可设置
    expect((screen.getByRole("button", { name: /整个 Universe 设为/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["256", "300", "x", ""])("数值 %j 不合法：两个写入按钮都置灰", (bad) => {
    renderWithQuery(<ManualPanel />);
    fireEvent.change(value(), { target: { value: bad } });
    expect(value().getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: /^设置 ch/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /整个 Universe 设为/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("清空输入框重新输入时不会被强行改回 1", () => {
    renderWithQuery(<ManualPanel />);
    fireEvent.change(channel(), { target: { value: "" } });
    expect(channel().value).toBe("");
    fireEvent.change(channel(), { target: { value: "42" } });
    expect(channel().value).toBe("42");
  });

  it("快捷值与滑块都会改数值，快捷值用 aria-pressed 标明当前选中", () => {
    renderWithQuery(<ManualPanel />);
    fireEvent.click(screen.getByRole("button", { name: "128" }));
    expect(value().value).toBe("128");
    expect(screen.getByRole("button", { name: "128" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "255" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("约 50%")).toBeTruthy();

    fireEvent.change(screen.getByRole("slider", { name: "数值滑块" }), { target: { value: "64" } });
    expect(value().value).toBe("64");
  });
});

describe("ManualPanel：写入与读回", () => {
  it("设置单个通道：下发 1 起始的通道号，并立刻在栅格里读回", async () => {
    renderWithQuery(<ManualPanel />);
    fireEvent.change(channel(), { target: { value: "10" } });
    fireEvent.change(value(), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "设置 ch10" }));

    await waitFor(() => expect(cell(10).textContent).toBe("200"));
    expect(calls("signal_checker_set_channel")).toEqual([{ universe: 0, channel: 10, value: 200 }]);
    expect(cell(11).textContent).toBe("");
  });

  it("整个 Universe 设为同一个值", async () => {
    renderWithQuery(<ManualPanel />);
    fireEvent.change(value(), { target: { value: "77" } });
    fireEvent.click(screen.getByRole("button", { name: "整个 Universe 设为 77" }));
    await waitFor(() => expect(cell(512).textContent).toBe("77"));
    expect(calls("signal_checker_set_all")).toEqual([{ universe: 0, value: 77 }]);
  });

  it("清除此 Universe 只清当前这一个；清除全部传 null", async () => {
    renderWithQuery(<ManualPanel />);
    fireEvent.click(screen.getByRole("button", { name: /整个 Universe 设为/ }));
    await waitFor(() => expect(cell(1).textContent).toBe("255"));

    fireEvent.click(screen.getByRole("button", { name: "清除此 Universe" }));
    await waitFor(() => expect(cell(1).textContent).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "清除全部" }));
    await waitFor(() => expect(calls("signal_checker_clear")).toHaveLength(2));
    expect(calls("signal_checker_clear")).toEqual([{ universe: 0 }, { universe: null }]);
  });

  it("切换 Universe 后，写入目标跟着变", async () => {
    renderWithQuery(<ManualPanel />);
    fireEvent.change(screen.getByLabelText("Universe"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "设置 ch1" }));
    await waitFor(() => expect(calls("signal_checker_set_channel")).toHaveLength(1));
    expect(calls("signal_checker_set_channel")[0]).toMatchObject({ universe: 1 });
  });

  it("点击栅格里的色块选中通道，并高亮", () => {
    renderWithQuery(<ManualPanel />);
    fireEvent.click(cell(42));
    expect(channel().value).toBe("42");
    expect(cell(42).dataset.selected).toBe("true");
    expect(screen.getByRole("button", { name: "设置 ch42" })).toBeTruthy();
  });

  it("后端拒绝时就地提示，且之后的成功操作会清掉提示", async () => {
    writeError = { code: "channelOutOfRange", channel: 600 };
    renderWithQuery(<ManualPanel />);
    fireEvent.click(screen.getByRole("button", { name: "设置 ch1" }));
    expect((await screen.findByRole("alert")).textContent).toBe("通道号 600 超出 1 到 512");

    writeError = undefined;
    fireEvent.click(screen.getByRole("button", { name: "设置 ch1" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("让后端只推送所选 Universe 的预览", async () => {
    renderWithQuery(<ManualPanel />);
    await waitFor(() => expect(calls("signal_checker_set_preview")).toEqual([{ universe: 0 }]));
  });
});
