// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { addFixtures, createGroup } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { DIMMER, PIXEL_BAR, RGBW } from "../../lib/__tests__/testkit";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useProgrammerStore } from "../../stores/useProgrammerStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { PreviewPanel } from "../PreviewPanel";

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

const ui = () => useEditorUiStore.getState();
const project = () => useProjectStore.getState().project;

/** U0：两台 RGBW（@9、@1，Patch 顺序与地址相反）；U1：一台调光灯。前两台编为“前排”。 */
beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      const rgb = addFixtures(d, RGBW, 2);
      addFixtures(d, DIMMER, 1);
      d.fixtures[0].address = 9;
      d.fixtures[1].address = 1;
      d.fixtures[2].universe = 1;
      d.fixtures[2].address = 1;
      createGroup(d, "前排", rgb);
      d.output.universes.push({ universe: 1, label: "舞台左", color: [0, 128, 255], ports: [] });
    }),
  );
  useEditorUiStore.setState({ selectedFixtureIds: [], playheadMs: 0, hoverFixtureId: null });
  useEditorPrefsStore.setState({
    centerView: "swatches",
    swatchGroupBy: "universe",
    swatchDensity: "comfortable",
    swatchLabel: "name",
    swatchSort: "address",
    swatchCollapsed: [],
  });
  useProgrammerStore.setState({ values: {}, live: false });
});

afterEach(() => cleanup());

const names = (region: HTMLElement) =>
  within(region)
    .getAllByRole("button", { pressed: false })
    .concat(within(region).queryAllByRole("button", { pressed: true }))
    .map((b) => b.getAttribute("aria-label") ?? "")
    .filter((l) => l.includes("：红"))
    .map((l) => l.split("：")[0]);

describe("预览色块（按 Universe 分区）", () => {
  it("默认显示色块；每个 Universe 一区，区内按地址，标出名称、占用与 @地址", () => {
    render(<PreviewPanel />);
    expect(screen.getByRole("radio", { name: "色块" }).getAttribute("aria-checked")).toBe("true");
    const u0 = screen.getByRole("region", { name: "U0" });
    const u1 = screen.getByRole("region", { name: "U1 · 舞台左" });
    expect(names(u0)).toEqual(["RGBW全彩灯 2", "RGBW全彩灯 1"]);
    expect(names(u1)).toEqual(["可调白光灯 1"]);
    expect(within(u0).getByText("8/512")).toBeTruthy();
    expect(within(u0).getByText("@9")).toBeTruthy();
    expect(within(u0).getByRole("button", { name: /RGBW全彩灯 1：.*Universe 0 地址 9/ })).toBeTruthy();
  });

  it("Shift 按屏幕顺序连选；折叠的区不计入；“选中本区”", () => {
    render(<PreviewPanel />);
    const [f1, f2, f3] = project().fixtures.map((f) => f.id);
    fireEvent.click(screen.getByRole("button", { name: /^RGBW全彩灯 2：/ }));
    fireEvent.click(screen.getByRole("button", { name: /^可调白光灯 1：/ }), { shiftKey: true });
    expect(ui().selectedFixtureIds).toEqual([f2, f1, f3]);

    fireEvent.click(screen.getByRole("button", { name: "选中 U1 · 舞台左 里的全部灯具" }));
    expect(ui().selectedFixtureIds).toEqual([f3]);

    fireEvent.click(screen.getByRole("button", { name: "收起 U0" }));
    expect(screen.queryByRole("button", { name: /^RGBW全彩灯 1：/ })).toBeNull();
  });

  it("切到按分组 / 按型号并记住；紧凑模式不显示名称", () => {
    render(<PreviewPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "按分组" }));
    expect(useEditorPrefsStore.getState().swatchGroupBy).toBe("group");
    expect(screen.getByRole("region", { name: "前排" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "未分组" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "按型号" }));
    expect(screen.getByRole("region", { name: "RGBW全彩灯" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "紧凑（灯多时一屏看全）" }));
    expect(screen.queryByText("@9")).toBeNull();
  });

  it("冲突画红框并读出；悬停时设置共享的悬停灯具", () => {
    act(() =>
      useProjectStore.getState().update((d) => {
        d.fixtures[0].address = 3;
      }),
    );
    render(<PreviewPanel />);
    const u0 = screen.getByRole("region", { name: "U0" });
    expect(within(u0).getByText("2 处冲突")).toBeTruthy();
    const one = screen.getByRole("button", { name: /^RGBW全彩灯 1：.*地址冲突/ });
    expect(one.className).toContain("border-destructive");
    fireEvent.pointerEnter(one);
    expect(ui().hoverFixtureId).toBe(project().fixtures[0].id);
  });
});

