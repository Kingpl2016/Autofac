// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { produce } from "immer";

import i18n from "@/shared/i18n";

/** 删除后的提示（带撤销按钮）走 sonner：替身记录调用。 */
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { useEditorHotkeys } from "../../hooks/useEditorHotkeys";
import { addLookCue, addStaticCue } from "../../lib/cueOps";
import { fixed } from "../../lib/looks";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { START_LEFT } from "../../timeline/timelineData";
import { useTimelineScrollStore } from "../../timeline/timelineScrollStore";
import { TimelinePanel } from "../TimelinePanel";

const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();

/** 两条轨道、时长 60 秒；轨道 1 上有一个 1~3 秒的 Cue。 */
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

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.setPointerCapture = () => undefined;
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(createEmptyProject("t"));
  useEditorUiStore.setState({
    selectedCueIds: [],
    selectedTrackId: null,
    playheadMs: 0,
    clipboard: [],
    pxPerSec: 100,
    snapEnabled: false,
  });
  useTimelineScrollStore.setState({ left: 0, top: 0 });
});

afterEach(() => cleanup());

const renderPanel = () =>
  render(
    <DndContext>
      <TimelinePanel />
    </DndContext>,
  );

/** jsdom 里元素的屏幕矩形都是 0，所以内容坐标 = clientX / clientY。时间 → 横坐标（100 px/s）。 */
const x = (ms: number) => START_LEFT + ms / 10;
/** 第 n 条轨道中间的纵坐标（默认行高 44）。 */
const y = (row: number) => row * 44 + 22;
const body = () => screen.getByTestId("timeline-body").firstElementChild as HTMLElement;
const clip = (re: RegExp = /RGBW全彩灯 1 的片段/) => screen.getByRole("button", { name: re });

function drag(target: Element, from: { x: number; y: number }, to: { x: number; y: number }, opts: { altKey?: boolean } = {}) {
  fireEvent.pointerDown(target, { button: 0, clientX: from.x, clientY: from.y, pointerId: 1 });
  fireEvent.pointerMove(target, { clientX: to.x, clientY: to.y, pointerId: 1, ...opts });
  fireEvent.pointerUp(target, { clientX: to.x, clientY: to.y, pointerId: 1 });
}

