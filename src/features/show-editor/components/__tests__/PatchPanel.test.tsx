// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { useFixtureStore } from "@/features/fixtures";
import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));

import { DIMMER, fakeFile, RGBW } from "../../lib/__tests__/testkit";
import { createEmptyProject } from "../../lib/project";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { InspectorPanel } from "../InspectorPanel";
import { LibraryFixturesTab } from "../LibraryFixturesTab";
import { EditorToolbar } from "../EditorToolbar";

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
  invoke.mockReset();
  useProjectStore.getState().load(createEmptyProject(""));
  useEditorUiStore.getState().clearSelection();
  useFixtureStore.setState({ models: [RGBW, DIMMER], status: "ready", error: null });
});

afterEach(() => cleanup());

/** 同时渲染素材库的“灯具”标签、右侧属性区和工具条，模拟真实的编辑流程。 */
function renderEditor() {
  return render(
    <>
      <EditorToolbar file={fakeFile()} />
      <LibraryFixturesTab />
      <InspectorPanel />
    </>,
  );
}

const rowOf = (name: string) => screen.getByLabelText(`${name} 的名称`).closest("li") as HTMLElement;

describe("灯具与 Patch 面板", () => {
  it("没有灯具时提示去素材库添加", () => {
    renderEditor();
    expect(screen.getByText("还没有灯具。到左侧“灯具”标签页添加。")).toBeTruthy();
  });

  it("从素材库添加多个灯具：地址依次排布、自动选中、占用图给出摘要", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 3 个 RGBW全彩灯" }));

    expect(useProjectStore.getState().project.fixtures).toHaveLength(3);
    for (const [name, range] of [
      ["RGBW全彩灯 1", "1–4"],
      ["RGBW全彩灯 2", "5–8"],
      ["RGBW全彩灯 3", "9–12"],
    ]) {
      expect(within(rowOf(name)).getByText(range)).toBeTruthy();
      expect((within(rowOf(name)).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    }
    expect(screen.getByRole("img", { name: /Universe 0：占用 12 \/ 512 个通道，0 个灯具有冲突/ })).toBeTruthy();
  });

  it("数量输入非法时按 1 处理，且上限为 128", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个 可调白光灯" }));
    expect(useProjectStore.getState().project.fixtures).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "9999" } });
    expect(screen.getByRole("button", { name: "添加 128 个 可调白光灯" })).toBeTruthy();
  });

  it("改地址造成重叠：红色提示、占用图警告，修正后恢复", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 2 个 RGBW全彩灯" }));

    const address = screen.getByLabelText("RGBW全彩灯 2 的起始地址");
    // Enter 提交靠“让输入框失焦”实现，jsdom 里需要先真正聚焦
    act(() => address.focus());
    fireEvent.change(address, { target: { value: "3" } });
    fireEvent.blur(address);

    expect(within(rowOf("RGBW全彩灯 1")).getByText("与 1 个灯具冲突")).toBeTruthy();
    expect(within(rowOf("RGBW全彩灯 2")).getByText("与 1 个灯具冲突")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("2 个灯具的地址有问题");
    expect(screen.getByRole("img", { name: /2 个灯具有冲突/ })).toBeTruthy();

    act(() => address.focus());
    fireEvent.change(address, { target: { value: "5" } });
    fireEvent.keyDown(address, { key: "Enter" });
    expect(screen.queryByText("与 1 个灯具冲突")).toBeNull();
  });

  it("输入框按 Esc 放弃修改，不产生历史", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个 可调白光灯" }));
    const name = screen.getByLabelText("可调白光灯 1 的名称") as HTMLInputElement;
    act(() => name.focus());
    const steps = useProjectStore.temporal.getState().pastStates.length;
    fireEvent.change(name, { target: { value: "乱改一气" } });
    fireEvent.keyDown(name, { key: "Escape" });
    expect((screen.getByLabelText("可调白光灯 1 的名称") as HTMLInputElement).value).toBe("可调白光灯 1");
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps);
  });

  it("勾选两个以上灯具才能编组；编组后出现分组，可调整成员顺序", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 3 个 RGBW全彩灯" }));

    const groupButton = screen.getByRole("button", { name: "编为一组" }) as HTMLButtonElement;
    act(() => useEditorUiStore.getState().setSelectedFixtures([useProjectStore.getState().project.fixtures[0].id]));
    expect(groupButton.disabled).toBe(true);

    fireEvent.click(within(rowOf("RGBW全彩灯 3")).getByRole("checkbox"));
    expect(groupButton.disabled).toBe(false);
    fireEvent.click(groupButton);

    const { groups, tracks } = useProjectStore.getState().project;
    expect(groups).toHaveLength(1);
    expect(groups[0].fixtureIds).toHaveLength(2);
    expect(tracks.filter((t) => t.target.kind === "group")).toHaveLength(1);
    expect(screen.getByDisplayValue("分组 1")).toBeTruthy();

    const before = [...groups[0].fixtureIds];
    fireEvent.click(screen.getByRole("button", { name: "下移 RGBW全彩灯 1" }));
    expect(useProjectStore.getState().project.groups[0].fixtureIds).toEqual([before[1], before[0]]);
    // 第一个成员不能再上移，最后一个不能再下移
    expect((screen.getByRole("button", { name: "上移 RGBW全彩灯 3" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下移 RGBW全彩灯 1" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("删除灯具连同轨道，撤销后恢复；工具条的撤销 / 重做按钮随历史启用", async () => {
    renderEditor();
    const undo = screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement;
    const redo = screen.getByRole("button", { name: "重做" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "添加 1 个 可调白光灯" }));
    await waitFor(() => expect(undo.disabled).toBe(false));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("未命名节目");
    expect(screen.getByText("有未保存的修改")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "删除 可调白光灯 1" }));
    expect(useProjectStore.getState().project.fixtures).toHaveLength(0);
    expect(useProjectStore.getState().project.tracks).toHaveLength(0);

    fireEvent.click(undo);
    expect(useProjectStore.getState().project.fixtures).toHaveLength(1);
    expect(useProjectStore.getState().project.tracks).toHaveLength(1);
    await waitFor(() => expect(redo.disabled).toBe(false));

    fireEvent.click(redo);
    expect(useProjectStore.getState().project.fixtures).toHaveLength(0);
  });

  it("撤销之后，已被删除灯具的勾选不再计入“删除所选”", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 2 个 RGBW全彩灯" }));
    expect(screen.getByRole("button", { name: "删除所选（2）" })).toBeTruthy();
    act(() => useProjectStore.temporal.getState().undo());
    // 工程回到空，面板回到空状态；再添加新灯具时不会被旧勾选污染
    expect(screen.getByText("还没有灯具。到左侧“灯具”标签页添加。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个 可调白光灯" }));
    expect(screen.getByRole("button", { name: "删除所选（1）" })).toBeTruthy();
  });

  it("素材库没有模型时给出提示，加载失败时可重试", () => {
    useFixtureStore.setState({ models: [], status: "ready", error: null });
    const { unmount } = renderEditor();
    expect(screen.getByText("灯具素材库里还没有模型")).toBeTruthy();
    unmount();

    useFixtureStore.setState({ models: [], status: "error", error: "io" });
    invoke.mockResolvedValue([RGBW]);
    renderEditor();
    expect(screen.getByRole("alert").textContent).toBe("无法加载灯具素材库");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(invoke).toHaveBeenCalledWith("fixture_list");
  });
});
