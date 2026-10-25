// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

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
import { PATTERN_IDS } from "../../lib/types";
import { makePatterns, makeStatus, renderWithQuery } from "../../__tests__/helpers";
import { DEFAULTS, useCheckerFormStore } from "../../stores/useCheckerFormStore";
import { useGuardStore } from "../../stores/useGuardStore";
import { useSenderStore } from "../../stores/useSenderStore";
import { PatternPanel } from "../PatternPanel";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "signal_checker_list_patterns" ? makePatterns() : undefined,
  );
  useCheckerFormStore.setState({ ...DEFAULTS });
  useGuardStore.setState({ strobeAcknowledged: false });
  useSenderStore.setState({ status: makeStatus(), error: null, preview: null });
});

afterEach(() => cleanup());

const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) }) as HTMLInputElement;

describe("PatternPanel：图案选择", () => {
  it("按基础 / 波形 / 扫描 / 压力四组列出 15 种图案", async () => {
    renderWithQuery(<PatternPanel />);
    await screen.findByText("正弦波");
    for (const group of ["基础", "波形", "扫描", "压力"]) {
      expect(screen.getByRole("group", { name: group })).toBeTruthy();
    }
    // 速度档位也是 radio；图案单选组共 15 项
    const patternRadios = screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("name") === "signal-checker-pattern");
    expect(patternRadios).toHaveLength(PATTERN_IDS.length);
    expect(within(screen.getByRole("group", { name: "波形" })).getAllByRole("radio")).toHaveLength(6);
    expect(within(screen.getByRole("group", { name: "压力" })).getAllByRole("radio")).toHaveLength(2);
  });

  it("每张卡片有名称和一句话说明；当前图案被选中", async () => {
    renderWithQuery(<PatternPanel />);
    await screen.findByText("正弦波");
    expect(screen.getByText("平滑起伏，全通道同值，周期 2 秒")).toBeTruthy();
    expect(radio("正弦波").checked).toBe(true);
    expect(radio("方波").checked).toBe(false);
  });

  it("选择图案：更新表单并立即下发后端", async () => {
    renderWithQuery(<PatternPanel />);
    await screen.findByText("追逐");
    fireEvent.click(radio("追逐"));
    expect(useCheckerFormStore.getState().pattern).toBe("chase");
    expect(invoke).toHaveBeenCalledWith("signal_checker_set_pattern", { pattern: "chase" });
    expect(radio("追逐").checked).toBe(true);
  });

  it("只有频闪带“高频闪烁”徽章（文字 + 图标，不只靠颜色）", async () => {
    renderWithQuery(<PatternPanel />);
    await screen.findByText("频闪");
    const badges = screen.getAllByText("高频闪烁");
    expect(badges).toHaveLength(1);
    expect(radio("频闪").closest("label")?.textContent).toContain("高频闪烁");
  });

  it("发送中在标题旁显示“发送中”", async () => {
    useSenderStore.setState({ status: makeStatus({ running: true }) });
    renderWithQuery(<PatternPanel />);
    expect(await screen.findByText("发送中")).toBeTruthy();
  });

  it("切到英文后图案文案跟着变", async () => {
    await i18n.changeLanguage("en");
    renderWithQuery(<PatternPanel />);
    expect(await screen.findByText("Sine wave")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Waves" })).toBeTruthy();
  });
});