describe("TimelinePanel（自研时间线）", () => {
  it("没有轨道时显示提示，不渲染轨道区", () => {
    renderPanel();
    expect(screen.getByText("添加灯具后，每个灯具会在这里生成一条轨道")).toBeTruthy();
    expect(screen.queryByTestId("timeline-body")).toBeNull();
  });

  it("轨道头显示灯具名；静音 / 独奏 / 锁定开关写回工程并可撤销；静音轨道上的片段变暗", () => {
    loadSample();
    renderPanel();
    expect(screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "静音 RGBW全彩灯 1" }));
    expect(project().tracks[0].mute).toBe(true);
    expect(clip().querySelector(".opacity-40")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "锁定 RGBW全彩灯 2" }));
    expect(project().tracks[1].lock).toBe(true);
    act(() => useProjectStore.temporal.getState().undo());
    expect(project().tracks[1].lock).toBe(false);
  });

  it("片段按时间定位，显示亮度；无障碍名称含轨道与起止时间", () => {
    loadSample();
    renderPanel();
    const el = clip();
    expect(el.style.left).toBe(`${x(1000)}px`);
    expect(el.style.width).toBe("200px");
    expect(el.textContent).toContain("100%");
    expect(el.getAttribute("aria-label")).toMatch(/RGBW全彩灯 1.*00:01\.00.*00:03\.00/);
  });

  it("点击片段选中；Ctrl 点击追加 / 取消；点击轨道空白处选中轨道并清空选择", () => {
    const { a, b, cueA } = loadSample();
    act(() => useProjectStore.getState().update((d) => void addStaticCue(d, d.tracks[1].id, 5000)));
    const other = project().cues.find((c) => c.id !== cueA)?.id ?? "";
    renderPanel();
    fireEvent.pointerDown(clip(), { button: 0, clientX: x(1500), clientY: y(0) });
    fireEvent.pointerUp(clip(), { clientX: x(1500), clientY: y(0) });
    expect(ui().selectedCueIds).toEqual([cueA]);
    expect(ui().selectedTrackId).toBe(a);
    const second = clip(/RGBW全彩灯 2 的片段/);
    fireEvent.pointerDown(second, { button: 0, ctrlKey: true, clientX: x(5500), clientY: y(1) });
    fireEvent.pointerUp(second, { clientX: x(5500), clientY: y(1) });
    expect(ui().selectedCueIds).toEqual([cueA, other]);
    expect(clip().getAttribute("aria-pressed")).toBe("true");

    fireEvent.pointerDown(body(), { button: 0, clientX: x(30_000), clientY: y(1) });
    fireEvent.pointerUp(body(), { clientX: x(30_000), clientY: y(1) });
    expect(ui().selectedCueIds).toEqual([]);
    expect(ui().selectedTrackId).toBe(b);
  });

  it("双击轨道空白处：对齐到帧新建 Cue 并选中；已被占用的位置不新建", () => {
    const { a, cueA } = loadSample();
    renderPanel();
    fireEvent.doubleClick(body(), { clientX: x(10_010), clientY: y(0) });
    const added = project().cues.find((c) => c.id !== cueA);
    expect(added).toMatchObject({ trackId: a, startMs: 10_000, endMs: 12_000 });
    expect(ui().selectedCueIds).toEqual([added?.id]);
    const before = project().cues.length;
    fireEvent.doubleClick(clip(/00:01\.00/), { clientX: x(1500), clientY: y(0) });
    expect(project().cues).toHaveLength(before);
  });

  it("拖动片段：松手时写入工程（一步撤销）；拖到别的轨道换轨", () => {
    const { b, cueA } = loadSample();
    renderPanel();
    const steps = useProjectStore.temporal.getState().pastStates.length;
    drag(clip(), { x: x(1500), y: y(0) }, { x: x(4500), y: y(0) });
    expect(project().cues.find((c) => c.id === cueA)).toMatchObject({ startMs: 4000, endMs: 6000 });
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);

    drag(clip(), { x: x(4500), y: y(0) }, { x: x(4500), y: y(1) });
    expect(project().cues.find((c) => c.id === cueA)).toMatchObject({ trackId: b, startMs: 4000 });
  });

  it("拖动中显示预览，按 Esc 取消，工程不变", () => {
    const { cueA } = loadSample();
    renderPanel();
    fireEvent.pointerDown(clip(), { button: 0, clientX: x(1500), clientY: y(0) });
    fireEvent.pointerMove(clip(), { clientX: x(6500), clientY: y(0) });
    expect(clip().style.left).toBe(`${x(6000)}px`);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(body(), { clientX: x(6500), clientY: y(0) });
    expect(project().cues.find((c) => c.id === cueA)).toMatchObject({ startMs: 1000, endMs: 3000 });
    expect(ui().selectedCueIds).toEqual([cueA]);
  });

  it("拖动右边缘裁剪；开启吸附时吸到播放头并画吸附线，按住 Alt 不吸附", () => {
    const { cueA } = loadSample();
    act(() => useEditorUiStore.setState({ snapEnabled: true, playheadMs: 5000 }));
    renderPanel();
    const edge = clip().querySelector('[data-edge="end"]') as HTMLElement;
    fireEvent.pointerDown(edge, { button: 0, clientX: x(3000), clientY: y(0) });
    fireEvent.pointerMove(edge, { clientX: x(4950), clientY: y(0) });
    expect(screen.getByTestId("snap-line").style.left).toBe(`${x(5000)}px`);
    fireEvent.pointerUp(edge, { clientX: x(4950), clientY: y(0) });
    expect(project().cues.find((c) => c.id === cueA)).toMatchObject({ startMs: 1000, endMs: 5000 });

    const edge2 = clip().querySelector('[data-edge="end"]') as HTMLElement;
    // 离播放头 60ms，本该吸附；按住 Alt 时停在放下的位置（对齐到帧）
    drag(edge2, { x: x(5000), y: y(0) }, { x: x(4940), y: y(0) }, { altKey: true });
    expect(project().cues.find((c) => c.id === cueA)?.endMs).toBe(4933);
  });

  it("空白处拖动框选；Ctrl 框选追加", () => {
    const { cueA } = loadSample();
    act(() => useProjectStore.getState().update((d) => void addStaticCue(d, d.tracks[1].id, 8000)));
    const other = project().cues.find((c) => c.id !== cueA)?.id ?? "";
    renderPanel();
    drag(body(), { x: x(500), y: 2 }, { x: x(2000), y: y(0) });
    expect(ui().selectedCueIds).toEqual([cueA]);
    expect(screen.queryByTestId("marquee")).toBeNull();
    fireEvent.pointerDown(body(), { button: 0, ctrlKey: true, clientX: x(7500), clientY: y(1) });
    fireEvent.pointerMove(body(), { clientX: x(9000), clientY: y(1) + 5 });
    expect(screen.getByTestId("marquee")).toBeTruthy();
    fireEvent.pointerUp(body(), { clientX: x(9000), clientY: y(1) + 5 });
    expect(ui().selectedCueIds.sort()).toEqual([cueA, other].sort());
  });

  it("锁定轨道上的片段不能拖动", () => {
    const { cueA } = loadSample();
    act(() => useProjectStore.getState().update((d) => void (d.tracks[0].lock = true)));
    renderPanel();
    expect(clip().querySelector("[data-edge]")).toBeNull();
    drag(clip(), { x: x(1500), y: y(0) }, { x: x(4500), y: y(0) });
    expect(project().cues.find((c) => c.id === cueA)).toMatchObject({ startMs: 1000 });
  });

  it("点击 / 拖动标尺定位播放头；时间码同步", () => {
    loadSample();
    renderPanel();
    const ruler = screen.getByRole("group", { name: "时间标尺" });
    fireEvent.pointerDown(ruler, { button: 0, clientX: x(12_500), pointerId: 1 });
    expect(ui().playheadMs).toBe(12_500);
    expect(screen.getByLabelText("播放头位置").textContent).toBe("00:12.15");
    fireEvent.pointerMove(ruler, { clientX: x(20_000), pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: x(20_000), pointerId: 1 });
    expect(ui().playheadMs).toBe(20_000);
    // 抓取带比线宽：中心对准时刻
    expect(screen.getByTestId("playhead").style.transform).toBe(`translateX(${x(20_000) - 4.5}px)`);
    // 标尺悬停显示幽灵线，离开后消失
    fireEvent.pointerMove(ruler, { clientX: x(30_000) });
    expect(screen.getByTestId("ruler-ghost").textContent).toBe("00:30.00");
    fireEvent.pointerLeave(ruler);
    expect(screen.queryByTestId("ruler-ghost")).toBeNull();
  });

  it("直接拖动播放头：吸附到标记点，按住 Alt 不吸附；方向键逐帧移动", () => {
    loadSample();
    act(() =>
      useProjectStore.getState().update((d) => void d.markers.push({ id: "m", timeMs: 10_000, label: "副歌" })),
    );
    act(() => useEditorUiStore.setState({ snapEnabled: true }));
    renderPanel();
    const head = screen.getByRole("slider", { name: "播放头（拖动定位）" });
    fireEvent.pointerDown(head, { button: 0, clientX: x(0), pointerId: 2 });
    fireEvent.pointerMove(head, { clientX: x(9_950), pointerId: 2 });
    expect(ui().playheadMs).toBe(10_000);
    fireEvent.pointerMove(head, { clientX: x(9_950), pointerId: 2, altKey: true });
    expect(ui().playheadMs).toBe(9_967);
    fireEvent.pointerUp(head, { pointerId: 2 });
    expect(head.getAttribute("aria-valuetext")).toBe("00:09.29");
    fireEvent.keyDown(head, { key: "ArrowRight", shiftKey: true });
    expect(ui().playheadMs).toBe(10_300);
  });

  it("A-B 循环区间：标尺上显示入点出点，方向键逐帧调整", () => {
    loadSample();
    act(() => useProjectStore.getState().update((d) => void (d.loopRange = { startMs: 2000, endMs: 6000 })));
    renderPanel();
    const out = screen.getByRole("slider", { name: /循环出点/ });
    expect(out.getAttribute("aria-valuenow")).toBe("6000");
    fireEvent.keyDown(out, { key: "ArrowRight" });
    expect(project().loopRange).toEqual({ startMs: 2000, endMs: 6033 });
    fireEvent.keyDown(screen.getByRole("slider", { name: /循环入点/ }), { key: "ArrowLeft", shiftKey: true });
    expect(project().loopRange?.startMs).toBe(1670);
  });
});

