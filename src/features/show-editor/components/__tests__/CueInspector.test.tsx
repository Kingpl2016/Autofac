// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { addStaticCue } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
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
});

const project = () => useProjectStore.getState().project;
const steps = () => useProjectStore.temporal.getState().pastStates.length;

/** 两条轨道：第一条上有两个 Cue（亮度 100 / 40），第二条上有一个。 */
function load(): { c1: string; c2: string; c3: string } {
  let c1 = "";
  let c2 = "";
  let c3 = "";
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 60_000;
      c1 = addStaticCue(d, d.tracks[0].id, 1000, { lengthMs: 2000, rgb: [255, 0, 0] }) ?? "";
      c2 = addStaticCue(d, d.tracks[0].id, 5000, { lengthMs: 2000, rgb: [0, 255, 0], brightness: 40 }) ?? "";
      c3 = addStaticCue(d, d.tracks[1].id, 0, { lengthMs: 3000 }) ?? "";
    }),
  );
  return { c1, c2, c3 };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(createEmptyProject("t"));
  useEditorUiStore.setState({ selectedCueIds: [], selectedTrackId: null });
});

afterEach(() => cleanup());

describe("CueInspector", () => {
  it("没有选中 Cue 时给出提示", () => {
    render(<CueInspector />);
    expect(screen.getByText("选中一个 Cue 或灯具以编辑属性")).toBeTruthy();
  });

  it("单选：显示所属灯具、颜色、亮度、淡入淡出、缓动和时间", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    expect(screen.getByRole("heading", { name: "RGBW全彩灯 1" })).toBeTruthy();
    expect((screen.getByLabelText("红（数值）") as HTMLInputElement).value).toBe("255");
    expect((screen.getByLabelText("亮度（数值）") as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText("起点") as HTMLInputElement).value).toBe("00:01.00");
    expect((screen.getByLabelText("长度") as HTMLInputElement).value).toBe("00:02.00");
    expect(screen.getByRole("radio", { name: "线性" }).getAttribute("aria-checked")).toBe("true");
  });

  it("亮度：拖动滑杆只改草稿，松手时提交一步", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    const before = steps();
    const slider = screen.getByLabelText("亮度", { selector: "input[type=range]" });
    fireEvent.change(slider, { target: { value: "70" } });
    fireEvent.change(slider, { target: { value: "55" } });
    expect(project().cues.find((c) => c.id === c1)?.brightness).toBe(100);
    expect((screen.getByLabelText("亮度（数值）") as HTMLInputElement).value).toBe("55");
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(project().cues.find((c) => c.id === c1)?.brightness).toBe(55);
    expect(steps()).toBe(before + 1);
  });

  it("键盘调整滑杆：抬起按键时提交", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    const slider = screen.getByLabelText("亮度", { selector: "input[type=range]" });
    fireEvent.change(slider, { target: { value: "99" } });
    fireEvent.keyUp(slider, { key: "ArrowLeft" });
    expect(project().cues.find((c) => c.id === c1)?.brightness).toBe(99);
  });

  it("数字框：失焦提交，超出范围被夹住，非数字忽略", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    const box = screen.getByLabelText("亮度（数值）");
    fireEvent.change(box, { target: { value: "250" } });
    fireEvent.blur(box);
    expect(project().cues.find((c) => c.id === c1)?.brightness).toBe(100);
    fireEvent.change(box, { target: { value: "30" } });
    fireEvent.blur(box);
    expect(project().cues.find((c) => c.id === c1)?.brightness).toBe(30);
    const before = steps();
    fireEvent.change(box, { target: { value: "abc" } });
    fireEvent.blur(box);
    expect(steps()).toBe(before);
  });

  it("淡入淡出不能超过 Cue 长度", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    const fadeIn = screen.getByLabelText("淡入（数值）");
    fireEvent.change(fadeIn, { target: { value: "1500" } });
    fireEvent.blur(fadeIn);
    const fadeOut = screen.getByLabelText("淡出（数值）");
    fireEvent.change(fadeOut, { target: { value: "1500" } });
    fireEvent.blur(fadeOut);
    const cue = project().cues.find((c) => c.id === c1);
    expect(cue).toMatchObject({ fadeInMs: 1500, fadeOutMs: 500 });
  });

  it("缓动曲线用分段选择器切换", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    fireEvent.click(screen.getByRole("radio", { name: "S 曲线" }));
    expect(project().cues.find((c) => c.id === c1)?.easing).toBe("sCurve");
    expect(screen.getByRole("radio", { name: "S 曲线" }).getAttribute("aria-checked")).toBe("true");
  });

  it("颜色分量：提交后写入，超出 0~255 的值被夹住", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    const green = screen.getByLabelText("绿（数值）");
    fireEvent.change(green, { target: { value: "128" } });
    fireEvent.blur(green);
    const blue = screen.getByLabelText("蓝（数值）");
    fireEvent.change(blue, { target: { value: "999" } });
    fireEvent.blur(blue);
    const cue = project().cues.find((c) => c.id === c1);
    expect(cue?.kind === "static" && cue.rgb).toEqual([255, 128, 255]);
  });

  it("时间：改起点平移 Cue；与别的 Cue 冲突或格式不对时被忽略", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    const start = screen.getByLabelText("起点");
    fireEvent.change(start, { target: { value: "00:10.00" } });
    fireEvent.blur(start);
    expect(project().cues.find((c) => c.id === c1)).toMatchObject({ startMs: 10_000, endMs: 12_000 });

    fireEvent.change(screen.getByLabelText("起点"), { target: { value: "00:04.00" } });
    fireEvent.blur(screen.getByLabelText("起点"));
    // 4~6 秒会压住 5~7 秒的另一个 Cue
    expect(project().cues.find((c) => c.id === c1)?.startMs).toBe(10_000);
    fireEvent.change(screen.getByLabelText("起点"), { target: { value: "乱写" } });
    fireEvent.blur(screen.getByLabelText("起点"));
    expect(project().cues.find((c) => c.id === c1)?.startMs).toBe(10_000);
  });

  it("时间：改长度与终点", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    const length = screen.getByLabelText("长度");
    fireEvent.change(length, { target: { value: "00:03.00" } });
    fireEvent.blur(length);
    expect(project().cues.find((c) => c.id === c1)).toMatchObject({ startMs: 1000, endMs: 4000 });
    const end = screen.getByLabelText("终点");
    fireEvent.change(end, { target: { value: "00:03.00" } });
    fireEvent.blur(end);
    expect(project().cues.find((c) => c.id === c1)).toMatchObject({ startMs: 1000, endMs: 3000 });
  });

  it("多选：批量修改，值不一致时标注“混合值”，不显示时间字段", () => {
    const { c1, c2, c3 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1, c2, c3]));
    render(<CueInspector />);
    expect(screen.getByRole("heading", { name: "已选 3 个 Cue" })).toBeTruthy();
    expect(screen.queryByLabelText("起点")).toBeNull();
    // 颜色（红 / 绿 / 白）和亮度（100 / 40）不一致，淡入淡出和缓动一致
    expect(screen.getAllByText("（混合值）")).toHaveLength(2);

    const box = screen.getByLabelText("亮度（数值）");
    const before = steps();
    fireEvent.change(box, { target: { value: "20" } });
    fireEvent.blur(box);
    expect(project().cues.map((c) => c.brightness)).toEqual([20, 20, 20]);
    expect(steps()).toBe(before + 1);
  });

  it("所在轨道被锁定时提示且修改无效", () => {
    const { c1 } = load();
    act(() => {
      useProjectStore.getState().update((d) => {
        d.tracks[0].lock = true;
      });
      useEditorUiStore.getState().selectCues([c1]);
    });
    render(<CueInspector />);
    expect(screen.getByText("所在轨道已锁定，不能修改")).toBeTruthy();
    const box = screen.getByLabelText("亮度（数值）");
    fireEvent.change(box, { target: { value: "10" } });
    fireEvent.blur(box);
    expect(project().cues.find((c) => c.id === c1)?.brightness).toBe(100);
  });

  it("选中的 Cue 被删除后回到空状态", () => {
    const { c1 } = load();
    act(() => useEditorUiStore.getState().selectCues([c1]));
    render(<CueInspector />);
    act(() =>
      useProjectStore.getState().update((d) => {
        d.cues = [];
      }),
    );
    expect(screen.getByText("选中一个 Cue 或灯具以编辑属性")).toBeTruthy();
  });
});
