// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import type { ColorValue } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useRecentColorsStore } from "../../stores/useRecentColorsStore";
import { ColorPicker } from "../ColorPicker";

beforeAll(() => {
  loadTestEngine();
  HTMLElement.prototype.setPointerCapture = () => undefined;
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useRecentColorsStore.setState({ colors: [] });
});

afterEach(() => cleanup());

function setup(value: ColorValue | undefined = { kind: "rgb", rgb: [255, 0, 0] }) {
  const onCommit = vi.fn();
  const view = render(<ColorPicker value={value} onCommit={onCommit} target={{ model: RGBW }} gamma={1} />);
  return { onCommit, ...view };
}

describe("ColorPicker", () => {
  it("色轮用方向键调色相；十六进制输入；点常用色提交并记入最近使用", () => {
    const { onCommit } = setup();
    const wheel = screen.getByRole("slider", { name: /色轮/ });
    expect(wheel.getAttribute("aria-valuetext")).toBe("色相 0°，饱和度 100%");
    fireEvent.keyDown(wheel, { key: "ArrowRight", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "rgb", rgb: [255, 64, 0] });

    const hex = screen.getByRole("textbox", { name: "十六进制" });
    fireEvent.change(hex, { target: { value: "#00ff00" } });
    fireEvent.blur(hex);
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "rgb", rgb: [0, 255, 0] });

    fireEvent.click(screen.getByRole("button", { name: "日光 5600K" }));
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "kelvin", kelvin: 5600 });
    expect(useRecentColorsStore.getState().colors[0]).toEqual({ kind: "kelvin", kelvin: 5600 });
  });

  it("白光策略写进颜色值（默认保色不写）", () => {
    const { onCommit } = setup();
    fireEvent.click(screen.getByRole("radio", { name: "增亮" }));
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "rgb", rgb: [255, 0, 0], white: "boost" });
  });

  it("切换到色温 / 发光体模式提交换算后的颜色；发光体推子按目标灯具的发光体列出", () => {
    const { onCommit, rerender } = setup();
    fireEvent.click(screen.getByRole("radio", { name: "色温" }));
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "kelvin", kelvin: 3200 });

    rerender(<ColorPicker value={{ kind: "kelvin", kelvin: 3200 }} onCommit={onCommit} target={{ model: RGBW }} gamma={1} />);
    fireEvent.click(screen.getByRole("button", { name: "6500K" }));
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "kelvin", kelvin: 6500 });

    rerender(<ColorPicker value={{ kind: "manual", values: { red: 1 } }} onCommit={onCommit} target={{ model: RGBW }} gamma={1} />);
    const sliders = screen.getAllByRole("slider", { name: /输出$/ });
    expect(sliders).toHaveLength(4);
    fireEvent.change(sliders[3], { target: { value: "40" } });
    fireEvent.keyUp(sliders[3]);
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "manual", values: { red: 1, white: 0.4 } });
  });

  it("实际输出：引擎模拟目标灯具各发光体的输出", () => {
    setup({ kind: "rgb", rgb: [255, 255, 255] });
    const meters = within(screen.getByLabelText("实际输出")).getAllByRole("meter");
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual(["0", "0", "0", "100"]);
  });
});
