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
import { makeFrame, makePatterns, makeStatus, renderWithQuery } from "../../__tests__/helpers";
import { DEFAULTS, useCheckerFormStore } from "../../stores/useCheckerFormStore";
import { useSenderStore } from "../../stores/useSenderStore";
import { ModeSection } from "../ModeSection";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "signal_checker_list_patterns") return makePatterns();
    if (cmd === "signal_checker_frame") return makeFrame();
    return undefined;
  });
  useCheckerFormStore.setState({ ...DEFAULTS });
  useSenderStore.setState({ status: makeStatus(), error: null, preview: null });
});

afterEach(() => cleanup());

/** Radix 标签在 mousedown 时激活，`click` 不会触发。 */
const pickTab = (name: string) => fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
const previewCalls = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "signal_checker_set_preview").map(([, a]) => a);

describe("ModeSection", () => {
  it("默认是自动模式：显示图案和发送预览，不显示手动设值", async () => {
    renderWithQuery(<ModeSection />);
    expect(screen.getByRole("tab", { name: "自动模式", selected: true })).toBeTruthy();
    expect(await screen.findByText("测试图案")).toBeTruthy();
    expect(screen.getByText("发送预览")).toBeTruthy();
    expect(screen.queryByText("手动设值")).toBeNull();
  });

  it("切到手动模式：更新表单、立即下发后端，并换成手动设值面板", async () => {
    renderWithQuery(<ModeSection />);
    pickTab("手动模式");
    expect(useCheckerFormStore.getState().mode).toBe("manual");
    expect(invoke).toHaveBeenCalledWith("signal_checker_set_mode", { mode: "manual" });
    expect(await screen.findByText("手动设值")).toBeTruthy();
    expect(screen.queryByText("测试图案")).toBeNull();
  });

  it("切回自动模式同样下发", async () => {
    useCheckerFormStore.setState({ mode: "manual" });
    renderWithQuery(<ModeSection />);
    pickTab("自动模式");
    expect(invoke).toHaveBeenCalledWith("signal_checker_set_mode", { mode: "auto" });
    expect(await screen.findByText("测试图案")).toBeTruthy();
  });

  it("离开的面板会关掉它的预览推送，新面板再打开自己的", async () => {
    renderWithQuery(<ModeSection />);
    await waitFor(() => expect(previewCalls()).toEqual([{ universe: 0 }]));
    pickTab("手动模式");
    await waitFor(() => expect(previewCalls()).toEqual([{ universe: 0 }, { universe: null }, { universe: 0 }]));
  });

  it("标签组有可访问名称", () => {
    renderWithQuery(<ModeSection />);
    expect(screen.getByRole("tablist", { name: "发送模式" })).toBeTruthy();
  });
});
