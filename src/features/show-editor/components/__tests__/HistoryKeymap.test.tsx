// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { Command } from "../../lib/commands";
import { addFixtures, setTempo } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useKeymapStore } from "../../stores/useKeymapStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { HistoryTab } from "../HistoryTab";
import { KeymapDialog } from "../KeymapDialog";

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

const project = () => useProjectStore.getState().project;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(createEmptyProject("t"));
  useKeymapStore.setState({ overrides: {} });
});

afterEach(() => cleanup());

describe("历史面板", () => {
  it("列出每一步；点击回到某一步之后（多步撤销 / 重做），已撤销的步骤仍可点回", () => {
    const update = useProjectStore.getState().update;
    act(() => update((d) => void addFixtures(d, RGBW, 2)));
    act(() => update((d) => setTempo(d, { bpm: 100, offsetMs: 0, beatsPerBar: 4 })));
    act(() => update((d) => void (d.fixtures[0].name = "主光")));
    render(<HistoryTab />);
    const list = screen.getByRole("list", { name: "撤销历史" });
    const items = () => within(list).getAllByRole("button");
    expect(items().map((b) => b.textContent)).toEqual(["0打开工程", "1添加 2 台灯具", "2修改节拍", "3修改 1 台灯具当前"]);
    expect(items()[3].getAttribute("aria-current")).toBe("step");

    fireEvent.click(items()[1]);
    expect(project().fixtures).toHaveLength(2);
    expect(project().tempo).toBeNull();
    expect(items()[1].getAttribute("aria-current")).toBe("step");
    expect(items()[3].className).toContain("opacity-60");

    fireEvent.click(items()[3]);
    expect(project().fixtures[0].name).toBe("主光");
    fireEvent.click(items()[0]);
    expect(project().fixtures).toHaveLength(0);
  });
});

describe("快捷键设置", () => {
  const commands: Command[] = [
    { id: "a.split", titleKey: "editor.commands.split", category: "timeline", keys: ["mod+b"], run: () => {} },
    { id: "a.marker", titleKey: "editor.commands.marker", category: "timeline", keys: ["m"], run: () => {} },
  ];

  it("录入新组合键、显示冲突、清除、恢复默认", () => {
    act(() => useEditorUiStore.getState().setKeymapOpen(true));
    render(<KeymapDialog commands={commands} />);
    const dialog = screen.getByRole("dialog", { name: "快捷键" });
    const split = within(dialog).getByRole("button", { name: /修改 .*分割.* 的快捷键/ });
    expect(split.textContent).toBe("Ctrl+B");

    fireEvent.click(split);
    expect(split.textContent).toBe("请按下组合键（Esc 取消）");
    fireEvent.keyDown(split, { key: "Shift", shiftKey: true });
    fireEvent.keyDown(split, { key: "M" });
    expect(useKeymapStore.getState().overrides["a.split"]).toEqual(["m"]);
    expect(within(dialog).getAllByText(/冲突/)).toHaveLength(2);
    expect(within(dialog).getByText("已自定义")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /恢复 .*分割.* 的默认快捷键/ }));
    expect(useKeymapStore.getState().overrides["a.split"]).toBeUndefined();
    expect(within(dialog).queryByText(/冲突/)).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: /清除 .*标记.* 的快捷键/ }));
    expect(useKeymapStore.getState().overrides["a.marker"]).toEqual([]);
    expect(within(dialog).getByRole("button", { name: /修改 .*标记.* 的快捷键/ }).textContent).toBe("未设置");

    // Esc 只取消录入，对话框不关闭
    fireEvent.click(split);
    fireEvent.keyDown(split, { key: "Escape" });
    expect(split.textContent).toBe("Ctrl+B");
    expect(useEditorUiStore.getState().keymapOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "快捷键" })).toBe(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "全部恢复默认" }));
    expect(useKeymapStore.getState().overrides).toEqual({});
  });

  it("搜索命令", () => {
    act(() => useEditorUiStore.getState().setKeymapOpen(true));
    render(<KeymapDialog commands={commands} />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索命令…" }), { target: { value: "zzzz" } });
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();
  });
});
