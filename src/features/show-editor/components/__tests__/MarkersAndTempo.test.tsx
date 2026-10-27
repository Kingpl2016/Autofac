// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { addStaticCue } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { fakeFile, RGBW } from "../../lib/__tests__/testkit";
import {
  addMarkerAtPlayhead,
  alignBeatToPlayhead,
  resetTaps,
  tapTempoNow,
} from "../../hooks/editorActions";
import { useEditorHotkeys } from "../../hooks/useEditorHotkeys";
import { CueBlock } from "../../timeline/CueBlock";
import { MarkerStrip } from "../../timeline/MarkerStrip";
import { useTimelineScrollStore } from "../../timeline/timelineScrollStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
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
  // jsdom 没有指针捕获 API
  HTMLElement.prototype.setPointerCapture = () => undefined;
});

const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(createEmptyProject("t"));
  useEditorUiStore.setState({ playheadMs: 0, snapEnabled: true, pxPerSec: 160, selectedCueIds: [] });
  useTimelineScrollStore.setState({ left: 0, top: 0 });
  useAnnouncerStore.setState({ message: "", seq: 0 });
  resetTaps();
});

afterEach(() => cleanup());

describe("编辑器动作", () => {
  it("在播放头处打标记点：自动命名、同一帧不重复，并播报", () => {
    act(() => ui().setPlayhead(2000));
    expect(addMarkerAtPlayhead()).not.toBeNull();
    expect(project().markers).toMatchObject([{ timeMs: 2000, label: "标记 1" }]);
    expect(useAnnouncerStore.getState().message).toBe("已在播放头处添加标记点");
    expect(addMarkerAtPlayhead()).toBeNull();
    expect(project().markers).toHaveLength(1);
    expect(useAnnouncerStore.getState().message).toBe("播放头处已经有标记点");
  });

  it("敲击节拍：第二次敲击起得到 BPM，保留已有的偏移与拍号", () => {
    expect(tapTempoNow(1000)).toBeNull();
    expect(project().tempo).toBeNull();
    expect(tapTempoNow(1500)).toBe(120);
    expect(project().tempo).toEqual({ bpm: 120, offsetMs: 0, beatsPerBar: 4 });
    act(() =>
      useProjectStore.getState().update((d) => {
        d.tempo = { bpm: 120, offsetMs: 250, beatsPerBar: 3 };
      }),
    );
    expect(tapTempoNow(2100)).not.toBeNull();
    expect(project().tempo).toMatchObject({ offsetMs: 250, beatsPerBar: 3 });
    expect(useAnnouncerStore.getState().message).toMatch(/节拍已更新为 .* BPM/);
  });

  it("第一拍对齐到播放头；没有节拍时按 120 BPM、4/4 新建", () => {
    act(() => ui().setPlayhead(750));
    alignBeatToPlayhead();
    expect(project().tempo).toEqual({ bpm: 120, offsetMs: 750, beatsPerBar: 4 });
  });
});

function Harness() {
  useEditorHotkeys();
  return <input aria-label="文本框" />;
}

describe("全局快捷键", () => {
  it("M 打标记点，S 开关吸附，T 敲击节拍", () => {
    render(<Harness />);
    act(() => ui().setPlayhead(1000));
    fireEvent.keyDown(window, { key: "m" });
    expect(project().markers).toHaveLength(1);
    fireEvent.keyDown(window, { key: "s" });
    expect(ui().snapEnabled).toBe(false);
    fireEvent.keyDown(window, { key: "s" });
    expect(ui().snapEnabled).toBe(true);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1500);
    fireEvent.keyDown(window, { key: "t" });
    expect(project().tempo).toBeNull();
    fireEvent.keyDown(window, { key: "t" });
    expect(project().tempo?.bpm).toBe(120);
    now.mockRestore();
  });

  it("焦点在输入框里、对话框打开、带修饰键或长按时不触发", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByLabelText("文本框"), { key: "m" });
    expect(project().markers).toHaveLength(0);

    fireEvent.keyDown(window, { key: "m", altKey: true });
    fireEvent.keyDown(window, { key: "m", repeat: true });
    expect(project().markers).toHaveLength(0);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: "m" });
    expect(project().markers).toHaveLength(0);
    dialog.remove();
    fireEvent.keyDown(window, { key: "m" });
    expect(project().markers).toHaveLength(1);
  });

  it("Ctrl+Z / Ctrl+Y 撤销重做", () => {
    render(<Harness />);
    act(() => ui().setPlayhead(1000));
    fireEvent.keyDown(window, { key: "m" });
    expect(project().markers).toHaveLength(1);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(project().markers).toHaveLength(0);
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(project().markers).toHaveLength(1);
  });
});

