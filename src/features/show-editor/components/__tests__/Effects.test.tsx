// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { produce } from "immer";

import i18n from "@/shared/i18n";

const backend = vi.hoisted(() => ({ file: null as string | null, writes: [] as string[] }));
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "effects_read") return backend.file;
    if (cmd === "effects_write") {
      backend.file = String(args?.text);
      backend.writes.push(backend.file);
      return undefined;
    }
    return null;
  }),
);
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { addEffectCue } from "../../lib/cueOps";
import { addEffectDefCue, BUILTIN_EFFECTS, defaultEffectParams } from "../../lib/effectLibrary";
import { presetOf } from "../../lib/effectPresets";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type EffectCue } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useEffectLibraryStore } from "../../stores/useEffectLibraryStore";
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
  useEditorPrefsStore.setState({ cueSections: {}, effectParams: {} });
  useAnnouncerStore.setState({ message: "", seq: 0 });
  backend.file = null;
  backend.writes = [];
  useEffectLibraryStore.setState({ user: [], status: "idle", error: null, issues: [] });
});

afterEach(() => cleanup());

describe("EffectsTab", () => {
  const renderTab = () =>
    render(
      <DndContext>
        <EffectsTab />
      </DndContext>,
    );

  it("列出配置文件里的属性特效（按分组），经典特效都有可配置的对应条目", async () => {
    renderTab();
    await waitFor(() => expect(useEffectLibraryStore.getState().status).toBe("ready"));
    expect(screen.queryByRole("region", { name: "经典 RGB 特效" })).toBeNull();
    const lib = screen.getByRole("region", { name: "属性特效" });
    expect(lib.querySelectorAll("[data-effect-id]")).toHaveLength(BUILTIN_EFFECTS.length);
    for (const id of ["breathe", "rainbow", "intensityChase", "wipe", "gradient", "pulse", "sparkle", "strobe"]) {
      expect(lib.querySelector(`[data-effect-id="${id}"]`), id).not.toBeNull();
    }
    // 卡片上的色块与片段主体同一画法：彩虹为多色渐变，强度追逐（不改颜色）为斜纹；引用参数的颜色取默认值
    const swatchOf = (id: string) => lib.querySelector<HTMLElement>(`[data-effect-id="${id}"] [data-testid="effect-swatch"]`);
    expect(swatchOf("rainbow")?.style.background).toContain("linear-gradient");
    expect(swatchOf("intensityChase")?.hasAttribute("data-neutral")).toBe(true);
    expect(swatchOf("twoColor")?.style.background).toContain("linear-gradient");
    expect(swatchOf("sparkle")?.style.background).toBe("rgb(255, 255, 255)");
    for (const name of ["位置特效", "强度特效", "颜色特效", "光束特效"]) expect(within(lib).getByRole("list", { name })).toBeTruthy();
  });

  it("可调参数：插入面板按特效声明生成控件，值写进新片段并记住", () => {
    const { unmount } = renderTab();
    const trackId = project().tracks[1].id;
    act(() => {
      ui().selectTrack(trackId);
      ui().setPlayhead(3000);
    });
    const lib = screen.getByRole("region", { name: "属性特效" });
    fireEvent.click(within(lib).getByRole("button", { name: "星光闪烁" }));
    const panel = within(lib).getByRole("group", { name: "星光闪烁 的参数" });
    const density = within(panel).getByRole("textbox", { name: "星光闪烁 · 密度" });
    fireEvent.change(density, { target: { value: "60" } });
    fireEvent.blur(density);
    expect(useEditorPrefsStore.getState().effectParams.sparkle?.values).toEqual({ density: 0.6 });
    fireEvent.click(within(panel).getByRole("button", { name: "插入" }));
    const [cue] = project().cues;
    expect(cue).toMatchObject({ kind: "look", trackId, startMs: 3000 });
    expect(cue.kind === "look" && cue.look.intensity).toMatchObject({ curve: { shape: "random", duty: 0.6 } });
    expect(cue.kind === "look" && cue.fx?.def.id).toBe("sparkle");
    expect(ui().inspectorTab).toBe("cue");
    // 重新打开：参数还在
    unmount();
    renderTab();
    fireEvent.click(within(screen.getByRole("region", { name: "属性特效" })).getByRole("button", { name: "星光闪烁" }));
    expect((screen.getByRole("textbox", { name: "星光闪烁 · 密度" }) as HTMLInputElement).value).toBe("60");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(useEditorPrefsStore.getState().effectParams.sparkle).toBeUndefined();
  });

  it("高级参数：成块、分组、打乱顺序、按节拍对齐", () => {
    renderTab();
    const lib = screen.getByRole("region", { name: "属性特效" });
    fireEvent.click(within(lib).getByRole("button", { name: "强度波浪" }));
    const panel = within(lib).getByRole("group", { name: "强度波浪 的参数" });
    fireEvent.click(within(panel).getByRole("button", { name: "高级" }));
    const blocks = within(panel).getByRole("textbox", { name: "强度波浪 · 成块" });
    fireEvent.change(blocks, { target: { value: "2" } });
    fireEvent.blur(blocks);
    fireEvent.click(within(panel).getByRole("checkbox", { name: "强度波浪 · 打乱顺序" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: "强度波浪 · 按节拍对齐" }));
    const stored = useEditorPrefsStore.getState().effectParams.intensityWave;
    expect(stored).toMatchObject({ blocks: 2, sync: true });
    expect(typeof stored?.shuffle).toBe("number");
  });

  it("没有轨道时提示", () => {
    useProjectStore.getState().load(createEmptyProject("empty"));
    renderTab();
    const lib = screen.getByRole("region", { name: "属性特效" });
    fireEvent.doubleClick(within(lib).getByRole("button", { name: "呼吸" }));
    expect(useAnnouncerStore.getState().message).toContain("轨道");
  });

  it("属性特效：在所选轨道新建外观片段（曲线），选中并切到属性页", () => {
    renderTab();
    const trackId = project().tracks[0].id;
    act(() => {
      ui().selectTrack(trackId);
      ui().setPlayhead(1000);
    });
    const lib = screen.getByRole("region", { name: "属性特效" });
    fireEvent.click(within(lib).getByRole("button", { name: "强度波浪" }));
    expect(project().cues).toHaveLength(0);
    const panel = within(lib).getByRole("group", { name: "强度波浪 的参数" });
    fireEvent.click(within(panel).getByRole("button", { name: "插入" }));
    const [cue] = project().cues;
    expect(cue).toMatchObject({ kind: "look", trackId, startMs: 1000 });
    expect(cue.kind === "look" && cue.look.intensity?.kind).toBe("curve");
    expect(ui().selectedCueIds).toEqual([cue.id]);
    expect(useAnnouncerStore.getState().message).toBe("已添加强度波浪");
  });
});