describe("剪映式外观", () => {
  it("引擎就绪后片段底部显示实际输出色带", () => {
    loadTestEngine();
    loadSample();
    renderPanel();
    const strip = within(clip()).getByTestId("clip-strip");
    expect(strip.style.getPropertyValue("--strip")).toMatch(/^linear-gradient\(to right, rgb\(/);
  });

  it("轨道折叠 / 展开与高度档位写入工程（可撤销），轨道区行高随之变化", () => {
    const { a } = loadSample();
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "切换 RGBW全彩灯 1 的轨道高度" }));
    expect(project().tracks[0].height).toBe("tall");
    expect(clip().style.height).toBe(`${72 - 4}px`);
    fireEvent.click(screen.getByRole("button", { name: "折叠 RGBW全彩灯 1" }));
    expect(project().tracks.find((tr) => tr.id === a)?.collapsed).toBe(true);
    expect(screen.getByRole("button", { name: "展开 RGBW全彩灯 1" }).getAttribute("aria-expanded")).toBe("false");
    expect(clip().style.height).toBe(`${20 - 4}px`);
    act(() => useProjectStore.temporal.getState().undo());
    expect(project().tracks[0].collapsed).toBeUndefined();
  });

  it("概览条：方向键翻页、Home / End 跳到两端", () => {
    loadSample();
    renderPanel();
    act(() => useTimelineScrollStore.getState().setViewWidth(500));
    const bar = screen.getByRole("scrollbar", { name: /全片概览/ });
    const el = screen.getByTestId("timeline-body");
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(el.scrollLeft).toBe(400);
    fireEvent.keyDown(bar, { key: "End" });
    // 内容宽 60 秒 × 100 px/s + 左右留白，减去视口宽
    expect(el.scrollLeft).toBe(START_LEFT * 2 + 6000 - 500);
    fireEvent.keyDown(bar, { key: "Home" });
    expect(el.scrollLeft).toBe(0);
  });
});

