// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { useEditorHotkeys } from "../../hooks/useEditorHotkeys";
import { addStaticCue } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useKeymapStore } from "../../stores/useKeymapStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { CommandPalette } from "../CommandPalette";

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
  return <CommandPalette commands={commands} />;
}

/** 一条轨道上有一个 1~5 秒的 Cue、时长 60 秒的工程。 */
function seed(): string {
  const p = produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 1);
    d.durationMs = 60_000;
    addStaticCue(d, d.tracks[0].id, 1000, { lengthMs: 4000 });
  });
  useProjectStore.getState().load(p);
  return p.cues[0].id;
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useEditorUiStore.setState({ playheadMs: 0, selectedCueIds: [], selectedTrackId: null, paletteOpen: false });
  useKeymapStore.setState({ overrides: {} });
});

afterEach(() => cleanup());

describe("命令面板", () => {
  it("Ctrl+K 打开，模糊搜索后 Enter 执行并关闭", () => {
    seed();
    render(<Harness />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(ui().paletteOpen).toBe(true);
    const input = screen.getByRole("combobox", { name: "搜索命令…" });
    fireEvent.change(input, { target: { value: "循环入点" } });
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("设置循环入点");
    expect(options[0].textContent).toContain("I");
    act(() => ui().setPlayhead(2000));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ui().paletteOpen).toBe(false);
    expect(project().loopRange).toEqual({ startMs: 2000, endMs: 60_000 });
  });

  it("没有匹配时显示空提示；不可用的命令置灰且不执行", () => {
    seed();
    render(<Harness />);
    act(() => ui().setPaletteOpen(true));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzzzqqq" } });
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();
    fireEvent.change(input, { target: { value: "清除循环区间" } });
    const option = screen.getAllByRole("option")[0];
    expect(option.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ui().paletteOpen).toBe(true);
  });

  it("显示用户自定义的快捷键", () => {
    seed();
    useKeymapStore.getState().setKeys("timeline.split", ["ctrl+shift+x"]);
    render(<Harness />);
    act(() => ui().setPaletteOpen(true));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "分割" } });
    expect(screen.getAllByRole("option")[0].textContent).toContain("Ctrl+Shift+X");
  });
});

describe("命令快捷键", () => {
  it("Ctrl+B 分割播放头处的片段，Shift+Delete 波纹删除", () => {
    seed();
    render(<Harness />);
    act(() => ui().setPlayhead(3000));
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(project().cues.map((c) => [c.startMs, c.endMs]).sort((a, b) => a[0] - b[0])).toEqual([
      [1000, 3000],
      [3000, 5000],
    ]);
    const left = project().cues.find((c) => c.startMs === 1000)!;
    act(() => ui().selectCues([left.id]));
    fireEvent.keyDown(window, { key: "Delete", shiftKey: true });
    expect(project().cues.map((c) => [c.startMs, c.endMs])).toEqual([[1000, 3000]]);
  });

  it("I / O 设置入出点，自定义快捷键覆盖默认", () => {
    seed();
    useKeymapStore.getState().setKeys("timeline.loopIn", ["j"]);
    render(<Harness />);
    act(() => ui().setPlayhead(1000));
    fireEvent.keyDown(window, { key: "i" });
    expect(project().loopRange).toBeNull();
    fireEvent.keyDown(window, { key: "j" });
    act(() => ui().setPlayhead(4000));
    fireEvent.keyDown(window, { key: "o" });
    expect(project().loopRange).toEqual({ startMs: 1000, endMs: 4000 });
  });
});
