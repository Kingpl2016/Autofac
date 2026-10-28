// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));

import { createEmptyProject } from "../../lib/project";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { OutputPopover } from "../OutputPopover";

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
  useProjectStore.getState().load(createEmptyProject("t"));
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
