// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { produce } from "immer";

import i18n from "@/shared/i18n";

/** 替身时间线：记录最近一次收到的 props，测试通过它们模拟库回调（真实的库在 jsdom 里没有布局，不渲染轨道）。 */
const stub = vi.hoisted(() => ({
  props: null as null | Record<string, (...args: never[]) => unknown>,
  setTime: vi.fn(),
  setScrollTop: vi.fn(),
  setScrollLeft: vi.fn(),
}));
vi.mock("../../timeline/TimelineAdapter", () => ({
  TimelineAdapter: forwardRef((props: Record<string, (...args: never[]) => unknown>, ref) => {
    stub.props = props;
    useImperativeHandle(ref, () => ({
      setTime: stub.setTime,
      setScrollTop: stub.setScrollTop,
      setScrollLeft: stub.setScrollLeft,
    }));
    return <div data-testid="timeline-stub" />;
  }),
}));

import { addStaticCue } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { TimelinePanel } from "../TimelinePanel";

/** 调用替身上记录的回调。 */
function call(name: string, ...args: unknown[]) {
  const fn = stub.props?.[name] as ((...a: unknown[]) => unknown) | undefined;
  if (!fn) throw new Error(`替身时间线没有收到 ${name}`);
  let result: unknown;
  act(() => {
    result = fn(...args);
  });
  return result;
}

const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();

function loadSample(): { a: string; b: string; cueA: string } {
  let cueA = "";
  const p: ShowProject = produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    d.durationMs = 60_000;
    cueA = addStaticCue(d, d.tracks[0].id, 1000, { lengthMs: 2000 }) ?? "";
  });
  useProjectStore.getState().load(p);
  return { a: p.tracks[0].id, b: p.tracks[1].id, cueA };
}

// 节拍网格用 ResizeObserver 测量宽度，jsdom 里没有
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
  stub.props = null;
  stub.setTime.mockReset();
  useProjectStore.getState().load(createEmptyProject("t"));
  useEditorUiStore.setState({
    selectedCueIds: [],
    selectedTrackId: null,
    playheadMs: 0,
    clipboard: [],
  });
});

afterEach(() => cleanup());

const renderPanel = () =>
  render(
    <DndContext>
      <TimelinePanel />
    </DndContext>,
  );

