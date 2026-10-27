// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { fixed } from "../../lib/looks";
import { addFixtures, createGroup } from "../../lib/ops";
import { createEmptyProject, type Cue, type LookClip } from "../../lib/project";
import { HEAD16 } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProgrammerStore } from "../../stores/useProgrammerStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { CueInspector } from "../CueInspector";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Radix Select 在 jsdom 里需要这些 API
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
  loadTestEngine();
});

const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();
const cueById = (id: string) => project().cues.find((c) => c.id === id) as Cue;

const lookClip = (id: string, trackId: string, look: LookClip["look"], startMs = 0): LookClip => ({
  id,
  kind: "look",
  trackId,
  startMs,
  endMs: startMs + 4000,
  brightness: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  easing: "linear",
  look,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, HEAD16, 3);
      d.durationMs = 20_000;
      createGroup(d, "全部", d.fixtures.map((f) => f.id));
      d.cues.push(lookClip("a", d.tracks[0].id, { intensity: fixed(100), attrs: { pan: fixed(0.25) } }));
      d.cues.push(lookClip("b", d.tracks[1].id, { intensity: fixed(10) }));
      d.cues.push(lookClip("g", d.tracks.at(-1)!.id, { intensity: fixed(100) }, 5000));
      d.tracks.push({ id: "st", target: { kind: "scene" }, mute: false, solo: false, lock: false });
      d.cues.push({
        id: "s",
        kind: "scene",
        trackId: "st",
        startMs: 0,
        endMs: 2000,
        brightness: 100,
        fadeInMs: 0,
        fadeOutMs: 0,
        easing: "linear",
        entries: [
          { fixtureId: d.fixtures[0].id, look: { intensity: fixed(50) } },
          { fixtureId: d.fixtures[2].id, look: { attrs: { tilt: fixed(1) } } },
        ],
      });
    }),
  );
  useEditorUiStore.setState({ selectedCueIds: ["a"], playheadMs: 1000, lookClipboard: null });
  useProgrammerStore.getState().clear();
});

afterEach(() => cleanup());

describe("属性层", () => {
  it("列出已有的位置层，改值、删除；按模型添加新层", () => {
    render(<CueInspector />);
    const layers = screen.getByRole("region", { name: "属性层" });
    const pan = within(layers).getByRole("textbox", { name: "水平 Pan 的数值" });
    expect((pan as HTMLInputElement).value).toBe("25");
    fireEvent.change(pan, { target: { value: "75" } });
    fireEvent.blur(pan);
    const a = cueById("a");
    expect(a.kind === "look" && a.look.attrs?.pan).toEqual(fixed(0.75));

    fireEvent.click(within(layers).getByRole("button", { name: "删除 水平 Pan 层" }));
    const after = cueById("a");
    expect(after.kind === "look" && after.look.attrs).toBeUndefined();
    expect(within(layers).getByRole("combobox", { name: "添加属性层…" })).toBeTruthy();
  });
});

describe("选择性复制粘贴", () => {
  it("复制外观，只勾选位置层粘贴到另一个片段", () => {
    render(<CueInspector />);
    fireEvent.click(screen.getByRole("button", { name: "复制外观" }));
    expect(ui().lookClipboard).toEqual({ intensity: fixed(100), attrs: { pan: fixed(0.25) } });
    act(() => ui().selectCues(["b"]));
    fireEvent.click(screen.getByRole("checkbox", { name: "强度" }));
    fireEvent.click(screen.getByRole("button", { name: "粘贴所选层" }));
    const b = cueById("b");
    expect(b.kind === "look" && b.look).toEqual({ intensity: fixed(10), attrs: { pan: fixed(0.25) } });
  });
});

describe("多灯分布", () => {
  it("单灯轨道给提示；分组轨道上设置强度扇形与时间级联", () => {
    render(<CueInspector />);
    expect(screen.getByText(/这条轨道只驱动一台灯/)).toBeTruthy();
    act(() => ui().selectCues(["g"]));
    const wings = screen.getByRole("textbox", { name: "分翼" });
    fireEvent.change(wings, { target: { value: "2" } });
    fireEvent.blur(wings);
    const delay = screen.getByRole("textbox", { name: "最后一台的延迟（毫秒）" });
    fireEvent.change(delay, { target: { value: "600" } });
    fireEvent.blur(delay);
    const g = cueById("g");
    expect(g.kind === "look" && g.spread).toEqual({ wings: 2, delay: { fromMs: 0, toMs: 600 } });
    fireEvent.click(screen.getByRole("button", { name: "清除分布" }));
    const cleared = cueById("g");
    expect(cleared.kind === "look" && cleared.spread).toBeUndefined();
  });
});

describe("场景片段", () => {
  it("列出条目；载入编程器后修改，再用编程器更新回片段；可移除条目", () => {
    act(() => ui().selectCues(["s"]));
    render(<CueInspector />);
    const scene = screen.getByRole("region", { name: "场景条目" });
    expect(within(scene).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(scene).getByRole("button", { name: "载入编程器" }));
    const ids = project().fixtures.map((f) => f.id);
    expect(ui().selectedFixtureIds).toEqual([ids[0], ids[2]]);
    expect(ui().inspectorTab).toBe("program");
    act(() =>
      useProgrammerStore.getState().setValues({
        ...useProgrammerStore.getState().values,
        [ids[1]]: { intensity: fixed(33) },
      }),
    );
    fireEvent.click(within(scene).getByRole("button", { name: "用编程器更新" }));
    const s = cueById("s");
    expect(s.kind === "scene" && s.entries.map((e) => e.fixtureId)).toEqual(ids);
    fireEvent.click(within(scene).getByRole("button", { name: /从场景移除 通用16CH摇头灯 2/ }));
    const s2 = cueById("s");
    expect(s2.kind === "scene" && s2.entries).toHaveLength(2);
  });
});
