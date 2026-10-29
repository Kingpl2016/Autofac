// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import type { ColorValue } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useColorInputStore } from "../../stores/useColorInputStore";
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

  it("彩色 → 色温 → 彩色：回到原来的彩色，而不是色温换算出的近白色", () => {
    const { onCommit, rerender } = setup({ kind: "rgb", rgb: [255, 0, 0] });
    fireEvent.click(screen.getByRole("radio", { name: "色温" }));
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "kelvin", kelvin: 3200 });
    rerender(<ColorPicker value={{ kind: "kelvin", kelvin: 3200 }} onCommit={onCommit} target={{ model: RGBW }} gamma={1} />);
    fireEvent.click(screen.getByRole("button", { name: "5600K" }));
    rerender(<ColorPicker value={{ kind: "kelvin", kelvin: 5600 }} onCommit={onCommit} target={{ model: RGBW }} gamma={1} />);
    fireEvent.click(screen.getByRole("radio", { name: "彩色" }));
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "rgb", rgb: [255, 0, 0] });
    // 再切回色温：回到上次的 5600K
    rerender(<ColorPicker value={{ kind: "rgb", rgb: [255, 0, 0] }} onCommit={onCommit} target={{ model: RGBW }} gamma={1} />);
    fireEvent.click(screen.getByRole("radio", { name: "色温" }));
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "kelvin", kelvin: 5600 });
  });

  it("隐藏灯具不支持的方式与常用色；当前值的方式不支持时仍显示并提示", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <ColorPicker value={{ kind: "kelvin", kelvin: 3200 }} onCommit={onCommit} gamma={1} modes={["kelvin"]} />,
    );
    expect(screen.getAllByRole("radio", { name: /^(彩色|色温|发光体)$/ }).map((r) => r.textContent)).toEqual(["色温"]);
    expect(screen.queryByRole("button", { name: "红" })).toBeNull();
    expect(screen.getByRole("button", { name: "日光 5600K" })).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();

    rerender(<ColorPicker value={{ kind: "kelvin", kelvin: 3200 }} onCommit={onCommit} gamma={1} modes={["rgb"]} />);
    expect(screen.getAllByRole("radio", { name: /^(彩色|色温|发光体)$/ }).map((r) => r.textContent)).toEqual(["彩色", "色温"]);
    expect(screen.getByRole("note").textContent).toContain("不支持“色温”");
    expect(screen.queryByRole("button", { name: "日光 5600K" })).toBeNull();
  });

  it("实际输出：引擎模拟目标灯具各发光体的输出", () => {
    setup({ kind: "rgb", rgb: [255, 255, 255] });
    const meters = within(screen.getByLabelText("实际输出")).getAllByRole("meter");
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual(["0", "0", "0", "100"]);
  });
});

describe("ColorPicker 输入方式", () => {
  beforeEach(() => useColorInputStore.setState({ input: "wheel" }));

  it("色轮（HSV）旁直接显示 H / S / V；S 输入 0 变灰、再输入 100 回到原色（色相保留）；V 滑杆与数值框提交", () => {
    const { onCommit, rerender } = setup({ kind: "rgb", rgb: [0, 0, 255] });
    expect(screen.getByRole("radio", { name: "色轮（HSV）" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: "HSL" })).toBeNull();
    const hsv = screen.getByRole("group", { name: "HSV 数值" });
    const field = (name: string) => within(hsv).getByRole("textbox", { name });
    expect((field("色相 H（°）") as HTMLInputElement).value).toBe("240");
    expect((field("饱和度 S（%）") as HTMLInputElement).value).toBe("100");
    expect((field("明度 V（%）") as HTMLInputElement).value).toBe("100");

    fireEvent.change(field("饱和度 S（%）"), { target: { value: "0" } });
    fireEvent.blur(field("饱和度 S（%）"));
    const gray = onCommit.mock.lastCall?.[0] as ColorValue;
    expect(gray).toEqual({ kind: "rgb", rgb: [255, 255, 255] });
    rerender(<ColorPicker value={gray} onCommit={onCommit} target={{ model: RGBW }} gamma={1} />);
    // 白色本身没有色相，但数值仍停在 240°
    expect((field("色相 H（°）") as HTMLInputElement).value).toBe("240");
    fireEvent.change(field("饱和度 S（%）"), { target: { value: "100" } });
    fireEvent.blur(field("饱和度 S（%）"));
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "rgb", rgb: [0, 0, 255] });

    rerender(<ColorPicker value={{ kind: "rgb", rgb: [0, 0, 255] }} onCommit={onCommit} target={{ model: RGBW }} gamma={1} />);
    fireEvent.change(field("明度 V（%）"), { target: { value: "50" } });
    fireEvent.blur(field("明度 V（%）"));
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "rgb", rgb: [0, 0, 128] });
    const v = screen.getByRole("slider", { name: "颜色明度（V）" });
    expect(v.getAttribute("title") ?? v.closest("label")?.getAttribute("title")).toContain("整体亮度请用强度");
  });

  it("颜色方式改名为“彩色 / 色温 / 发光体”，各有悬停说明；旧设置里的 HSL 方式读回为色轮", async () => {
    setup();
    const rgb = screen.getByRole("radio", { name: "彩色" });
    expect(rgb.getAttribute("title") ?? rgb.closest("[title]")?.getAttribute("title")).toContain("自动混色");
    expect(screen.getByRole("img", { name: /^目标颜色 #ff0000/ })).toBeTruthy();
    await useColorInputStore.persist.rehydrate();
    expect(useColorInputStore.getState().input).toBe("wheel");
    const merged = useColorInputStore.persist.getOptions().merge?.({ input: "hsl" }, useColorInputStore.getState());
    expect((merged as { input: string }).input).toBe("wheel");
  });

  it("RGB 数值：通道滑杆与数值框", () => {
    useColorInputStore.setState({ input: "rgb" });
    const { onCommit } = setup({ kind: "rgb", rgb: [10, 20, 30] });
    expect(screen.queryByRole("slider", { name: /色轮/ })).toBeNull();
    const green = screen.getByRole("slider", { name: "绿" });
    expect(green.getAttribute("aria-valuetext")).toBe("20");
    const blue = screen.getByRole("textbox", { name: "蓝数值" });
    fireEvent.change(blue, { target: { value: "300" } });
    fireEvent.blur(blue);
    expect(onCommit).toHaveBeenLastCalledWith({ kind: "rgb", rgb: [10, 20, 255] });
  });
});
