// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { produce } from "immer";

import i18n from "@/shared/i18n";

/** 后端替身：用户模板文件放在内存里。 */
const backend = vi.hoisted(() => ({ file: null as string | null, writes: [] as string[] }));
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "cue_templates_read") return backend.file;
    if (cmd === "cue_templates_write") {
      backend.file = String(args?.text);
      backend.writes.push(backend.file);
      return undefined;
    }
    throw new Error(`unexpected ${cmd}`);
  }),
);
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import type { CueTemplate } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS, defaultEffectParams } from "../../lib/effectLibrary";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useCueTemplateStore } from "../../stores/useCueTemplateStore";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { useTemplateEditorStore } from "../../stores/useTemplateEditorStore";
import { TemplateEditorDialog } from "../TemplateEditorDialog";
import { TemplatesTab } from "../TemplatesTab";

const project = () => useProjectStore.getState().project;
const saved = () => JSON.parse(backend.file ?? "{}") as { version: number; templates: Record<string, unknown>[] };
const setText = (el: HTMLElement, value: string) => {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
};
const twoColor = BUILTIN_EFFECTS.find((e) => e.id === "twoColor")!;
const userFile = (templates: Partial<CueTemplate>[]) => JSON.stringify({ version: 2, templates });

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

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 60_000;
    }),
  );
  useEditorUiStore.setState({ selectedCueIds: [], selectedTrackId: null, playheadMs: 0 });
  useEditorPrefsStore.setState({ favoriteTemplates: [] });
  useAnnouncerStore.setState({ message: "", seq: 0 });
  useCueTemplateStore.setState({ user: [], status: "idle", error: null, issues: [] });
  useTemplateEditorStore.setState({ draft: null, mode: "new" });
  backend.file = null;
  backend.writes = [];
});

afterEach(() => cleanup());

const renderTab = () =>
  render(
    <DndContext>
      <TemplatesTab />
      <TemplateEditorDialog />
    </DndContext>,
  );