/** 挂上全局命令快捷键（时间线的键盘操作由命令表统一分发）。 */
function Hotkeys() {
  useEditorHotkeys();
  return null;
}

describe("TimelinePanel 键盘", () => {
  const group = () => screen.getByRole("group", { name: "轨道与 Cue" });
  const renderWithKeys = () =>
    render(
      <DndContext>
        <Hotkeys />
        <TimelinePanel />
      </DndContext>,
    );

  it("Delete 删除选中的 Cue（一步撤销），Esc 取消选择", () => {
    const { cueA } = loadSample();
    renderWithKeys();
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
    renderWithKeys();
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
    renderWithKeys();
    act(() => ui().selectCues([cueA]));
    fireEvent.keyDown(group(), { key: "d", ctrlKey: true });
    expect(project().cues.map((c) => [c.startMs, c.endMs]).sort((p, q) => p[0] - q[0])).toEqual([
      [1000, 3000],
      [3000, 5000],
    ]);
  });

  it("方向键把选中的 Cue 平移 1 帧，Shift 平移 10 帧；越界时不动", () => {
    const { cueA } = loadSample();
    renderWithKeys();
    act(() => ui().selectCues([cueA]));
    fireEvent.keyDown(group(), { key: "ArrowRight" });
    expect(project().cues[0]).toMatchObject({ startMs: 1033, endMs: 3033 });
    fireEvent.keyDown(group(), { key: "ArrowRight" });
    expect(project().cues[0].startMs).toBe(1067);
    fireEvent.keyDown(group(), { key: "ArrowLeft", shiftKey: true });
    expect(project().cues[0].startMs).toBe(733);
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(group(), { key: "ArrowLeft", shiftKey: true });
    expect(project().cues[0].startMs).toBeGreaterThanOrEqual(0);
    expect(project().cues[0].endMs - project().cues[0].startMs).toBe(2000);
  });

  it("焦点在输入框里时快捷键不生效", () => {
    const { cueA } = loadSample();
    renderWithKeys();
    act(() => ui().selectCues([cueA]));
    const input = document.createElement("input");
    group().appendChild(input);
    fireEvent.keyDown(input, { key: "Delete", bubbles: true });
    expect(project().cues).toHaveLength(1);
    expect(within(group()).queryByRole("textbox")).not.toBeNull();
  });

  it("轨道名称列：拖动右边缘加宽（松手才保存），方向键调整，双击恢复默认", () => {
    loadSample();
    act(() => {
      useEditorPrefsStore.setState({ trackHeaderWidth: 208 });
    });
    renderWithKeys();
    const sep = screen.getByRole("separator", { name: "轨道名称列宽度" });
    const column = sep.parentElement as HTMLElement;
    fireEvent.pointerDown(sep, { button: 0, clientX: 208, pointerId: 5 });
    fireEvent.pointerMove(sep, { clientX: 300, pointerId: 5 });
    expect(column.style.width).toBe("300px");
    expect(useEditorPrefsStore.getState().trackHeaderWidth).toBe(208);
    fireEvent.pointerUp(sep, { clientX: 300, pointerId: 5 });
    expect(useEditorPrefsStore.getState().trackHeaderWidth).toBe(300);
    fireEvent.pointerDown(sep, { button: 0, clientX: 300, pointerId: 6 });
    fireEvent.pointerMove(sep, { clientX: 2000, pointerId: 6 });
    fireEvent.pointerUp(sep, { pointerId: 6 });
    expect(useEditorPrefsStore.getState().trackHeaderWidth).toBe(480);
    fireEvent.keyDown(sep, { key: "ArrowLeft", shiftKey: true });
    expect(useEditorPrefsStore.getState().trackHeaderWidth).toBe(448);
    expect(sep.getAttribute("aria-valuenow")).toBe("448");
    fireEvent.doubleClick(sep);
    expect(useEditorPrefsStore.getState().trackHeaderWidth).toBe(208);
  });

  it("轨道头上的滚轮纵向滚动转交给轨道区", () => {
    loadSample();
    renderWithKeys();
    const headers = screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 1" }).closest("ul")?.parentElement as HTMLElement;
    fireEvent.wheel(headers, { deltaY: 40 });
    expect(screen.getByTestId("timeline-body").scrollTop).toBe(40);
  });
});

