// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";

import { useFixtureStore } from "@/features/fixtures";
import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { DIMMER, HEAD16, RGBW } from "../../lib/__tests__/testkit";
import { createEmptyProject } from "../../lib/project";
import { DEFAULT_FIXTURE_ADD, DEFAULT_FIXTURE_LIBRARY, useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { LibraryFixturesTab } from "../LibraryFixturesTab";

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
  toast.mockReset();
  useProjectStore.getState().load(createEmptyProject(""));
  useEditorUiStore.getState().clearSelection();
  useEditorUiStore.setState({ fixtureAddModelId: null });
  await act(async () => {
    await useEditorPrefsStore.setState({ fixtureAdd: DEFAULT_FIXTURE_ADD, fixtureLibrary: DEFAULT_FIXTURE_LIBRARY });
  });
  useFixtureStore.setState({ models: [RGBW, DIMMER, HEAD16], status: "ready", error: null });
});

afterEach(() => cleanup());

const renderTab = () =>
  render(
    <DndContext>
      <LibraryFixturesTab />
    </DndContext>,
  );

const cards = () => within(screen.getByRole("group", { name: "灯具模型" })).getAllByRole("listitem");

describe("左侧灯具页", () => {
  it("搜索与类型筛选，带计数；没有结果时可清除筛选", () => {
    renderTab();
    expect(cards()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /摇头灯\s*1/, pressed: false }));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain("通用16CH摇头灯");

    fireEvent.change(screen.getByRole("searchbox", { name: /搜索灯具/ }), { target: { value: "RGBW" } });
    expect(screen.getByText("没有符合条件的灯具")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(cards()).toHaveLength(3);
  });

  it("“+”快速加 1 台，选中新灯并给出带撤销的提示", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个 RGBW全彩灯" }));
    const { fixtures } = useProjectStore.getState().project;
    expect(fixtures).toHaveLength(1);
    expect(useEditorUiStore.getState().selectedFixtureIds).toEqual([fixtures[0].id]);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("已添加 1 个 RGBW全彩灯"), expect.objectContaining({ action: expect.anything() }));
  });

  it("批量面板：实时预览占用、指定起点被占用时顺延，加完编组并记住设置", () => {
    useProjectStore.getState().update((d) => {
      d.fixtureModels.push(structuredClone(RGBW));
      d.fixtures.push({ id: "a", name: "旧", modelId: RGBW.id, universe: 0, address: 1 });
    });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "批量添加 RGBW全彩灯…" }));
    const panel = screen.getByRole("group", { name: "批量添加 RGBW全彩灯" });
    // 默认 4 台，接在已有灯具后面
    expect(within(panel).getByText(/将占用 U0 5–20 · 无冲突/)).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "8", pressed: false }));
    expect(within(panel).getByText(/将占用 U0 5–36/)).toBeTruthy();

    fireEvent.click(within(panel).getByRole("radio", { name: "指定" }));
    fireEvent.change(within(panel).getByLabelText("起始地址"), { target: { value: "3" } });
    expect(within(panel).getByText(/顺延到 U0\.5/)).toBeTruthy();

    fireEvent.change(within(panel).getByLabelText("名称"), { target: { value: "面光" } });
    expect(within(panel).getByText(/第一台：面光 2/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("checkbox", { name: "添加后编为一组" }));
    fireEvent.click(within(panel).getByRole("button", { name: "按以上设置添加 8 个 RGBW全彩灯" }));

    const { fixtures, groups } = useProjectStore.getState().project;
    expect(fixtures).toHaveLength(9);
    expect(groups).toEqual([expect.objectContaining({ name: "面光", fixtureIds: fixtures.slice(1).map((f) => f.id) })]);
    expect(useEditorPrefsStore.getState().fixtureAdd).toMatchObject({ count: 8, autoStart: false, address: 3, group: true });
    // 一步撤销
    act(() => useProjectStore.temporal.getState().undo());
    expect(useProjectStore.getState().project.fixtures).toHaveLength(1);
  });

  it("按类型分组，可折叠并记住；搜索时分组全部展开", () => {
    renderTab();
    const moverToggle = screen.getByRole("button", { name: /摇头灯\s*1/, expanded: true });
    fireEvent.click(moverToggle);
    expect(useEditorPrefsStore.getState().fixtureLibrary.collapsed).toEqual(["mover"]);
    expect(cards()).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox", { name: /搜索灯具/ }), { target: { value: "摇头" } });
    expect(cards()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /摇头灯\s*1/, expanded: true })).toHaveProperty("disabled", true);
  });

  it("收藏：星标切换，收藏区在最前；最近添加记下刚加的型号", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "收藏 RGBW全彩灯" }));
    expect(useEditorPrefsStore.getState().fixtureLibrary.favorites).toEqual([RGBW.id]);
    const fav = screen.getByRole("list", { name: "收藏" });
    expect(within(fav).getByText("RGBW全彩灯")).toBeTruthy();
    // 收藏区的卡片没有批量面板（只在类型分组里展开）
    expect(within(fav).queryByRole("button", { name: /批量添加/ })).toBeNull();

    fireEvent.click(within(fav).getByRole("button", { name: "添加 1 个 RGBW全彩灯" }));
    expect(useEditorPrefsStore.getState().fixtureLibrary.recent).toEqual([RGBW.id]);
    expect(within(screen.getByRole("list", { name: "最近添加" })).getByText("RGBW全彩灯")).toBeTruthy();

    fireEvent.click(within(fav).getByRole("button", { name: "取消收藏 RGBW全彩灯", pressed: true }));
    expect(screen.queryByRole("list", { name: "收藏" })).toBeNull();
  });

  it("紧凑显示切换并记住；色块按钮打开通道表", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "紧凑显示", pressed: false }));
    expect(useEditorPrefsStore.getState().fixtureLibrary.density).toBe("compact");
    fireEvent.click(screen.getByRole("button", { name: "查看 RGBW全彩灯 的通道表" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(1 + RGBW.properties.length);
    expect(within(table).getByText("红光")).toBeTruthy();
  });

  it("放不下时禁用提交并说明原因", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "批量添加 RGBW全彩灯…" }));
    const panel = screen.getByRole("group", { name: "批量添加 RGBW全彩灯" });
    fireEvent.click(within(panel).getByRole("radio", { name: "指定" }));
    fireEvent.change(within(panel).getByLabelText("起始 Universe"), { target: { value: "2047" } });
    fireEvent.change(within(panel).getByLabelText("起始地址"), { target: { value: "509" } });
    expect(within(panel).getByText(/有 3 台放不下/)).toBeTruthy();
  });
});