describe("属性特效库", () => {
  const renderTab = () =>
    render(
      <DndContext>
        <EffectsTab />
      </DndContext>,
    );

  it("参数面板：大小与反向写进新片段；双击按当前参数直接插入", async () => {
    renderTab();
    await waitFor(() => expect(useEffectLibraryStore.getState().status).toBe("ready"));
    const trackId = project().tracks[0].id;
    act(() => ui().selectTrack(trackId));
    const lib = screen.getByRole("region", { name: "属性特效" });
    fireEvent.click(within(lib).getByRole("button", { name: "强度追逐" }));
    const panel = within(lib).getByRole("group", { name: "强度追逐 的参数" });
    const size = within(panel).getByLabelText("大小百分比");
    fireEvent.change(size, { target: { value: "40" } });
    fireEvent.blur(size);
    fireEvent.click(within(panel).getByRole("button", { name: "插入" }));
    const [cue] = project().cues;
    expect(cue.kind === "look" && cue.look.intensity).toMatchObject({ kind: "curve", curve: { shape: "square", to: 40 } });

    act(() => ui().setPlayhead(20_000));
    fireEvent.doubleClick(within(lib).getByRole("button", { name: "强度追逐" }));
    expect(project().cues).toHaveLength(2);
  });

  it("用户文件里的特效出现在“我的”分组，同 id 的覆盖内置的；格式不对的条目列出原因", async () => {
    backend.file = JSON.stringify({
      version: 1,
      effects: [
        { id: "circle", group: "position", name: "大圆", scale: "fraction", period: { kind: "beats", beats: 2 }, size: 0.4, look: { attrs: { pan: { shape: "sine", center: 0.5 } } } },
        { id: "mine", name: "我的闪", period: { kind: "ms", ms: 300 }, size: 80, look: { intensity: { shape: "square", lo: 0, hi: 1 } } },
        { id: "broken", name: "坏" },
      ],
    });
    renderTab();
    const lib = screen.getByRole("region", { name: "属性特效" });
    expect(await within(lib).findByRole("button", { name: "大圆" })).toBeTruthy();
    expect(within(lib).queryByRole("button", { name: "画圆" })).toBeNull();
    expect(within(within(lib).getByRole("list", { name: "我的特效" })).getByRole("button", { name: "我的闪" })).toBeTruthy();
    expect(within(lib).getByRole("alert").textContent).toContain("1 处问题");
  });
});

