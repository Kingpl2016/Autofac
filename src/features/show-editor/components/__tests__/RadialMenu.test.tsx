// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { useEditorHotkeys } from "../../hooks/useEditorHotkeys";
import { addStaticCue } from "../../lib/cueOps";
import { fixed } from "../../lib/looks";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProgrammerStore } from "../../stores/useProgrammerStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { PresetsTab } from "../PresetsTab";
import { RadialMenu } from "../RadialMenu";

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
const ui = () => useEditorUiStore.getState();

function Harness() {
  const commands = useEditorHotkeys();
  return <RadialMenu commands={commands} />;
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 20_000;
      addStaticCue(d, d.tracks[0].id, 1000, { lengthMs: 4000 });
      d.presets.push({ id: "p1", name: "红", group: "color", look: { color: fixed({ kind: "rgb", rgb: [255, 0, 0] }) } });
    }),
  );
  useEditorUiStore.setState({ radial: null, selectedCueIds: [], selectedFixtureIds: [], playheadMs: 3000 });
  useProgrammerStore.getState().clear();
});

afterEach(() => cleanup());

describe("径向轮盘", () => {
  it("Shift+Q 打开；数字键执行命令（分割）后关闭；Esc 关闭", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "Q", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "快捷轮盘" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(8);
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    fireEvent.keyDown(menu, { key: "1" });
    expect(project().cues).toHaveLength(2);
    expect(screen.queryByRole("menu")).toBeNull();

    act(() => ui().setRadial({ x: 100, y: 100 }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(ui().radial).toBeNull();
  });

  it("预设轮：没有选中片段时应用到编程器里选中的灯", () => {
    act(() => {
      ui().setSelectedFixtures([project().fixtures[1].id]);
      ui().setRadial({ x: 200, y: 200 });
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("menuitem", { name: /预设…/ }));
    const presets = screen.getByRole("menu", { name: "预设" });
    fireEvent.click(within(presets).getByRole("menuitem", { name: /红/ }));
    expect(useProgrammerStore.getState().values[project().fixtures[1].id]).toEqual({
      color: fixed({ kind: "rgb", rgb: [255, 0, 0] }),
    });
    expect(ui().radial).toBeNull();
  });
});

describe("预设与编程器", () => {
  it("从编程器新建预设；把预设应用到编程器里选中的灯", () => {
    const [a, b] = project().fixtures.map((f) => f.id);
    act(() => {
      useProgrammerStore.getState().setValues({ [a]: { intensity: fixed(70), attrs: {} } });
      ui().setSelectedFixtures([a]);
    });
    render(<PresetsTab />);
    fireEvent.click(screen.getByRole("button", { name: "从编程器新建预设" }));
    expect(project().presets.at(-1)).toMatchObject({ group: "intensity", look: { intensity: fixed(70) } });

    act(() => ui().setSelectedFixtures([b]));
    fireEvent.click(screen.getByRole("button", { name: "把 红 应用到编程器里选中的灯" }));
    expect(useProgrammerStore.getState().values[b]).toEqual({ color: fixed({ kind: "rgb", rgb: [255, 0, 0] }) });
    expect(screen.getByRole("button", { name: /红：拖到轨道上/ })).toBeTruthy();
  });
});
