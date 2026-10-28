// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
import { resetRecoveryCheck } from "../../hooks/useShowFile";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
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
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  // 这里测编辑器本身：引导视为已看过，局部提示全部关闭
  useOnboardingStore.setState({ tourVersion: TOUR_VERSION, dismissedHints: HINTS.map((h) => h.id) });
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  resetRecoveryCheck();
  useEditorUiStore.setState({ libraryTab: "media", paletteOpen: false });
});

afterEach(() => cleanup());

describe("ShowEditorView 外壳", () => {
  it("包含工具条和素材库 / 预览 / 属性 / 时间线四个带名称的区域", () => {
    renderView();
    expect(screen.getByRole("toolbar", { name: "编辑工具条" })).toBeTruthy();
    for (const name of ["素材库", "预览", "属性", "时间线"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
  });

  it("页面标题是 h1，显示默认的未命名节目", () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "未命名节目" })).toBeTruthy();
  });

  it("左侧图标栏有七个素材分区，点击或方向键切换素材库内容", () => {
    renderView();
    const rail = screen.getByRole("tablist", { name: "素材库" });
    const tabs = within(rail).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["媒体", "灯具", "Cue 模板", "特效", "预设", "分组", "历史"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    const library = screen.getByRole("region", { name: "素材库" });
    expect(within(library).getByRole("heading", { name: "媒体" })).toBeTruthy();

    fireEvent.click(tabs[4]);
    expect(within(library).getByRole("heading", { name: "预设" })).toBeTruthy();
    expect(within(library).getByRole("tabpanel", { name: "预设" })).toBeTruthy();

    fireEvent.keyDown(tabs[4], { key: "ArrowDown" });
    expect(within(library).getByRole("heading", { name: "分组" })).toBeTruthy();
    expect(document.activeElement).toBe(within(rail).getByRole("tab", { name: "分组" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(within(library).getByRole("list", { name: "撤销历史" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(within(library).getByRole("heading", { name: "媒体" })).toBeTruthy();
  });

  it("工具条按钮打开命令面板", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "打开命令面板" }));
    expect(screen.getByRole("combobox", { name: "搜索命令…" })).toBeTruthy();
  });

  it("时间线提供放大 / 缩小按钮", () => {
    renderView();
    expect(screen.getByRole("button", { name: "放大时间线" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "缩小时间线" })).toBeTruthy();
  });
});