describe("标记点条", () => {
  const withMarkers = () => {
    useProjectStore.getState().load(
      produce(createEmptyProject("t"), (d) => {
        d.markers.push({ id: "m1", timeMs: 2000, label: "副歌" }, { id: "m2", timeMs: 6000, label: "桥段" });
      }),
    );
  };

  it("按时间位置摆放，并随缩放和滚动移动", () => {
    withMarkers();
    const { container, rerender } = render(<MarkerStrip />);
    const left = () => [...container.querySelectorAll<HTMLElement>("div.absolute")].map((n) => n.style.left);
    // 20（左留白）+ 2 秒 × 160
    expect(left()).toEqual(["340px", "980px"]);
    act(() => useTimelineScrollStore.getState().set(300, 0));
    rerender(<MarkerStrip />);
    expect(left()).toEqual(["40px", "680px"]);
    act(() => ui().setPxPerSec(100));
    rerender(<MarkerStrip />);
    expect(left()).toEqual(["-80px", "320px"]);
  });

  it("点击定位播放头；Delete 删除；Enter 改名", () => {
    withMarkers();
    render(<MarkerStrip />);
    const flag = screen.getByRole("button", { name: /标记点 副歌/ });
    fireEvent.pointerDown(flag, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(flag, { clientX: 101, pointerId: 1 });
    expect(ui().playheadMs).toBe(2000);

    fireEvent.keyDown(flag, { key: "Enter" });
    const input = screen.getByLabelText("标记点名称");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "间奏" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(project().markers[0].label).toBe("间奏");

    fireEvent.keyDown(screen.getByRole("button", { name: /标记点 间奏/ }), { key: "Delete" });
    expect(project().markers.map((m) => m.id)).toEqual(["m2"]);
  });

  it("拖动改变位置（一步撤销）；拖到已有标记的帧上被拒绝", () => {
    withMarkers();
    render(<MarkerStrip />);
    const flag = screen.getByRole("button", { name: /标记点 副歌/ });
    fireEvent.pointerDown(flag, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(flag, { clientX: 260, pointerId: 1 });
    fireEvent.pointerUp(flag, { clientX: 260, pointerId: 1 });
    // 160px = 1 秒
    expect(project().markers.find((m) => m.id === "m1")?.timeMs).toBe(3000);
    expect(ui().playheadMs).toBe(0);

    const second = screen.getByRole("button", { name: /标记点 桥段/ });
    const before = project().markers.map((m) => m.timeMs);
    fireEvent.pointerDown(second, { clientX: 0, pointerId: 2 });
    fireEvent.pointerMove(second, { clientX: -480, pointerId: 2 });
    fireEvent.pointerUp(second, { clientX: -480, pointerId: 2 });
    // 左移 3 秒正好落在 3000，已被占用
    expect(project().markers.map((m) => m.timeMs)).toEqual(before);
  });
});

describe("工具条：节拍与标记点", () => {
  it("显示当前 BPM；添加标记点按钮；撤销 / 重做仍可用", () => {
    render(<EditorToolbar file={fakeFile()} />);
    expect(screen.getByRole("button", { name: "节拍" }).textContent).toContain("节拍");
    act(() => ui().setPlayhead(1000));
    fireEvent.click(screen.getByRole("button", { name: "在播放头处添加标记点" }));
    expect(project().markers).toHaveLength(1);
    act(() =>
      useProjectStore.getState().update((d) => {
        d.tempo = { bpm: 128, offsetMs: 0, beatsPerBar: 4 };
      }),
    );
    expect(screen.getByRole("button", { name: "节拍" }).textContent).toContain("128 BPM");
  });

  it("节拍弹层：编辑 BPM / 偏移 / 拍号、对齐到播放头、清除", async () => {
    render(<EditorToolbar file={fakeFile()} />);
    fireEvent.click(screen.getByRole("button", { name: "节拍" }));
    const popover = await screen.findByRole("dialog");
    const bpm = within(popover).getByLabelText("BPM");
    fireEvent.change(bpm, { target: { value: "90" } });
    fireEvent.blur(bpm);
    expect(project().tempo).toEqual({ bpm: 90, offsetMs: 0, beatsPerBar: 4 });

    const bars = within(popover).getByLabelText("每小节拍数");
    fireEvent.change(bars, { target: { value: "3" } });
    fireEvent.blur(bars);
    expect(project().tempo?.beatsPerBar).toBe(3);

    act(() => ui().setPlayhead(1500));
    fireEvent.click(within(popover).getByRole("button", { name: "第一拍对齐到播放头" }));
    expect(project().tempo).toEqual({ bpm: 90, offsetMs: 1500, beatsPerBar: 3 });

    fireEvent.click(within(popover).getByRole("button", { name: "清除节拍" }));
    expect(project().tempo).toBeNull();
    expect((within(popover).getByRole("button", { name: "清除节拍" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Cue 块的淡入淡出手柄", () => {
  function setup(selected: boolean, locked = false) {
    let id = "";
    useProjectStore.getState().load(
      produce(createEmptyProject("t"), (d) => {
        addFixtures(d, RGBW, 1);
        d.durationMs = 60_000;
        id = addStaticCue(d, d.tracks[0].id, 0, { lengthMs: 4000, fadeInMs: 500, fadeOutMs: 500 }) ?? "";
      }),
    );
    const cue = project().cues[0];
    const view = render(<CueBlock cue={cue} dimmed={false} selected={selected} locked={locked} />);
    return { id, view };
  }

  it("只有选中且未锁定时才显示手柄", () => {
    setup(false);
    expect(screen.queryAllByTitle(/拖动调整/)).toHaveLength(0);
    cleanup();
    setup(true, true);
    expect(screen.queryAllByTitle(/拖动调整/)).toHaveLength(0);
    cleanup();
    setup(true);
    expect(screen.getAllByTitle(/拖动调整/)).toHaveLength(2);
  });

  it("拖动淡入手柄：松手时提交一步，像素按缩放换算成时长", () => {
    const { id } = setup(true);
    const before = useProjectStore.temporal.getState().pastStates.length;
    const handle = screen.getByTitle("拖动调整淡入时长");
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    // 80px ÷ 160px/s = 500ms，淡入 500 → 1000，中途不写入工程
    expect(project().cues.find((c) => c.id === id)?.fadeInMs).toBe(500);
    fireEvent.pointerUp(handle, { clientX: 180, pointerId: 1 });
    expect(project().cues.find((c) => c.id === id)?.fadeInMs).toBe(1000);
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(before + 1);
  });

  it("淡出手柄方向相反，且不能让淡入淡出超过 Cue 长度", () => {
    const { id } = setup(true);
    const handle = screen.getByTitle("拖动调整淡出时长");
    // 向左拖 = 淡出变长；拖很远也只能到 4000 - 500
    fireEvent.pointerDown(handle, { clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -5000, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -5000, pointerId: 1 });
    expect(project().cues.find((c) => c.id === id)).toMatchObject({ fadeInMs: 500, fadeOutMs: 3500 });
  });

  it("没有实际变化时不产生历史", () => {
    setup(true);
    const before = useProjectStore.temporal.getState().pastStates.length;
    const handle = screen.getByTitle("拖动调整淡入时长");
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(before);
  });
});