/** 带命令表的时间线（右键菜单的命令项来自命令表）。 */
function WithCommands() {
  const commands = useEditorHotkeys();
  return <TimelinePanel commands={commands} />;
}

describe("TimelinePanel 右键菜单与轨道多选", () => {
  const renderFull = () =>
    render(
      <DndContext>
        <WithCommands />
      </DndContext>,
    );
  const menu = () => screen.getByRole("menu", { name: "右键菜单" });

  it("右键片段：先选中它，菜单里执行“删除播放头左侧”", () => {
    const { cueA } = loadSample();
    act(() => ui().setPlayhead(2000));
    renderFull();
    fireEvent.contextMenu(clip(), { clientX: x(1500), clientY: y(0) });
    expect(ui().selectedCueIds).toEqual([cueA]);
    expect(within(menu()).getByRole("menuitem", { name: /剪切/ })).toBeTruthy();
    fireEvent.click(within(menu()).getByRole("menuitem", { name: /删除播放头左侧/ }));
    expect(project().cues.map((c) => [c.startMs, c.endMs])).toEqual([[2000, 3000]]);
  });

  it("右键轨道头删除灯具；轨道头 Ctrl / Shift 多选后按 Delete 一次删除全部（可撤销）", () => {
    const { b } = loadSample();
    act(() => useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1)));
    renderFull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 1" }));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "删除灯具及其轨道" }));
    expect(project().fixtures.map((f) => f.name)).toEqual(["RGBW全彩灯 2", "RGBW全彩灯 3"]);
    expect(project().cues).toHaveLength(0);

    const h2 = screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 2" });
    fireEvent.click(h2);
    fireEvent.click(screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 3" }), { shiftKey: true });
    expect(ui().selectedTrackIds).toHaveLength(2);
    expect(ui().selectedTrackIds).toContain(b);
    fireEvent.keyDown(h2, { key: "Delete" });
    expect(project().fixtures).toEqual([]);
    act(() => useProjectStore.temporal.getState().undo());
    expect(project().fixtures).toHaveLength(2);
  });

  it("多轨编辑：多选轨道后双击空白处，在每条轨道上各建一个（一步撤销）；粘贴到全部选中轨道", () => {
    const { a, b, cueA } = loadSample();
    renderFull();
    fireEvent.click(screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 1" }));
    fireEvent.click(screen.getByRole("button", { name: "选择轨道 RGBW全彩灯 2" }), { ctrlKey: true });
    const steps = useProjectStore.temporal.getState().pastStates.length;
    // 第一下单击不应把多选收成单选
    fireEvent.pointerDown(body(), { button: 0, clientX: x(10_000), clientY: y(1) });
    fireEvent.pointerUp(body(), { clientX: x(10_000), clientY: y(1) });
    expect(ui().selectedTrackIds).toEqual([a, b]);
    fireEvent.doubleClick(body(), { clientX: x(10_000), clientY: y(1) });
    const added = project().cues.filter((c) => c.startMs === 10_000);
    expect(added.map((c) => c.trackId).sort()).toEqual([a, b].sort());
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);

    act(() => {
      ui().selectCues([cueA]);
      ui().setPlayhead(20_000);
    });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    expect(project().cues.filter((c) => c.startMs === 20_000).map((c) => c.trackId).sort()).toEqual([a, b].sort());
  });

  it("按灯具类型：轨道头显示类型图标；外观片段显示属性徽标，没有灯支持的层给出警告", () => {
    const { a } = loadSample();
    act(() =>
      useProjectStore.getState().update((d) => {
        addLookCue(d, a, 5000, { intensity: fixed(100), color: fixed({ kind: "rgb", rgb: [0, 0, 255] }), attrs: { pan: fixed(0.5) } }, 2000);
      }),
    );
    renderFull();
    expect(screen.getAllByRole("img", { name: "混色灯" })).toHaveLength(2);
    const look = screen.getByRole("button", { name: /00:05\.00/ });
    expect(look.getAttribute("aria-label")).toContain("没有灯支持：水平 Pan");
    expect(within(look).getByTestId("clip-warning")).toBeTruthy();
    expect([...look.querySelectorAll("[data-badge]")].map((el) => el.getAttribute("data-badge"))).toEqual(["color", "position"]);
  });

  it("按住 Ctrl 松手：复制到新位置，原片段不动并选中副本", () => {
    const { cueA, b } = loadSample();
    renderFull();
    // 拖动预览时片段的无障碍名称会随轨道变化，先拿住元素
    const el = clip();
    fireEvent.pointerDown(el, { button: 0, clientX: x(1500), clientY: y(0), pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: x(5500), clientY: y(1), pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: x(5500), clientY: y(1), pointerId: 1, ctrlKey: true });
    expect(project().cues.find((c) => c.id === cueA)).toMatchObject({ startMs: 1000, endMs: 3000 });
    const copy = project().cues.find((c) => c.id !== cueA);
    expect(copy).toMatchObject({ trackId: b, startMs: 5000, endMs: 7000 });
    expect(ui().selectedCueIds).toEqual([copy?.id]);
  });
});

