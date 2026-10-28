// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));

import { useEditorCommands } from "../../hooks/useEditorCommands";
import { findConflicts } from "../../lib/commands";
import { addStaticCue } from "../../lib/cueOps";
import { addFixtures, createGroup } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { InspectorPanel } from "../InspectorPanel";

const scrolled = vi.fn();
const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled(this);
  };
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  scrolled.mockReset();
  ui().clearSelection();
  useEditorUiStore.setState({ revealRequest: null, inspectorTab: "cue", inspectorCollapsed: false });
  useEditorPrefsStore.setState({ cueSections: {}, patchSections: {} });
  // 3 台灯，后两台编为一组；第三台的轨道和分组轨道上各有一个片段
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 3);
      d.durationMs = 20_000;
      createGroup(d, "后排", [d.fixtures[1].id, d.fixtures[2].id]);
      addStaticCue(d, d.tracks[2].id, 0, { lengthMs: 1000 });
      addStaticCue(d, d.tracks.find((t) => t.target.kind === "group")?.id ?? "", 0, { lengthMs: 1000 });
    }),
  );
});

afterEach(() => cleanup());

describe("Cue 属性：在 Patch 中查看", () => {
  it("单灯片段：显示灯具名，点链接切到“灯具与 Patch”、选中并滚动到那台灯", () => {
    act(() => ui().selectCues([project().cues[0].id]));
    render(<InspectorPanel />);
    expect(screen.getByText("灯具：RGBW全彩灯 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在 Patch 中查看" }));
    expect(ui().inspectorTab).toBe("patch");
    expect(ui().selectedFixtureIds).toEqual([project().fixtures[2].id]);
    const option = within(screen.getByRole("listbox", { name: "灯具列表" })).getByRole("option", { name: "RGBW全彩灯 3" });
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(scrolled).toHaveBeenCalledWith(option);
  });

  it("分组片段：显示分组名与台数；右侧收起时先展开", () => {
    useEditorUiStore.setState({ inspectorCollapsed: true });
    act(() => ui().selectCues([project().cues[1].id]));
    render(<InspectorPanel />);
    expect(screen.getByText("分组：后排 · 2 台")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在 Patch 中查看" }));
    expect(ui().inspectorCollapsed).toBe(false);
    expect(ui().selectedFixtureIds).toEqual([project().fixtures[1].id, project().fixtures[2].id]);
  });
});

describe("默认快捷键", () => {
  it("收起 / 展开左右侧栏的快捷键与其它命令不冲突", () => {
    const { result } = renderHook(() => useEditorCommands());
    const ids = result.current.map((c) => c.id);
    expect(ids).toContain("view.toggleLibrary");
    expect(ids).toContain("view.toggleInspector");
    expect(findConflicts(result.current, {})).toEqual([]);
    act(() => result.current.find((c) => c.id === "view.toggleInspector")?.run());
    expect(ui().inspectorCollapsed).toBe(true);
    act(() => result.current.find((c) => c.id === "view.toggleInspector")?.run());
    expect(ui().inspectorCollapsed).toBe(false);
  });
});