describe("Cue 模板：搜索与收藏", () => {
  it("搜索按名称、标签、说明过滤；Esc 清空", async () => {
    backend.file = userFile([{ id: "intro", name: "开场蓝", color: { kind: "rgb", rgb: [0, 0, 255] }, tags: ["演唱会"] }]);
    renderTab();
    await screen.findByRole("button", { name: "开场蓝" });
    const box = screen.getByRole("searchbox", { name: "搜索模板（名称、标签、说明）" });
    fireEvent.change(box, { target: { value: "演唱会" } });
    const results = screen.getByRole("region", { name: "搜索结果" });
    expect(within(results).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["开场蓝"]);
    expect(within(results).getByRole("status").textContent).toBe("找到 1 个模板");
    // 色纸编号写在说明里
    fireEvent.change(box, { target: { value: "lee 106" } });
    expect(within(screen.getByRole("region", { name: "搜索结果" })).getByRole("button", { name: "LEE 106 原红" })).toBeTruthy();
    fireEvent.change(box, { target: { value: "不存在的" } });
    expect(screen.getByText("没有匹配的模板")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect((box as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("region", { name: "基础色" })).toBeTruthy();
  });

  it("右键收藏：内置模板也能收藏，排在最上面的“收藏”分区；记在偏好里", async () => {
    renderTab();
    await waitFor(() => expect(useCueTemplateStore.getState().status).toBe("ready"));
    fireEvent.contextMenu(screen.getByRole("button", { name: "红" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "收藏" }));
    expect(useEditorPrefsStore.getState().favoriteTemplates).toEqual(["red"]);
    const fav = screen.getByRole("region", { name: "收藏" });
    expect(within(fav).getByRole("button", { name: "红" })).toBeTruthy();
    expect(screen.getAllByRole("region")[0]).toBe(fav);
    expect(useAnnouncerStore.getState().message).toBe("已收藏 红");
    // 不写用户模板文件
    expect(backend.writes).toHaveLength(0);

    fireEvent.contextMenu(within(fav).getByRole("button", { name: "红" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "取消收藏" }));
    expect(screen.queryByRole("region", { name: "收藏" })).toBeNull();
  });
});

describe("Cue 模板：外观与特效预设模板", () => {
  it("点击外观模板：外观与分布原样写入；特效预设模板生成可改参数的特效片段", async () => {
    backend.file = userFile([
      {
        id: "pan",
        name: "扫到中间",
        kind: "look",
        color: { kind: "rgb", rgb: [255, 255, 255] },
        look: { intensity: { kind: "value", value: 80 }, color: { kind: "value", value: { kind: "kelvin", kelvin: 3200 } } },
        spread: { order: "reverse" },
      },
      { id: "fx", name: "双色预设", kind: "effect", color: { kind: "rgb", rgb: [255, 0, 0] }, fx: { def: twoColor, params: defaultEffectParams(twoColor) }, brightness: 50 },
    ]);
    renderTab();
    const lookBtn = await screen.findByRole("button", { name: "扫到中间" });
    expect(within(lookBtn).getByTestId("template-kind-look")).toBeTruthy();
    act(() => useEditorUiStore.getState().selectTrack(project().tracks[0].id));
    fireEvent.click(lookBtn);
    const look = project().cues[0];
    expect(look.kind === "look" && look.look).toEqual({ intensity: { kind: "value", value: 80 }, color: { kind: "value", value: { kind: "kelvin", kelvin: 3200 } } });
    expect(look.kind === "look" && look.spread).toEqual({ order: "reverse" });
    expect(look.kind === "look" && look.label).toBe("扫到中间");

    act(() => useEditorUiStore.getState().selectTrack(project().tracks[1].id));
    const fxBtn = screen.getByRole("button", { name: "双色预设" });
    expect(within(fxBtn).getByTestId("template-kind-effect")).toBeTruthy();
    fireEvent.click(fxBtn);
    const fx = project().cues.find((c) => c.trackId === project().tracks[1].id)!;
    expect(fx).toMatchObject({ kind: "look", brightness: 50, fx: { def: { id: "twoColor" } } });
  });
});

describe("Cue 模板编辑器", () => {
  it("编辑用户模板：改名、亮度、长度按拍、标签，保存写回文件（版本 2）", async () => {
    backend.file = userFile([{ id: "my-1", name: "我的红", group: "custom", color: { kind: "rgb", rgb: [200, 0, 0] } }]);
    renderTab();
    fireEvent.contextMenu(await screen.findByRole("button", { name: "我的红" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "编辑 Cue 模板" })).toBeTruthy();
    setText(within(dialog).getByRole("textbox", { name: "名称" }), "开场红");
    setText(within(dialog).getByRole("textbox", { name: "亮度" }), "60");
    fireEvent.click(within(dialog).getByRole("radio", { name: "拍" }));
    setText(within(dialog).getByRole("textbox", { name: "长度数值" }), "8");
    setText(within(dialog).getByRole("textbox", { name: "标签" }), "开场, 红色，开场");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存模板" }));
    await waitFor(() => expect(backend.writes).toHaveLength(1));
    expect(saved().version).toBe(2);
    expect(saved().templates).toEqual([
      { id: "my-1", name: "开场红", group: "custom", color: { kind: "rgb", rgb: [200, 0, 0] }, brightness: 60, fadeInMs: 0, fadeOutMs: 0, length: { kind: "beats", beats: 8 }, tags: ["开场", "红色"] },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useAnnouncerStore.getState().message).toBe("已保存模板 开场红");
  });

  it("内置模板“复制并编辑…”：打开副本，开启多色分布后保存为我的模板", async () => {
    renderTab();
    await waitFor(() => expect(useCueTemplateStore.getState().status).toBe("ready"));
    fireEvent.contextMenu(screen.getByRole("button", { name: "红" }));
    expect(screen.queryByRole("menuitem", { name: "编辑…" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制并编辑…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "新建 Cue 模板" })).toBeTruthy();
    // 打开时还没写文件
    expect(backend.writes).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "沿成员铺开多种颜色" }));
    expect(within(dialog).getByLabelText("颜色 2")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "添加颜色" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存模板" }));
    await waitFor(() => expect(backend.writes).toHaveLength(1));
    const t = saved().templates[0] as unknown as CueTemplate;
    expect(t).toMatchObject({ id: "my-1", group: "custom", name: { zh: "红 副本" } });
    expect(t.spread?.colors?.colors).toHaveLength(3);
  });

  it("特效预设模板显示特效参数；外观模板显示各层概要", () => {
    act(() =>
      useTemplateEditorStore.getState().open(
        { id: "fx", name: "双色", group: "custom", kind: "effect", color: { kind: "rgb", rgb: [255, 0, 0] }, brightness: 100, fadeInMs: 0, fadeOutMs: 0, fx: { def: twoColor, params: defaultEffectParams(twoColor) } },
        "edit",
      ),
    );
    render(<TemplateEditorDialog />);
    expect(within(screen.getByRole("dialog")).getByRole("region", { name: "特效参数" })).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByRole("region", { name: "代表色" })).toBeTruthy();
    cleanup();

    act(() =>
      useTemplateEditorStore.getState().open(
        {
          id: "lk",
          name: "外观",
          group: "custom",
          kind: "look",
          color: { kind: "rgb", rgb: [255, 255, 255] },
          brightness: 100,
          fadeInMs: 0,
          fadeOutMs: 0,
          look: { intensity: { kind: "keys", keys: [{ tMs: 0, value: 0, curve: "linear" }] }, attrs: { tilt: { kind: "value", value: 0.2 } } },
          spread: { wings: 2 },
        },
        "edit",
      ),
    );
    render(<TemplateEditorDialog />);
    const summary = within(screen.getByRole("dialog")).getByRole("region", { name: "外观概要" });
    expect(summary.textContent).toContain("关键帧");
    expect(summary.textContent).toContain("固定值");
    expect(summary.textContent).toContain("带多灯分布");
  });
});