describe("时间线标记类对象的删除", () => {
  const renderFull = () =>
    render(
      <DndContext>
        <WithCommands />
      </DndContext>,
    );
  const menu = () => screen.getByRole("menu", { name: "右键菜单" });
  const flag = () => screen.getByRole("button", { name: /^标记点 副歌/ });

  /** 加一个 1 秒处的标记“副歌”、0~4 秒的段落“主歌”、2~6 秒的循环区间。 */
  function withObjects() {
    loadSample();
    act(() =>
      useProjectStore.getState().update((d) => {
        d.markers.push({ id: "mk", timeMs: 1000, label: "副歌" });
        d.sections.push({ id: "sc", name: "主歌", startMs: 0, endMs: 4000, color: [0, 0, 255] });
        d.loopRange = { startMs: 2000, endMs: 6000 };
      }),
    );
    toast.mockReset();
  }

  it("点选标记后按 Delete 删除（与片段选择互斥），提示里的“撤销”能恢复", () => {
    withObjects();
    renderFull();
    act(() => ui().selectCues([project().cues[0].id]));
    fireEvent.pointerDown(flag(), { button: 0, clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(flag(), { clientX: 0, pointerId: 1 });
    expect(ui().selectedTimelineObject).toEqual({ kind: "marker", id: "mk" });
    expect(ui().selectedCueIds).toEqual([]);
    expect(flag().getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(window, { key: "Delete" });
    expect(project().markers).toEqual([]);
    expect(project().cues).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith("已删除标记 副歌", expect.objectContaining({ action: expect.objectContaining({ label: "撤销" }) }));
    const [, options] = toast.mock.lastCall as [string, { action: { onClick: () => void } }];
    act(() => options.action.onClick());
    expect(project().markers.map((m) => m.label)).toEqual(["副歌"]);
  });

  it("悬停 × 删除标记与段落；循环带中间的 × 清除循环区间；循环手柄上按 Delete 也能清除", () => {
    withObjects();
    renderFull();
    fireEvent.click(screen.getByRole("button", { name: "删除标记 副歌" }));
    expect(project().markers).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "删除段落 主歌" }));
    expect(project().sections).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "清除循环区间" }));
    expect(project().loopRange).toBeNull();
    expect(toast).toHaveBeenCalledTimes(3);
    act(() => useProjectStore.getState().update((d) => void (d.loopRange = { startMs: 2000, endMs: 6000 })));
    fireEvent.keyDown(screen.getByRole("slider", { name: /循环入点/ }), { key: "Delete" });
    expect(project().loopRange).toBeNull();
  });

  it("右键标记 → 删除；右键段落 → 设为循环区间；右键循环区间 → 清除", () => {
    withObjects();
    renderFull();
    fireEvent.contextMenu(flag());
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "删除标记" }));
    expect(project().markers).toEqual([]);

    fireEvent.contextMenu(screen.getByRole("button", { name: /^段落 主歌/ }));
    expect(ui().selectedTimelineObject).toEqual({ kind: "section", id: "sc" });
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "设为循环区间" }));
    expect(project().loopRange).toEqual({ startMs: 0, endMs: 4000 });

    fireEvent.contextMenu(document.querySelector("[data-loop]") as HTMLElement);
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "清除循环区间" }));
    expect(project().loopRange).toBeNull();
  });

  it("片段上的关键帧：点击只移播放头不拖动；右键删除这个关键帧", () => {
    const { a } = loadSample();
    let id = "";
    act(() =>
      useProjectStore.getState().update((d) => {
        id =
          addLookCue(
            d,
            a,
            10_000,
            {
              intensity: {
                kind: "keys",
                keys: [
                  { tMs: 0, value: 0, curve: "linear" },
                  { tMs: 1000, value: 100, curve: "linear" },
                  { tMs: 2000, value: 50, curve: "linear" },
                ],
              },
            },
            3000,
          ) ?? "";
      }),
    );
    renderFull();
    const keys = () => screen.getAllByTestId("clip-key").filter((k) => k.closest(`[data-cue-id="${id}"]`));
    const second = keys()[1];
    fireEvent.pointerDown(second, { button: 0, clientX: x(11_000), clientY: y(0), pointerId: 1 });
    fireEvent.pointerMove(second, { clientX: x(15_000), clientY: y(0), pointerId: 1 });
    fireEvent.pointerUp(second, { clientX: x(15_000), clientY: y(0), pointerId: 1 });
    expect(project().cues.find((c) => c.id === id)?.startMs).toBe(10_000);
    expect(ui().playheadMs).toBe(11_000);
    expect(ui().selectedCueIds).toEqual([id]);

    fireEvent.contextMenu(keys()[1]);
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "删除这个关键帧" }));
    const cue = project().cues.find((c) => c.id === id);
    expect(cue?.kind === "look" && cue.look.intensity?.kind === "keys" && cue.look.intensity.keys.map((k) => k.tMs)).toEqual([0, 2000]);
  });
});
