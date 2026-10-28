// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { produce } from "immer";

import i18n from "@/shared/i18n";

/** 后端替身：用户模板文件放在内存里。 */
const backend = vi.hoisted(() => ({ file: null as string | null, importText: "", writes: [] as string[] }));
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "cue_templates_read") return backend.file;
    if (cmd === "cue_templates_write") {
      backend.file = String(args?.text);
      backend.writes.push(backend.file);
      return undefined;
    }
    if (cmd === "cue_templates_import") return backend.importText;
    if (cmd === "cue_templates_export" || cmd === "cue_templates_reveal") return "";
    throw new Error(`unexpected ${cmd}`);
  }),
);
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
const pickers = vi.hoisted(() => ({ pickJsonFile: vi.fn(), pickSavePath: vi.fn() }));
vi.mock("@/shared/tauri/pickers", () => pickers);
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { DIMMER, RGBW } from "../../lib/__tests__/testkit";
import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { useCueTemplateStore } from "../../stores/useCueTemplateStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { TemplatesTab } from "../TemplatesTab";

const ui = () => useEditorUiStore.getState();
const project = () => useProjectStore.getState().project;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 60_000;
    }),
  );
  useEditorUiStore.setState({ selectedCueIds: [], selectedTrackId: null, playheadMs: 0, clipboard: [] });
  useAnnouncerStore.setState({ message: "", seq: 0 });
  useCueTemplateStore.setState({ user: [], status: "idle", error: null, issues: [] });
  backend.file = null;
  backend.importText = "";
  backend.writes = [];
  invoke.mockClear();
  toast.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(() => cleanup());

const renderTab = () =>
  render(
    <DndContext>
      <TemplatesTab />
    </DndContext>,
  );

describe("TemplatesTab", () => {
  it("列出全部内置模板", () => {
    renderTab();
    expect(document.querySelectorAll("[data-template-id]")).toHaveLength(BUILTIN_TEMPLATES.length);
    for (const g of ["基础色", "舞台常用色（色纸参考）", "白光色温"]) expect(screen.getByRole("region", { name: g })).toBeTruthy();
    expect(screen.getByRole("button", { name: "LEE 106 原红" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "红" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "白光渐入渐出" })).toBeTruthy();
  });

  it("点击模板：加到所选轨道的播放头处，带上模板的颜色并选中", () => {
    renderTab();
    const trackId = project().tracks[1].id;
    act(() => {
      ui().selectTrack(trackId);
      ui().setPlayhead(5000);
    });
    fireEvent.click(screen.getByRole("button", { name: "红" }));
    expect(project().cues).toHaveLength(1);
    const cue = project().cues[0];
    // 新片段是外观片段：RGBW 能混色，带上模板的颜色
    expect(cue).toMatchObject({ trackId, startMs: 5000, endMs: 7000, kind: "look" });
    expect(cue.kind === "look" && cue.look.color).toEqual({ kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } });
    expect(ui().selectedCueIds).toEqual([cue.id]);
    expect(useAnnouncerStore.getState().message).toBe("已添加 Cue");
  });

  it("带淡入淡出的模板保留淡入淡出", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "柔和暖光" }));
    expect(project().cues[0]).toMatchObject({ brightness: 60, fadeInMs: 1000, fadeOutMs: 1000 });
  });

  it("没有选中轨道时用第一条未锁定的轨道", () => {
    renderTab();
    act(() =>
      useProjectStore.getState().update((d) => {
        d.tracks[0].lock = true;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "蓝" }));
    expect(project().cues[0].trackId).toBe(project().tracks[1].id);
  });

  it("位置被占用时播报放不下；没有可用轨道时播报原因", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "绿" }));
    fireEvent.click(screen.getByRole("button", { name: "绿" }));
    expect(project().cues).toHaveLength(1);
    expect(useAnnouncerStore.getState().message).toBe("这个位置放不下新的 Cue");

    act(() =>
      useProjectStore.getState().update((d) => {
        for (const t of d.tracks) t.lock = true;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "黄" }));
    expect(useAnnouncerStore.getState().message).toBe("没有可用的轨道。先添加灯具，或解锁轨道");
  });
});