describe("TimelinePanel", () => {
  it("没有轨道时显示提示，不渲染时间线", () => {
    renderPanel();
    expect(screen.getByText("添加灯具后，每个灯具会在这里生成一条轨道")).toBeTruthy();
    expect(screen.queryByTestId("timeline-stub")).toBeNull();
  });

  it("轨道头显示灯具名；静音 / 独奏 / 锁定开关写回工程并可撤销", () => {
    loadSample();
    renderPanel();
    expect(screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 1" })).toBeTruthy();
    const mute = screen.getByRole("button", { name: "静音 RGBW全彩灯 1" });
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(mute);
    expect(project().tracks[0].mute).toBe(true);
    expect(screen.getByRole("button", { name: "取消静音 RGBW全彩灯 1" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "锁定 RGBW全彩灯 2" }));
    expect(project().tracks[1].lock).toBe(true);
    act(() => useProjectStore.temporal.getState().undo());
    expect(project().tracks[1].lock).toBe(false);
  });

  it("点击轨道头选中该轨道", () => {
    const { b } = loadSample();
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 2" }));
    expect(ui().selectedTrackId).toBe(b);
  });

  it("给时间线传入固定总长度和每个 Cue 的活动范围", () => {
    loadSample();
    renderPanel();
    expect(stub.props?.minScaleCount).toBe(60);
    expect(stub.props?.maxScaleCount).toBe(60);
    const rows = stub.props?.editorData as unknown as { actions: { start: number; end: number; maxEnd: number }[] }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].actions[0]).toMatchObject({ start: 1, end: 3, maxEnd: 60 });
  });

  it("双击轨道空白处：对齐到帧新建 Cue 并选中；已被占用的位置不新建", () => {
    const { a, cueA } = loadSample();
    renderPanel();
    call("onDoubleClickRow", {}, { row: { id: a }, time: 10.01 });
    const added = project().cues.find((c) => c.id !== cueA);
    expect(added).toMatchObject({ trackId: a, startMs: 10_000, endMs: 12_000 });
    expect(ui().selectedCueIds).toEqual([added?.id]);
    expect(ui().selectedTrackId).toBe(a);

    const before = project().cues.length;
    call("onDoubleClickRow", {}, { row: { id: a }, time: 1.5 });
    expect(project().cues).toHaveLength(before);
  });

  it("拖动结束：回传的新位置写入工程，一次手势一步撤销；与邻居重叠的修改被拒绝", () => {
    const { a, cueA } = loadSample();
    renderPanel();
    call("onDoubleClickRow", {}, { row: { id: a }, time: 10 });
    const steps = useProjectStore.temporal.getState().pastStates.length;

    const rows = structuredClone(stub.props?.editorData) as unknown as { id: string; actions: { id: string; start: number; end: number }[] }[];
    const action = rows[0].actions.find((x) => x.id === cueA);
    if (!action) throw new Error("没有找到被拖动的 Cue");
    action.start = 4;
    action.end = 6;
    call("onChange", rows);
    expect(project().cues.find((c) => c.id === cueA)).toMatchObject({ startMs: 4000, endMs: 6000 });
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);

    // 移到 9~11 秒会压住 10 秒处的另一个 Cue：整个修改被拒绝
    action.start = 9;
    action.end = 11;
    call("onChange", rows);
    expect(project().cues.find((c) => c.id === cueA)).toMatchObject({ startMs: 4000, endMs: 6000 });
  });

  it("点击 Cue 选中；Ctrl 点击追加 / 取消；点击轨道空白处清空", () => {
    const { a, cueA } = loadSample();
    renderPanel();
    call("onDoubleClickRow", {}, { row: { id: a }, time: 10 });
    const other = project().cues.find((c) => c.id !== cueA)?.id ?? "";

    call("onClickAction", { ctrlKey: false, metaKey: false, shiftKey: false }, { action: { id: cueA }, row: { id: a } });
    expect(ui().selectedCueIds).toEqual([cueA]);
    call("onClickAction", { ctrlKey: true, metaKey: false, shiftKey: false }, { action: { id: other }, row: { id: a } });
    expect(ui().selectedCueIds).toEqual([cueA, other]);
    call("onClickAction", { ctrlKey: true, metaKey: false, shiftKey: false }, { action: { id: cueA }, row: { id: a } });
    expect(ui().selectedCueIds).toEqual([other]);
    call("onClickRow", {}, { row: { id: a }, time: 30 });
    expect(ui().selectedCueIds).toEqual([]);
  });

  it("拖动 / 点击标尺定位：播放头与时间码同步，也能反过来驱动库的光标", () => {
    loadSample();
    renderPanel();
    call("onSeek", 12.5);
    expect(ui().playheadMs).toBe(12_500);
    expect(screen.getByLabelText("播放头位置").textContent).toBe("00:12.15");
    expect(stub.setTime).toHaveBeenLastCalledWith(12.5);
    act(() => ui().setPlayhead(3000));
    expect(stub.setTime).toHaveBeenLastCalledWith(3);
  });

  it("Cue 块显示亮度，静音轨道上的变暗", () => {
    const { cueA } = loadSample();
    renderPanel();
    const render1 = (stub.props?.getActionRender as (a: { id: string }) => React.ReactNode)({ id: cueA });
    const { container, unmount } = render(<>{render1}</>);
    expect(container.textContent).toBe("100%");
    expect(container.firstElementChild?.className).not.toContain("opacity-40");
    unmount();

    act(() => useProjectStore.getState().update((d) => {
      d.tracks[0].mute = true;
    }));
    const dimmed = render(<>{(stub.props?.getActionRender as (a: { id: string }) => React.ReactNode)({ id: cueA })}</>);
    expect(dimmed.container.firstElementChild?.className).toContain("opacity-40");
    expect((stub.props?.getActionRender as (a: { id: string }) => React.ReactNode)({ id: "ghost" })).toBeNull();
  });
});

