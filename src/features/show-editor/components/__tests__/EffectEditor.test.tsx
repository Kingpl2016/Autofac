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
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { addEffectDefCue, BUILTIN_EFFECTS, defaultEffectParams } from "../../lib/effectLibrary";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useEffectEditorStore } from "../../stores/useEffectEditorStore";
import { useEffectLibraryStore } from "../../stores/useEffectLibraryStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { CueInspector } from "../CueInspector";
import { EffectEditorDialog } from "../EffectEditorDialog";
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
  // 预览默认不自动播放（测试里没有动画帧）
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
  loadTestEngine();
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 60_000;
    }),
  );
  useEditorUiStore.setState({ selectedCueIds: [], selectedTrackId: null, playheadMs: 0 });
  useEditorPrefsStore.setState({ cueSections: {}, effectParams: {} });
  useAnnouncerStore.setState({ message: "", seq: 0 });
  useEffectEditorStore.setState({ draft: null, mode: "new" });
  backend.file = null;
  backend.writes = [];
  useEffectLibraryStore.setState({ user: [], status: "ready", error: null, issues: [] });
});

afterEach(() => cleanup());

const renderLibrary = () =>
  render(
    <DndContext>
      <EffectsTab />
      <EffectEditorDialog />
    </DndContext>,
  );
const dialog = () => screen.getByRole("dialog");
const setText = (el: HTMLElement, value: string) => {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
};
const saved = () => JSON.parse(backend.writes.at(-1) ?? "{}") as { version: number; effects: Record<string, unknown>[] };

describe("特效编辑器", () => {
  it("新建：改名后保存到我的特效，出现在特效库里", async () => {
    renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "新建特效…" }));
    expect(within(dialog()).getByRole("heading", { name: "新建特效" })).toBeTruthy();
    expect(within(dialog()).getByRole("group", { name: "特效预览" })).toBeTruthy();
    setText(within(dialog()).getByRole("textbox", { name: "名称" }), "我的波浪");
    fireEvent.click(within(dialog()).getByRole("button", { name: "保存到我的特效" }));
    await waitFor(() => expect(backend.writes).toHaveLength(1));
    expect(saved()).toMatchObject({ version: 2, effects: [{ id: "my-effect-1", name: "我的波浪", group: "custom" }] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useAnnouncerStore.getState().message).toBe("已保存特效 我的波浪");
    expect(within(screen.getByRole("region", { name: "属性特效" })).getByRole("button", { name: "我的波浪" })).toBeTruthy();
  });

  it("有问题时说明原因并禁止保存", () => {
    renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "新建特效…" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "移除强度层" }));
    expect(within(dialog()).getByRole("alert").textContent).toContain("还不能保存");
    expect((within(dialog()).getByRole("button", { name: "保存到我的特效" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog()).getByText("特效还有问题，修正后显示预览")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "添加强度层" }));
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it("可调参数：声明百分比参数，在层里用 $标识 引用；引用不存在的参数不能保存", async () => {
    renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "新建特效…" }));
    setText(within(dialog()).getByRole("textbox", { name: "强度 · 起点" }), "$p1");
    expect(within(dialog()).getByRole("alert").textContent).toContain("$p1");
    fireEvent.click(within(dialog()).getByRole("button", { name: "添加参数" }));
    const param = within(dialog()).getByRole("group", { name: "参数 $p1" });
    setText(within(param).getByRole("textbox", { name: "$p1 · 显示名" }), "最暗");
    setText(within(param).getByRole("textbox", { name: "$p1 · 默认（%）" }), "30");
    expect(within(dialog()).queryByRole("alert")).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "保存到我的特效" }));
    await waitFor(() => expect(backend.writes).toHaveLength(1));
    expect(saved().effects[0]).toMatchObject({
      params: [{ id: "p1", type: "percent", default: 0.3, label: "最暗" }],
      look: { intensity: { shape: "sine", lo: "$p1", hi: 1 } },
    });
  });

  it("属性层与颜色层：添加 Pan 层、颜色改为颜色序列", () => {
    renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "新建特效…" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "添加颜色层" }));
    fireEvent.click(within(dialog()).getByRole("radio", { name: "颜色序列" }));
    expect(within(dialog()).getAllByLabelText(/颜色 第 \d 个/)).toHaveLength(2);
    expect(useEffectEditorStore.getState().draft).not.toBeNull();
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it("从 Cue 属性“存为特效”：按片段预填", () => {
    let id: string | null = null;
    const def = BUILTIN_EFFECTS.find((e) => e.id === "sparkle")!;
    act(() =>
      useProjectStore.getState().update((d) => {
        id = addEffectDefCue(d, d.tracks[0].id, 0, def, defaultEffectParams(def), "星光闪烁");
      }),
    );
    act(() => useEditorUiStore.getState().selectCues([id!]));
    render(
      <>
        <CueInspector />
        <EffectEditorDialog />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "存为特效…" }));
    expect((within(dialog()).getByRole("textbox", { name: "名称" }) as HTMLInputElement).value).toBe("星光闪烁");
    expect(within(dialog()).getByRole("group", { name: "参数 $density" })).toBeTruthy();
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });
});
