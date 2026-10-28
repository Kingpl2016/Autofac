// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { fixed } from "../../lib/looks";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProgrammerStore } from "../../stores/useProgrammerStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { PreviewPanel } from "../PreviewPanel";
import { ProgrammerPanel } from "../ProgrammerPanel";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  loadTestEngine();
});

const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();
const programmer = () => useProgrammerStore.getState();

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 4);
      d.durationMs = 10_000;
      d.output.gamma = 1;
    }),
  );
  useEditorUiStore.setState({ selectedFixtureIds: [], playheadMs: 0, selectedTrackId: null });
  useEditorPrefsStore.setState({ centerView: "swatches" });
  useAnnouncerStore.setState({ message: "", seq: 0 });
});

afterEach(() => cleanup());

const ids = () => project().fixtures.map((f) => f.id);

describe("编程器面板", () => {
  it("选择工具：全选、奇偶、反选、下一台、隔 N 选 1", () => {
    render(<ProgrammerPanel />);
    const bar = screen.getByRole("toolbar", { name: "选择工具" });
    fireEvent.click(within(bar).getByRole("button", { name: "全选" }));
    expect(ui().selectedFixtureIds).toEqual(ids());
    expect(screen.getByText("已选 4 / 4")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "偶数" }));
    expect(ui().selectedFixtureIds).toEqual([ids()[1], ids()[3]]);
    fireEvent.click(within(bar).getByRole("button", { name: "反选" }));
    expect(ui().selectedFixtureIds).toEqual([ids()[0], ids()[2]]);
    fireEvent.click(within(bar).getByRole("button", { name: "下一台" }));
    expect(ui().selectedFixtureIds).toEqual([ids()[3]]);
    fireEvent.click(within(bar).getByRole("button", { name: "清空" }));
    const n = screen.getByRole("textbox", { name: "每几台取一台" });
    fireEvent.change(n, { target: { value: "2" } });
    fireEvent.blur(n);
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    expect(ui().selectedFixtureIds).toEqual([ids()[0], ids()[2]]);
  });

  it("同一帧给不同灯具设不同的值，记录成一个场景片段（一步撤销）", () => {
    render(<ProgrammerPanel />);
    expect(screen.getByText(/先选择灯具/)).toBeTruthy();
    act(() => ui().setSelectedFixtures([ids()[0], ids()[1]]));
    const intensity = screen.getByRole("textbox", { name: "强度数值" });
    fireEvent.change(intensity, { target: { value: "60" } });
    fireEvent.blur(intensity);
    act(() => ui().setSelectedFixtures([ids()[2]]));
    const red = screen.getByRole("textbox", { name: /红.*数值|红/ });
    fireEvent.change(red, { target: { value: "0" } });
    fireEvent.blur(red);
    // 只设颜色的灯自动给 100% 强度
    expect(programmer().values[ids()[2]]).toMatchObject({ intensity: fixed(100), color: fixed({ kind: "rgb", rgb: [0, 255, 255] }) });
    expect(programmer().values[ids()[0]]).toEqual({ intensity: fixed(60) });
    expect(screen.getByText("3 台灯具有值")).toBeTruthy();

    act(() => ui().setPlayhead(3000));
    const steps = useProjectStore.temporal.getState().pastStates.length;
    fireEvent.click(screen.getByRole("button", { name: "记录为场景片段" }));
    const clip = project().cues.find((c) => c.kind === "scene");
    expect(clip).toMatchObject({ startMs: 3000, endMs: 5000 });
    expect(clip?.kind === "scene" && clip.entries.map((e) => e.fixtureId)).toEqual(ids().slice(0, 3));
    expect(project().tracks.at(-1)?.target).toEqual({ kind: "scene" });
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);
    expect(useAnnouncerStore.getState().message).toBe("已在播放头处记录场景片段");
  });

  it("记录到各自轨道；清空编程器；换工程时编程器自动清空", () => {
    act(() => {
      ui().setSelectedFixtures([ids()[1]]);
      programmer().setValues({ [ids()[1]]: { intensity: fixed(40) } });
    });
    render(<ProgrammerPanel />);
    fireEvent.click(screen.getByRole("button", { name: "记录到各自轨道" }));
    expect(project().cues).toHaveLength(1);
    expect(project().cues[0]).toMatchObject({ kind: "look", trackId: project().tracks[1].id });
    fireEvent.click(screen.getByRole("button", { name: "清空编程器" }));
    expect(programmer().values).toEqual({});

    act(() => programmer().setValues({ x: { intensity: fixed(1) } }));
    act(() => useProjectStore.getState().load(createEmptyProject("新")));
    expect(programmer().values).toEqual({});
  });
});

describe("预览区与编程器", () => {
  it("点选色块选择灯具（Ctrl 追加、Shift 连选），编程器的值叠在预览上", () => {
    render(<PreviewPanel />);
    const swatch = (n: number) => screen.getByRole("button", { name: new RegExp(`RGBW全彩灯 ${n}：`) });
    fireEvent.click(swatch(1));
    expect(ui().selectedFixtureIds).toEqual([ids()[0]]);
    fireEvent.click(swatch(3), { shiftKey: true });
    expect(ui().selectedFixtureIds).toEqual(ids().slice(0, 3));
    fireEvent.click(swatch(2), { ctrlKey: true });
    expect(ui().selectedFixtureIds).toEqual([ids()[0], ids()[2]]);
    expect(swatch(1).getAttribute("aria-pressed")).toBe("true");

    expect(swatch(1).getAttribute("aria-label")).toContain("红 0");
    act(() =>
      programmer().setValues({
        [ids()[0]]: { intensity: fixed(100), color: fixed({ kind: "rgb", rgb: [255, 0, 0] }) },
      }),
    );
    expect(swatch(1).getAttribute("aria-label")).toContain("红 255");
    expect(swatch(2).getAttribute("aria-label")).toContain("红 0");
  });
});

describe("灯具表", () => {
  it("切换到灯具表；点行选灯；编辑单元格写入编程器（选中的灯一起改），已编程的值高亮", () => {
    act(() => {
      useEditorPrefsStore.setState({ centerView: "swatches" });
    });
    render(<PreviewPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "灯具表" }));
    const table = screen.getByRole("table", { name: "灯具表" });
    expect(within(table).getAllByRole("row")).toHaveLength(5);

    fireEvent.click(within(table).getByRole("button", { name: "RGBW全彩灯 1" }));
    fireEvent.click(within(table).getByRole("button", { name: "RGBW全彩灯 3" }), { shiftKey: true });
    expect(ui().selectedFixtureIds).toEqual(ids().slice(0, 3));

    const row2 = within(table).getByRole("button", { name: "RGBW全彩灯 2" }).closest("tr") as HTMLElement;
    fireEvent.click(within(row2).getByRole("button", { name: /^Red 0%/ }));
    const input = within(row2).getByRole("textbox", { name: "Red 的百分比" });
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    for (const id of ids().slice(0, 3)) {
      expect(programmer().values[id]).toMatchObject({
        intensity: fixed(100),
        color: fixed({ kind: "manual", values: { red: 0.5 } }),
      });
    }
    expect(programmer().values[ids()[3]]).toBeUndefined();
    // 预览叠了编程器：红光 50% → 128
    const cell = within(row2).getByRole("button", { name: /^Red 50%/ });
    expect(cell.className).toContain("bg-keyframe");
  });
});
