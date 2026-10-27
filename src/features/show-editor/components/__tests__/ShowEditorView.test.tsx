// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
import { resetRecoveryCheck } from "../../hooks/useShowFile";
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
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  resetRecoveryCheck();
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

  it("素材库有音视频 / 灯具 / Cue 模板 / 特效四个标签", () => {
    renderView();
    const library = screen.getByRole("region", { name: "素材库" });
    const tabs = within(library).getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["音视频", "灯具", "Cue 模板", "特效"]);
  });

  it("时间线提供放大 / 缩小按钮", () => {
    renderView();
    expect(screen.getByRole("button", { name: "放大时间线" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "缩小时间线" })).toBeTruthy();
  });
});