describe("预览色块增强", () => {
  const swatchOf = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}：`) });

  it("只选中像素、或编程器里只有像素的值时，整灯的色块也有反应；点分段选中像素", () => {
    let bar = "";
    act(() => {
      useProjectStore.getState().update((d) => {
        bar = addFixtures(d, PIXEL_BAR, 1)[0];
      });
    });
    render(<PreviewPanel />);
    const el = () => swatchOf("灯条 1");
    expect(el().querySelectorAll("[data-head]")).toHaveLength(3);
    act(() => ui().setSelectedFixtures([`${bar}#2`]));
    expect(el().className).toContain("ring-primary/40");
    act(() => useProgrammerStore.setState({ values: { [`${bar}#3`]: { intensity: { kind: "value", value: 50 } } } }));
    expect(el().querySelector(".bg-keyframe")).toBeTruthy();

    fireEvent.click(el().querySelector('[data-head="3"]') as HTMLElement);
    expect(ui().selectedFixtureIds).toEqual([`${bar}#3`]);
    fireEvent.click(el().querySelector('[data-head="1"]') as HTMLElement, { ctrlKey: true });
    expect(ui().selectedFixtureIds).toEqual([`${bar}#3`, `${bar}#1`]);
  });

  it("搜索与筛选：没有匹配时可一键清除", () => {
    render(<PreviewPanel />);
    const search = screen.getByRole("searchbox", { name: /搜索名称、型号或地址/ });
    fireEvent.change(search, { target: { value: "@10" } });
    expect(names(screen.getByRole("region", { name: "U0" }))).toEqual(["RGBW全彩灯 1"]);
    expect(screen.queryByRole("region", { name: "U1 · 舞台左" })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "有冲突" }));
    expect(screen.getByText("没有匹配的灯具")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索与筛选" }));
    expect(screen.getAllByRole("region").length).toBeGreaterThanOrEqual(2);
  });

  it("键盘：→ 移动并选中，Shift+→ 扩展，Ctrl+A 全选可见，Esc 取消", () => {
    render(<PreviewPanel />);
    const [f1, f2, f3] = project().fixtures.map((f) => f.id);
    fireEvent.click(swatchOf("RGBW全彩灯 2"));
    fireEvent.keyDown(swatchOf("RGBW全彩灯 2"), { key: "ArrowRight" });
    expect(ui().selectedFixtureIds).toEqual([f1]);
    fireEvent.keyDown(swatchOf("RGBW全彩灯 1"), { key: "ArrowRight", shiftKey: true });
    expect(ui().selectedFixtureIds).toEqual([f1, f3]);
    fireEvent.keyDown(swatchOf("RGBW全彩灯 1"), { key: "a", ctrlKey: true });
    expect(ui().selectedFixtureIds).toEqual([f2, f1, f3]);
    fireEvent.keyDown(swatchOf("RGBW全彩灯 1"), { key: "Escape" });
    expect(ui().selectedFixtureIds).toEqual([]);
  });

  it("右键菜单：建轨道、清除编程器值；“选中本区”Ctrl 并入原选择", () => {
    const [f1, f2, f3] = project().fixtures.map((f) => f.id);
    act(() => {
      useProjectStore.getState().update((d) => {
        d.tracks = [];
      });
      useProgrammerStore.setState({ values: { [f1]: { intensity: { kind: "value", value: 80 } } } });
    });
    render(<PreviewPanel />);
    fireEvent.contextMenu(swatchOf("RGBW全彩灯 1"));
    expect(ui().selectedFixtureIds).toEqual([f1]);
    fireEvent.click(screen.getByRole("menuitem", { name: "为 1 台灯建轨道" }));
    expect(project().tracks.map((t) => (t.target.kind === "fixture" ? t.target.id : ""))).toEqual([f1]);

    fireEvent.contextMenu(swatchOf("RGBW全彩灯 1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "清除 1 台灯的编程器值" }));
    expect(useProgrammerStore.getState().values).toEqual({});

    fireEvent.click(screen.getByRole("button", { name: "选中 U1 · 舞台左 里的全部灯具" }), { ctrlKey: true });
    expect(ui().selectedFixtureIds).toEqual([f1, f3]);
    void f2;
  });

  it("标签切到 HEX；折叠状态记住，可一键全部展开", async () => {
    render(<PreviewPanel />);
    // 偏好 store 落盘是异步的（测试里没有 Tauri，读回失败后用当前值），等界面跟上
    await act(async () => void useEditorPrefsStore.setState({ swatchLabel: "hex" }));
    expect((await screen.findAllByText("#000000")).length).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "收起 U0" }));
    expect(useEditorPrefsStore.getState().swatchCollapsed).toEqual(["u:0"]);
    await waitFor(() => expect((screen.getByRole("button", { name: "全部展开" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(useEditorPrefsStore.getState().swatchCollapsed).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "全部折叠" }));
    expect(useEditorPrefsStore.getState().swatchCollapsed).toEqual(["u:0", "u:1"]);
  });

  it("角标：通道锁定与正在找灯", () => {
    const [f1] = project().fixtures.map((f) => f.id);
    act(() => {
      useProjectStore.getState().update((d) => void d.output.park.push({ universe: 0, channel: 10, value: 255 }));
      usePlaybackStore.setState({ state: { ...(usePlaybackStore.getState().state ?? ({} as never)), locate: f1 } as never });
    });
    render(<PreviewPanel />);
    const el = swatchOf("RGBW全彩灯 1");
    expect(el.querySelector('[data-testid="swatch-parked"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="swatch-locate"]')).toBeTruthy();
    expect(el.getAttribute("aria-label")).toContain("通道锁定");
    act(() => usePlaybackStore.getState().reset());
  });

  it("空白处拖动框选（Ctrl 并入原选择）", () => {
    render(<PreviewPanel />);
    const [f1, f2, f3] = project().fixtures.map((f) => f.id);
    // jsdom 没有布局：给每个色块一个矩形（按屏幕顺序横排）
    const rects: Record<string, number> = { [f2]: 0, [f1]: 100, [f3]: 200 };
    for (const b of document.querySelectorAll<HTMLElement>("button[data-fixture-id]")) {
      const x = rects[b.dataset.fixtureId ?? ""] ?? 0;
      b.getBoundingClientRect = () => ({ left: x, top: 50, width: 60, height: 40, right: x + 60, bottom: 90, x, y: 50, toJSON: () => ({}) });
    }
    const root = screen.getByRole("region", { name: "U0" }).closest("div.relative") as HTMLElement;
    fireEvent.pointerDown(root, { button: 0, clientX: 90, clientY: 10 });
    fireEvent.pointerMove(root, { clientX: 230, clientY: 120 });
    fireEvent.pointerUp(root);
    expect(ui().selectedFixtureIds).toEqual([f1, f3]);
  });
});