describe("PatternPanel：速度", () => {
  const speed = (x: string) => screen.getByRole("radio", { name: x }) as HTMLButtonElement;

  it("提供 0.25× 到 4× 五个档位，默认 1×", async () => {
    renderWithQuery(<PatternPanel />);
    await screen.findByText("正弦波");
    for (const x of ["0.25×", "0.5×", "1×", "2×", "4×"]) expect(speed(x)).toBeTruthy();
    expect(speed("1×").getAttribute("aria-checked")).toBe("true");
  });

  it("选择档位：更新表单并立即下发后端（发送中也一样）", async () => {
    useSenderStore.setState({ status: makeStatus({ running: true }) });
    renderWithQuery(<PatternPanel />);
    await screen.findByText("正弦波");
    fireEvent.click(speed("2×"));
    expect(useCheckerFormStore.getState().speed).toBe(2);
    expect(invoke).toHaveBeenCalledWith("signal_checker_set_speed", { speed: 2 });
  });

  it("静态图案与时间无关：速度档位置灰并说明原因", async () => {
    useCheckerFormStore.setState({ pattern: "gradient" });
    renderWithQuery(<PatternPanel />);
    await screen.findByText("渐变");
    expect(speed("1×").disabled).toBe(true);
    expect(screen.getByText("静态图案与时间无关，速度不起作用")).toBeTruthy();

    fireEvent.click(radio("正弦波"));
    expect(speed("1×").disabled).toBe(false);
    expect(screen.queryByText("静态图案与时间无关，速度不起作用")).toBeNull();
  });
});

describe("PatternPanel：频闪的光敏风险", () => {
  const setPatternCalls = () =>
    invoke.mock.calls.filter(([cmd]) => cmd === "signal_checker_set_pattern").map(([, a]) => a);

  it("没在发送时选频闪：直接选中（确认放在“开始发送”那一步），并持续显示闪烁频率提示", async () => {
    renderWithQuery(<PatternPanel />);
    await screen.findByText("频闪");
    fireEvent.click(radio("频闪"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useCheckerFormStore.getState().pattern).toBe("strobe");
    expect(screen.getByRole("note").textContent).toContain("频闪约每秒闪烁 5 次");
  });

  it("提示里的频率随速度变化", async () => {
    useCheckerFormStore.setState({ pattern: "strobe", speed: 2 });
    renderWithQuery(<PatternPanel />);
    expect((await screen.findByRole("note")).textContent).toContain("约每秒闪烁 10 次");
    fireEvent.click(screen.getByRole("radio", { name: "0.25×" }));
    expect(screen.getByRole("note").textContent).toContain("约每秒闪烁 1.25 次");
  });

  it("其它图案没有这条提示", async () => {
    renderWithQuery(<PatternPanel />);
    await screen.findByText("正弦波");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("发送中想切到频闪（本会话未确认过）：先弹确认，取消则保持原图案", async () => {
    useSenderStore.setState({ status: makeStatus({ running: true }) });
    renderWithQuery(<PatternPanel />);
    await screen.findByText("频闪");
    fireEvent.click(radio("频闪"));

    expect(await screen.findByRole("dialog", { name: "确认切换到频闪？" })).toBeTruthy();
    expect(setPatternCalls()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useCheckerFormStore.getState().pattern).toBe("sine");
    expect(radio("正弦波").checked).toBe(true);
    expect(useGuardStore.getState().strobeAcknowledged).toBe(false);
  });

  it("确认后才切换并下发，同时记住本会话已确认过", async () => {
    useSenderStore.setState({ status: makeStatus({ running: true }) });
    renderWithQuery(<PatternPanel />);
    await screen.findByText("频闪");
    fireEvent.click(radio("频闪"));
    fireEvent.click(await screen.findByRole("button", { name: "仍然切换" }));

    expect(useCheckerFormStore.getState().pattern).toBe("strobe");
    expect(setPatternCalls()).toEqual([{ pattern: "strobe" }]);
    expect(useGuardStore.getState().strobeAcknowledged).toBe(true);

    // 之后再切回别的图案、再切到频闪，不再询问
    fireEvent.click(radio("正弦波"));
    fireEvent.click(radio("频闪"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useCheckerFormStore.getState().pattern).toBe("strobe");
  });

  it("切到非闪烁图案，发送中也不打扰", async () => {
    useSenderStore.setState({ status: makeStatus({ running: true }) });
    renderWithQuery(<PatternPanel />);
    await screen.findByText("追逐");
    fireEvent.click(radio("追逐"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useCheckerFormStore.getState().pattern).toBe("chase");
  });
});