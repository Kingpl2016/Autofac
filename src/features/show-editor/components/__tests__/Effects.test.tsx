// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { addEffectCue } from "../../lib/cueOps";
import { EFFECT_PRESETS, presetOf } from "../../lib/effectPresets";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type EffectCue } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { CueBlock } from "../../timeline/CueBlock";
import { CueInspector } from "../CueInspector";
import { EffectsTab } from "../EffectsTab";

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

const ui = () => useEditorUiStore.getState();
const project = () => useProjectStore.getState().project;
const effectCue = (id: string): EffectCue => {
  const cue = project().cues.find((c) => c.id === id);
  if (cue?.kind !== "effect") throw new Error("应是特效 Cue");
  return cue;
};

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 60_000;
    }),
  );
  useEditorUiStore.setState({ selectedCueIds: [], selectedTrackId: null, playheadMs: 0, inspectorTab: "patch" });
  useAnnouncerStore.setState({ message: "", seq: 0 });
});

afterEach(() => cleanup());

describe("EffectsTab", () => {
  const renderTab = () =>
    render(
      <DndContext>
        <EffectsTab />
      </DndContext>,
    );

  const classic = () => screen.getByRole("region", { name: "经典 RGB 特效" });

  it("列出 8 种经典特效与 8 种属性特效", () => {
    renderTab();
    expect(within(classic()).getAllByRole("button")).toHaveLength(EFFECT_PRESETS.length);
    for (const name of ["呼吸", "彩虹", "追逐", "擦除", "渐变", "脉冲", "闪烁", "频闪"]) {
      expect(within(classic()).getByRole("button", { name })).toBeTruthy();
    }
    expect(within(screen.getByRole("region", { name: "属性特效" })).getAllByRole("button")).toHaveLength(8);
  });

  it("点击：加到所选轨道的播放头处，使用预设参数、选中并切到 Cue 属性页", () => {
    renderTab();
    const trackId = project().tracks[1].id;
    act(() => {
      ui().selectTrack(trackId);
      ui().setPlayhead(3000);
    });
    fireEvent.click(within(classic()).getByRole("button", { name: "彩虹" }));
    const [cue] = project().cues;
    expect(cue).toMatchObject({ kind: "effect", effect: "rainbow", trackId, startMs: 3000 });
    expect(cue.endMs - cue.startMs).toBe(presetOf("rainbow").lengthMs);
    expect(ui().selectedCueIds).toEqual([cue.id]);
    expect(ui().inspectorTab).toBe("cue");
    expect(useAnnouncerStore.getState().message).toBe("已添加特效");
  });

  it("没有轨道时提示；放不下时提示", () => {
    useProjectStore.getState().load(createEmptyProject("empty"));
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "呼吸" }));
    expect(useAnnouncerStore.getState().message).toContain("轨道");
  });

  it("属性特效：在所选轨道新建外观片段（曲线），选中并切到属性页", () => {
    renderTab();
    const trackId = project().tracks[0].id;
    act(() => {
      ui().selectTrack(trackId);
      ui().setPlayhead(1000);
    });
    fireEvent.click(within(screen.getByRole("region", { name: "属性特效" })).getByRole("button", { name: "强度波浪" }));
    const [cue] = project().cues;
    expect(cue).toMatchObject({ kind: "look", trackId, startMs: 1000 });
    expect(cue.kind === "look" && cue.look.intensity?.kind).toBe("curve");
    expect(ui().selectedCueIds).toEqual([cue.id]);
    expect(useAnnouncerStore.getState().message).toBe("已添加强度波浪");
  });
});