describe("TemplatesTab 按灯具类型", () => {
  it("调光灯轨道：彩色模板标“不适用”并拒绝添加；白光模板只写强度层；混合多选时“部分适用”", () => {
    act(() => useProjectStore.getState().update((d) => void addFixtures(d, DIMMER, 1)));
    renderTab();
    const dimmerTrack = project().tracks[2].id;
    act(() => ui().selectTrack(dimmerTrack));
    const red = screen.getByRole("button", { name: "红" });
    expect(red.textContent).toContain("不适用");
    fireEvent.click(red);
    expect(project().cues).toHaveLength(0);
    expect(useAnnouncerStore.getState().message).toBe("没有放上去：需要能混色的灯（RGB / CMY）");

    fireEvent.click(screen.getByRole("button", { name: "白光" }));
    const cue = project().cues[0];
    expect(cue.kind === "look" && Object.keys(cue.look)).toEqual(["intensity"]);

    act(() => ui().selectTracks([project().tracks[0].id, dimmerTrack], dimmerTrack));
    expect(screen.getByRole("button", { name: "红" }).textContent).toContain("部分 1/2");
    fireEvent.click(screen.getByRole("button", { name: "红" }));
    // 只加到支持的那条轨道
    expect(project().cues.filter((c) => c.trackId === project().tracks[0].id)).toHaveLength(1);
  });
});

describe("TemplatesTab 配置文件", () => {
  const userFile = (templates: unknown[]) => JSON.stringify({ version: 1, templates });

  it("加载用户模板：同 id 覆盖内置，自建分组单独显示；格式不对的条目跳过并列出", async () => {
    backend.file = userFile([
      { id: "red", name: "我的红", group: "basic", color: { kind: "rgb", rgb: [200, 0, 0] } },
      { id: "show-1", name: "开场蓝", group: "演唱会", color: { kind: "rgb", rgb: [0, 0, 200] } },
      { id: "bad", name: "坏", color: { kind: "rgb", rgb: [999, 0, 0] } },
    ]);
    renderTab();
    expect(await screen.findByRole("button", { name: "我的红" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "红" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "演唱会" })).getByRole("button", { name: "开场蓝" })).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("1 处问题");
    expect(alert.textContent).toContain("第 3 条");
  });

  it("右键内置模板“复制为我的模板”写入用户文件；右键用户模板可删除并撤销", async () => {
    renderTab();
    await waitFor(() => expect(useCueTemplateStore.getState().status).toBe("ready"));
    fireEvent.contextMenu(screen.getByRole("button", { name: "红" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制为我的模板" }));
    await waitFor(() => expect(backend.writes).toHaveLength(1));
    expect(JSON.parse(backend.file ?? "{}").templates[0]).toMatchObject({ id: "my-1", group: "custom", name: { zh: "红 副本" } });
    // 复制后直接进入改名
    const input = await screen.findByRole("textbox", { name: "红 副本 的名称" });
    fireEvent.change(input, { target: { value: "开场红" } });
    fireEvent.blur(input);
    await waitFor(() => expect(JSON.parse(backend.file ?? "{}").templates[0].name).toBe("开场红"));

    fireEvent.contextMenu(await screen.findByRole("button", { name: "开场红" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除模板" }));
    await waitFor(() => expect(JSON.parse(backend.file ?? "{}").templates).toEqual([]));
    const [text, options] = toast.mock.lastCall as [string, { action: { onClick: () => void } }];
    expect(text).toBe("已删除模板 开场红");
    act(() => options.action.onClick());
    await waitFor(() => expect(JSON.parse(backend.file ?? "{}").templates).toHaveLength(1));
  });

  it("导入：合并进用户模板并汇报新增 / 替换 / 跳过；导出全部模板", async () => {
    backend.file = userFile([{ id: "a", name: "甲", color: { kind: "rgb", rgb: [1, 1, 1] } }]);
    backend.importText = userFile([
      { id: "a", name: "甲2", color: { kind: "rgb", rgb: [2, 2, 2] } },
      { id: "b", name: "乙", color: { kind: "kelvin", kelvin: 3200 } },
      { id: "c" },
    ]);
    pickers.pickJsonFile.mockResolvedValue("D:/模板.json");
    renderTab();
    await waitFor(() => expect(useCueTemplateStore.getState().status).toBe("ready"));
    fireEvent.click(screen.getByRole("button", { name: "导入模板文件…" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("导入完成：新增 1 个、替换 1 个，跳过 1 条格式不对的"));
    expect(JSON.parse(backend.file ?? "{}").templates.map((t: { name: string }) => t.name)).toEqual(["甲2", "乙"]);

    pickers.pickSavePath.mockResolvedValue("D:/导出");
    fireEvent.click(screen.getByRole("button", { name: "导出全部模板…" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("cue_templates_export", expect.objectContaining({ path: "D:/导出.json" })));
    const exported = JSON.parse(String(invoke.mock.calls.find((c) => c[0] === "cue_templates_export")?.[1]?.text));
    expect(exported.templates.length).toBe(BUILTIN_TEMPLATES.length + 2);
  });

  it("色温模板新建的片段颜色层是色温", async () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "日光 5600K" }));
    const cue = project().cues[0];
    expect(cue.kind === "look" && cue.look.color).toEqual({ kind: "value", value: { kind: "kelvin", kelvin: 5600 } });
  });
});
