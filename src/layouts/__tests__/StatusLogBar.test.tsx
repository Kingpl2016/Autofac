// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useLogStore } from "@/shared/stores/logStore";
import { StatusLogBar } from "../StatusLogBar";

const append = (level: "info" | "warn" | "error", message: string) =>
  act(() => useLogStore.getState().append(level, message));

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useLogStore.getState().clear();
  useEngineStatusStore.setState({ packetRate: 44, uptimeSec: 3725 });
});
afterEach(() => cleanup());

describe("StatusLogBar", () => {
  it("运行时长在包速率右侧，用人话显示，悬停给出精确值；还没有数据时不显示", () => {
    useEngineStatusStore.setState({ uptimeSec: 12_420 });
    const { rerender } = render(<StatusLogBar />);
    const rate = screen.getByText(/包速率/);
    expect(rate.textContent).toContain("44");
    const uptime = screen.getByText("已运行 3 小时 27 分");
    expect(uptime.getAttribute("title")).toBe("引擎已运行 3:27:00");
    // 同一组里紧跟在包速率后面
    expect(rate.nextElementSibling).toBe(uptime);

    act(() => useEngineStatusStore.setState({ uptimeSec: 42 }));
    rerender(<StatusLogBar />);
    expect(screen.getByText("已运行 42 秒")).toBeTruthy();

    act(() => useEngineStatusStore.setState({ uptimeSec: 0 }));
    rerender(<StatusLogBar />);
    expect(screen.queryByText(/已运行/)).toBeNull();
  });

  it("“清空”在“包速率”左边（同一组），无日志时禁用，点击清空", () => {
    render(<StatusLogBar />);
    const clear = screen.getByRole("button", { name: "清空" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);

    append("info", "引擎已启动");
    append("error", "端口被占用");
    expect(clear.disabled).toBe(false);

    const rate = screen.getByText(/包速率/);
    expect(clear.parentElement).toBe(rate.parentElement);
    expect(clear.nextElementSibling).toBe(rate);

    fireEvent.click(clear);
    expect(useLogStore.getState().entries).toHaveLength(0);
  });

  it("展开后最新的日志在最上面，带级别标签；空时给出提示", () => {
    render(<StatusLogBar />);
    fireEvent.click(screen.getByRole("button", { name: /系统日志/ }));
    expect(screen.getByText("暂无日志")).toBeTruthy();

    append("info", "第一条");
    append("warn", "第二条");
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("第二条");
    expect(items[0].textContent?.toLowerCase()).toContain("warn");
    expect(items[1].textContent).toContain("第一条");
  });

  describe("拖动拉伸日志面板", () => {
    const open = () => fireEvent.click(screen.getByRole("button", { name: /系统日志/ }));
    const handle = () => screen.getByRole("separator");
    const panelHeight = () => (handle().nextElementSibling as HTMLElement).style.height;

    beforeEach(() => {
      Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
      Element.prototype.setPointerCapture = vi.fn();
    });

    it("折叠时没有把手；展开后把手在面板上方，带当前高度", () => {
      render(<StatusLogBar />);
      expect(screen.queryByRole("separator")).toBeNull();
      open();
      expect(handle().getAttribute("aria-valuenow")).toBe("176");
      expect(panelHeight()).toBe("176px");
    });

    it("向上拖变高，向下拖变矮，并限制在最小值与窗口 70% 之间", () => {
      render(<StatusLogBar />);
      open();
      fireEvent.pointerDown(handle(), { pointerId: 1, clientY: 600 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 500 });
      expect(panelHeight()).toBe("276px");
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 0 });
      expect(panelHeight()).toBe("700px"); // 1000 * 0.7
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 2000 });
      expect(panelHeight()).toBe("120px");
      fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 2000 });
      // 松手后移动不再改变高度
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 100 });
      expect(panelHeight()).toBe("120px");
    });

    it("键盘：上下方向键微调，Home / End 到最高 / 最矮，双击恢复默认", () => {
      render(<StatusLogBar />);
      open();
      fireEvent.keyDown(handle(), { key: "ArrowUp" });
      expect(handle().getAttribute("aria-valuenow")).toBe("200");
      fireEvent.keyDown(handle(), { key: "ArrowDown" });
      fireEvent.keyDown(handle(), { key: "ArrowDown" });
      expect(handle().getAttribute("aria-valuenow")).toBe("152");
      fireEvent.keyDown(handle(), { key: "Home" });
      expect(handle().getAttribute("aria-valuenow")).toBe("700");
      fireEvent.keyDown(handle(), { key: "End" });
      expect(handle().getAttribute("aria-valuenow")).toBe("120");
      fireEvent.doubleClick(handle());
      expect(handle().getAttribute("aria-valuenow")).toBe("176");
    });

    it("折叠再展开，高度保持", () => {
      render(<StatusLogBar />);
      open();
      fireEvent.keyDown(handle(), { key: "ArrowUp" });
      open();
      open();
      expect(handle().getAttribute("aria-valuenow")).toBe("200");
    });
  });
});