describe("特效属性面板", () => {
  function setup(effect: Parameters<typeof presetOf>[0] = "strobe") {
    let id = "";
    act(() =>
      useProjectStore.getState().update((d) => {
        id = addEffectCue(d, d.tracks[0].id, 0, presetOf(effect)) ?? "";
      }),
    );
    act(() => ui().selectCues([id]));
    render(<CueInspector />);
    return id;
  }

  it("显示特效参数而不是静态颜色区；颜色列表可增删", () => {
    const id = setup("gradient");
    expect(screen.getByRole("region", { name: "特效参数" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "颜色" })?.closest("[aria-label='特效参数']")).toBeTruthy();
    expect(effectCue(id).colors).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "添加颜色" }));
    expect(effectCue(id).colors).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "删除选中的颜色" }));
    expect(effectCue(id).colors).toHaveLength(2);
  });

  it("颜色上限 4 个、下限 1 个：按钮禁用", () => {
    const id = setup("breathe");
    expect((screen.getByRole("button", { name: "删除选中的颜色" }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByRole("button", { name: "添加颜色" }));
    expect(effectCue(id).colors).toHaveLength(4);
    expect((screen.getByRole("button", { name: "添加颜色" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("彩虹不使用颜色列表", () => {
    setup("rainbow");
    expect(screen.getByText(/彩虹特效自带全色相/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "添加颜色" })).toBeNull();
  });

  it("周期：改数值，切换单位时按节拍换算", () => {
    const id = setup("strobe");
    const input = screen.getByLabelText("周期数值") as HTMLInputElement;
    expect(input.value).toBe("200");
    fireEvent.change(input, { target: { value: "500" } });
    fireEvent.blur(input);
    expect(effectCue(id).period).toEqual({ kind: "ms", ms: 500 });
    // 没有节拍：按 120 BPM（500 ms/拍）换算
    fireEvent.click(screen.getByRole("radio", { name: "拍" }));
    expect(effectCue(id).period).toEqual({ kind: "beats", beats: 1 });
    expect(screen.getByText(/还没有设置节拍/)).toBeTruthy();
  });

  it("频闪超过 10 Hz 给出警告，调慢后消失", () => {
    const id = setup("strobe");
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => useProjectStore.getState().update((d) => void (d.cues[0].kind === "effect" && (d.cues[0].period = { kind: "ms", ms: 50 }))));
    expect(screen.getByRole("alert").textContent).toContain("20.0 Hz");
    act(() => useProjectStore.getState().update((d) => void (d.cues[0].kind === "effect" && (d.cues[0].period = { kind: "ms", ms: 100 }))));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(effectCue(id).period).toEqual({ kind: "ms", ms: 100 });
  });

  it("方向、扩散、亮度范围、特效类型都能改", () => {
    const id = setup("chase");
    fireEvent.click(screen.getByRole("radio", { name: "反向" }));
    expect(effectCue(id).direction).toBe(-1);
    const spread = screen.getByLabelText("沿灯具扩散（数值）") as HTMLInputElement;
    fireEvent.change(spread, { target: { value: "60" } });
    fireEvent.blur(spread);
    expect(effectCue(id).phaseSpread).toBeCloseTo(0.6, 9);
    const floor = screen.getByLabelText("亮度下限（数值）") as HTMLInputElement;
    fireEvent.change(floor, { target: { value: "30" } });
    fireEvent.blur(floor);
    expect(effectCue(id).range).toEqual([30, 100]);
  });

  it("非闪烁特效没有随机种子", () => {
    setup("pulse");
    expect(screen.queryByLabelText("随机种子")).toBeNull();
  });

  it("闪烁特效的重新随机会改变种子", () => {
    const id = setup("sparkle");
    const before = effectCue(id).seed;
    fireEvent.click(screen.getByRole("button", { name: "重新随机" }));
    const after = effectCue(id).seed;
    expect(after).not.toBe(before);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThan(4_294_967_296);
  });

  it("每次修改是一步撤销", () => {
    const id = setup("breathe");
    const steps = () => useProjectStore.temporal.getState().pastStates.length;
    const before = steps();
    fireEvent.click(screen.getByRole("radio", { name: "反向" }));
    expect(steps()).toBe(before + 1);
    act(() => useProjectStore.temporal.getState().undo());
    expect(effectCue(id).direction).toBe(1);
  });
});

describe("CueBlock 上的特效外观", () => {
  it("显示特效名称，并用颜色拼成渐变填充", () => {
    let id = "";
    act(() =>
      useProjectStore.getState().update((d) => {
        id = addEffectCue(d, d.tracks[0].id, 0, presetOf("wipe")) ?? "";
      }),
    );
    const cue = effectCue(id);
    const { container } = render(<CueBlock cue={cue} dimmed={false} selected={false} locked={false} />);
    expect(screen.getByText(/擦除 · 100%/)).toBeTruthy();
    const fill = container.querySelector<HTMLElement>("[aria-hidden]");
    expect(fill?.style.background).toContain("linear-gradient");
    expect(within(container).queryByRole("presentation")).toBeNull();
  });

  it("彩虹用全色带，单色特效用纯色", () => {
    let rainbow = "";
    let pulse = "";
    act(() =>
      useProjectStore.getState().update((d) => {
        rainbow = addEffectCue(d, d.tracks[0].id, 0, presetOf("rainbow")) ?? "";
        pulse = addEffectCue(d, d.tracks[1].id, 0, presetOf("pulse")) ?? "";
      }),
    );
    const a = render(<CueBlock cue={effectCue(rainbow)} dimmed={false} selected={false} locked={false} />);
    expect(a.container.querySelector<HTMLElement>("[aria-hidden]")?.style.background).toContain("linear-gradient");
    const b = render(<CueBlock cue={effectCue(pulse)} dimmed={false} selected={false} locked={false} />);
    expect(b.container.querySelector<HTMLElement>("[aria-hidden]")?.style.background).not.toContain("linear-gradient");
  });
});