describe("特效片段：插入后改参数", () => {
  const def = (id: string) => BUILTIN_EFFECTS.find((e) => e.id === id)!;
  function setup(effect = "gradient") {
    let id: string | null = null;
    act(() =>
      useProjectStore.getState().update((d) => {
        id = addEffectDefCue(d, d.tracks[0].id, 0, def(effect), defaultEffectParams(def(effect)), "流动渐变");
      }),
    );
    act(() => ui().selectCues([id!]));
    render(<CueInspector />);
    const look = () => project().cues.find((c) => c.id === id) as Extract<ReturnType<typeof project>["cues"][number], { kind: "look" }>;
    return { id: id!, look };
  }

  it("显示特效参数：改速度重新生成曲线，加颜色进入颜色序列；恢复默认", () => {
    const { look } = setup();
    const panel = screen.getByRole("group", { name: "流动渐变 的参数" });
    const speed = within(panel).getByLabelText("一个周期的长度");
    fireEvent.change(speed, { target: { value: "4000" } });
    fireEvent.blur(speed);
    expect(look().look.color).toMatchObject({ kind: "cycle", cycle: { period: { kind: "ms", ms: 4000 } } });
    fireEvent.click(within(panel).getByRole("button", { name: "添加颜色" }));
    const color = look().look.color;
    expect(color?.kind === "cycle" && color.cycle.colors).toHaveLength(3);
    expect(look().fx?.params.values?.colors).toHaveLength(3);
    fireEvent.click(within(panel).getByRole("button", { name: "恢复默认" }));
    expect(look().fx?.params).toEqual(defaultEffectParams(def("gradient")));
  });

  it("转为普通外观；手动改强度层也会转为普通外观并提示", () => {
    const { look } = setup();
    fireEvent.click(screen.getByRole("button", { name: "转为普通外观" }));
    expect(look().fx).toBeUndefined();
    expect(screen.queryByRole("group", { name: "流动渐变 的参数" })).toBeNull();
    act(() => useProjectStore.temporal.getState().undo());
    expect(look().fx).toBeDefined();
    setNumberIn(screen.getByRole("textbox", { name: "强度数值" }), "50");
    expect(look().fx).toBeUndefined();
    expect(useAnnouncerStore.getState().message).toContain("普通外观");
  });

  it("经典特效片段可以一键转换为可配置特效", () => {
    let id = "";
    act(() =>
      useProjectStore.getState().update((d) => {
        id = addEffectCue(d, d.tracks[0].id, 0, presetOf("sparkle")) ?? "";
      }),
    );
    act(() => ui().selectCues([id]));
    render(<CueInspector />);
    fireEvent.click(screen.getByRole("button", { name: "转换为可配置特效" }));
    const cue = project().cues.find((c) => c.id === id);
    expect(cue?.kind === "look" && cue.fx?.def.id).toBe("sparkle");
    expect(useAnnouncerStore.getState().message).toBe("已转换 1 个特效");
    expect(screen.getByRole("group", { name: "星光闪烁 的参数" })).toBeTruthy();
  });
});

const setNumberIn = (input: HTMLElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

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
    // 颜色列表在单独的“特效颜色”分区里，没有静态片段的“颜色”分区
    expect(within(screen.getByRole("region", { name: "特效颜色" })).getByRole("group", { name: "颜色" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "颜色" })).toBeNull();
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

  it("属性特效：彩虹按颜色关键帧画渐变（不是第一帧的纯色），名称是特效名；强度追逐为中性斜纹", () => {
    const def = (id: string) => BUILTIN_EFFECTS.find((e) => e.id === id)!;
    let rainbow: string | null = null;
    let chase: string | null = null;
    act(() =>
      useProjectStore.getState().update((d) => {
        rainbow = addEffectDefCue(d, d.tracks[0].id, 0, def("rainbow"), defaultEffectParams(def("rainbow")), "彩虹");
        chase = addEffectDefCue(d, d.tracks[1].id, 0, def("intensityChase"), defaultEffectParams(def("intensityChase")), "强度追逐");
      }),
    );
    const cueOf = (id: string | null) => project().cues.find((c) => c.id === id)!;
    const a = render(<CueBlock cue={cueOf(rainbow)} dimmed={false} selected={false} locked={false} />);
    const fillA = within(a.container).getByTestId("clip-fill");
    expect(fillA.style.background).toContain("linear-gradient(90deg");
    // 红 → 黄 → 绿 …：不止一种颜色
    expect(new Set(fillA.style.background.match(/rgb\([^)]*\)/g)).size).toBeGreaterThan(3);
    expect(within(a.container).getByText("彩虹 · 100%")).toBeTruthy();
    const b = render(<CueBlock cue={cueOf(chase)} dimmed={false} selected={false} locked={false} />);
    const fillB = within(b.container).getByTestId("clip-fill");
    expect(fillB.hasAttribute("data-neutral")).toBe(true);
    expect(fillB.className).toContain("hatch-neutral");
    expect(within(b.container).getByText("强度追逐 · 100%")).toBeTruthy();
  });
});
