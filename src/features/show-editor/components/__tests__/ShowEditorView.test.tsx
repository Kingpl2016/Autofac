// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
import { resetRecoveryCheck } from "../../hooks/useShowFile";
import { LIBRARY_TABS, useEditorUiStore } from "../../stores/useEditorUiStore";
import { HINTS } from "../../onboarding/guideContent";
import { TOUR_VERSION, useOnboardingStore } from "../../stores/useOnboardingStore";
import { ShowEditorView } from "../ShowEditorView";

/** 编辑器依赖路由（?open= 参数）和查询客户端（节目库刷新）。 */
function renderView(url = "/editor") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <ShowEditorView />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeAll(() => {
  // 面板组和时间线库都用 ResizeObserver 测量容器
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // 命令面板（cmdk）会把选中项滚动到可见范围，jsdom 没有实现 scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  // 这里测编辑器本身：引导视为已看过，局部提示全部关闭
  useOnboardingStore.setState({ tourVersion: TOUR_VERSION, dismissedHints: HINTS.map((h) => h.id) });
  invoke.mockReset();
  // 默认打开的灯具页会读灯具素材库：给空列表
  invoke.mockImplementation(async (cmd: string) => (cmd === "fixture_list" ? [] : null));
  resetRecoveryCheck();
  useEditorUiStore.setState({ libraryTab: LIBRARY_TABS[0], paletteOpen: false });
});

afterEach(() => cleanup());

describe("ShowEditorView 外壳", () => {
  it("包含工具条和素材库 / 预览 / 属性 / 时间线四个带名称的区域", () => {
    renderView();
    expect(screen.getByRole("toolbar", { name: "编辑工具条" })).toBeTruthy();
    for (const name of ["素材库", "预览", "属性", "时间轴"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
  });

  it("?addFixture= 打开左侧灯具页并展开该模型的批量添加面板", () => {
    useEditorUiStore.setState({ fixtureAddModelId: null });
    invoke.mockImplementation(async (cmd: string) => (cmd === "fixture_list" ? [] : null));
    renderView(`/editor?addFixture=${encodeURIComponent("1.5.1.4")}`);
    expect(useEditorUiStore.getState().libraryTab).toBe("fixtures");
    expect(useEditorUiStore.getState().fixtureAddModelId).toBe("1.5.1.4");
    expect(within(screen.getByRole("tablist", { name: "素材库" })).getByRole("tab", { name: "灯具" }).getAttribute("aria-selected")).toBe("true");
  });

  it("页面标题是 h1，显示默认的未命名节目", () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "未命名节目" })).toBeTruthy();
  });

  it("左侧图标栏有七个素材分区，点击或方向键切换素材库内容", () => {
    renderView();
    const rail = screen.getByRole("tablist", { name: "素材库" });
    const tabs = within(rail).getAllByRole("tab");
    // 媒体排在 Cue 模板下面；默认打开最上面的灯具
    expect(tabs.map((t) => t.textContent)).toEqual(["灯具", "Cue 模板", "媒体", "特效", "预设", "分组", "历史"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    const library = screen.getByRole("region", { name: "素材库" });
    expect(within(library).getByRole("heading", { name: "灯具" })).toBeTruthy();

    fireEvent.click(tabs[4]);
    expect(within(library).getByRole("heading", { name: "预设" })).toBeTruthy();
    expect(within(library).getByRole("tabpanel", { name: "预设" })).toBeTruthy();

    fireEvent.keyDown(tabs[4], { key: "ArrowDown" });
    expect(within(library).getByRole("heading", { name: "分组" })).toBeTruthy();
    expect(document.activeElement).toBe(within(rail).getByRole("tab", { name: "分组" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(within(library).getByRole("list", { name: "撤销历史" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(within(library).getByRole("heading", { name: "灯具" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(within(library).getByRole("heading", { name: "媒体" })).toBeTruthy();
  });

  it("左侧：再点一次当前分区收起素材库，收起时点别的分区先展开；Ctrl+Shift+B 切换", () => {
    useEditorUiStore.setState({ libraryCollapsed: false, inspectorCollapsed: false });
    renderView();
    const rail = screen.getByRole("tablist", { name: "素材库" });
    const fixturesTab = within(rail).getByRole("tab", { name: "灯具" });
    expect(fixturesTab.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fixturesTab);
    expect(useEditorUiStore.getState().libraryCollapsed).toBe(true);
    expect(within(rail).getByRole("tab", { name: "灯具" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(within(rail).getByRole("tab", { name: "特效" }));
    expect(useEditorUiStore.getState().libraryCollapsed).toBe(false);
    expect(useEditorUiStore.getState().libraryTab).toBe("effects");
    fireEvent.keyDown(document.body, { key: "B", ctrlKey: true, shiftKey: true });
    expect(useEditorUiStore.getState().libraryCollapsed).toBe(true);
    fireEvent.keyDown(document.body, { key: "B", ctrlKey: true, shiftKey: true });
    expect(useEditorUiStore.getState().libraryCollapsed).toBe(false);
  });

  it("右侧：标题栏按钮收起成窄边，点窄边上的标签展开到那一页；Ctrl+Alt+B 切换", () => {
    useEditorUiStore.setState({ libraryCollapsed: false, inspectorCollapsed: false, inspectorTab: "patch" });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "收起属性面板（Ctrl+Alt+B）" }));
    expect(useEditorUiStore.getState().inspectorCollapsed).toBe(true);
    const strip = screen.getByRole("navigation", { name: "属性面板（已收起）" });
    expect(within(strip).getByRole("button", { name: "展开属性面板：灯具与 Patch" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("tablist", { name: /属性|Patch/ })).toBeNull();
    fireEvent.click(within(strip).getByRole("button", { name: "展开属性面板：编程器" }));
    expect(useEditorUiStore.getState().inspectorCollapsed).toBe(false);
    expect(useEditorUiStore.getState().inspectorTab).toBe("program");
    expect(screen.queryByRole("navigation", { name: "属性面板（已收起）" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true, altKey: true });
    expect(useEditorUiStore.getState().inspectorCollapsed).toBe(true);
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true, altKey: true });
    expect(useEditorUiStore.getState().inspectorCollapsed).toBe(false);
  });

  it("工具条按钮打开命令面板", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "打开命令面板" }));
    expect(screen.getByRole("combobox", { name: "搜索命令…" })).toBeTruthy();
  });

  it("时间线提供放大 / 缩小按钮", () => {
    renderView();
    expect(screen.getByRole("button", { name: "放大时间轴" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "缩小时间轴" })).toBeTruthy();
  });
});