describe("TimelinePanel 键盘", () => {
  const group = () => screen.getByRole("group", { name: "轨道与 Cue" });

  it("Delete 删除选中的 Cue（一步撤销），Esc 取消选择", () => {
    const { cueA } = loadSample();
    renderPanel();
    act(() => ui().selectCues([cueA]));
    fireEvent.keyDown(group(), { key: "Delete" });
    expect(project().cues).toHaveLength(0);
    expect(ui().selectedCueIds).toEqual([]);
    act(() => useProjectStore.temporal.getState().undo());
    expect(project().cues).toHaveLength(1);

    act(() => ui().selectCues([cueA]));
    fireEvent.keyDown(group(), { key: "Escape" });
    expect(ui().selectedCueIds).toEqual([]);
  });

  it("Ctrl+C / Ctrl+V：粘贴到播放头，保持轨道", () => {
    const { cueA, a } = loadSample();
    renderPanel();
    act(() => {
      ui().selectCues([cueA]);
      ui().setPlayhead(10_000);
    });
    fireEvent.keyDown(group(), { key: "c", ctrlKey: true });
    expect(ui().clipboard).toHaveLength(1);
    fireEvent.keyDown(group(), { key: "v", ctrlKey: true });
    const pasted = project().cues.find((c) => c.id !== cueA);
    expect(pasted).toMatchObject({ trackId: a, startMs: 10_000, endMs: 12_000 });
    expect(ui().selectedCueIds).toEqual([pasted?.id]);
  });

  it("Ctrl+D 复制一份紧接在选中 Cue 之后", () => {
    const { cueA } = loadSample();
    renderPanel();
    act(() => ui().selectCues([cueA]));
    fireEvent.keyDown(group(), { key: "d", ctrlKey: true });
    expect(project().cues.map((c) => [c.startMs, c.endMs]).sort((x, y) => x[0] - y[0])).toEqual([
      [1000, 3000],
      [3000, 5000],
    ]);
  });

  it("方向键把选中的 Cue 平移 1 帧，Shift 平移 10 帧；越界时不动", () => {
    const { cueA } = loadSample();
    renderPanel();
    act(() => ui().selectCues([cueA]));
    fireEvent.keyDown(group(), { key: "ArrowRight" });
    expect(project().cues[0]).toMatchObject({ startMs: 1033, endMs: 3033 });
    fireEvent.keyDown(group(), { key: "ArrowRight" });
    expect(project().cues[0].startMs).toBe(1067);
    fireEvent.keyDown(group(), { key: "ArrowLeft", shiftKey: true });
    expect(project().cues[0].startMs).toBe(733);
    // 一路推到 0 之前：最后一步被拒绝
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(group(), { key: "ArrowLeft", shiftKey: true });
    expect(project().cues[0].startMs).toBeGreaterThanOrEqual(0);
    expect(project().cues[0].endMs - project().cues[0].startMs).toBe(2000);
  });

  it("焦点在输入框里时快捷键不生效", () => {
    const { cueA } = loadSample();
    renderPanel();
    act(() => ui().selectCues([cueA]));
    const input = document.createElement("input");
    group().appendChild(input);
    fireEvent.keyDown(input, { key: "Delete", bubbles: true });
    expect(project().cues).toHaveLength(1);
    expect(within(group()).queryByRole("textbox")).not.toBeNull();
  });

  it("滚轮纵向滚动转交给时间线", () => {
    loadSample();
    renderPanel();
    const headers = screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 1" }).closest("div") as HTMLElement;
    fireEvent.wheel(headers, { deltaY: 40 });
    expect(stub.setScrollTop).toHaveBeenCalledWith(40);
  });
});
