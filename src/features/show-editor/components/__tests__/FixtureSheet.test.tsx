// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

// 偏好存储不落盘：测试里用内存即可
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { fixed } from "../../lib/looks";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { HEAD16, PIXEL_BAR, RGBW } from "../../lib/__tests__/testkit";
import { DEFAULT_SHEET_PREFS, useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProgrammerStore } from "../../stores/useProgrammerStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { FixtureSheet } from "../FixtureSheet";

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

const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();
const programmer = () => useProgrammerStore.getState();
const ids = () => project().fixtures.map((f) => f.id);
const table = () => screen.getByRole("table", { name: "灯具表" });
const rowOf = (name: string) => within(table()).getByRole("button", { name }).closest("tr") as HTMLElement;
const names = () => within(table()).getAllByRole("rowheader").map((th) => th.textContent);

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 3);
      addFixtures(d, HEAD16, 1);
      d.fixtures[0].name = "前排 10";
      d.fixtures[1].name = "前排 2";
      d.fixtures[2].name = "后排";
      d.fixtures[2].universe = 1;
      d.fixtures[2].address = 1;
      d.durationMs = 10_000;
      d.output.gamma = 1;
    }),
  );
  useEditorUiStore.setState({ selectedFixtureIds: [], playheadMs: 0, hoverFixtureId: null });
  useEditorPrefsStore.setState({ sheet: DEFAULT_SHEET_PREFS });
  useProgrammerStore.setState({ values: {}, live: false });
  useAnnouncerStore.setState({ message: "", seq: 0 });
});

afterEach(() => cleanup());

describe("灯具表：读数、筛选与排序", () => {
  it("读数切换为 8 位 DMX 与十六进制；按 DMX 输入写入编程器", () => {
    act(() => useProgrammerStore.getState().setValues({ [ids()[0]]: { intensity: fixed(100), color: fixed({ kind: "manual", values: { red: 1 } }) } }));
    act(() => void useEditorPrefsStore.getState().setSheetPrefs({ readout: "dmx8" }));
    render(<FixtureSheet />);
    expect(within(rowOf("前排 10")).getByRole("button", { name: /^Red 255（DMX（8 位）/ })).toBeTruthy();
    act(() => void useEditorPrefsStore.getState().setSheetPrefs({ readout: "hex" }));
    expect(within(rowOf("前排 10")).getByRole("button", { name: /^Red FF（十六进制/ })).toBeTruthy();

    act(() => void useEditorPrefsStore.getState().setSheetPrefs({ readout: "dmx8" }));
    fireEvent.click(within(rowOf("前排 2")).getByRole("button", { name: /^Green 0/ }));
    const input = within(rowOf("前排 2")).getByRole("textbox", { name: "Green（DMX（8 位））" });
    fireEvent.change(input, { target: { value: "51" } });
    fireEvent.blur(input);
    expect(programmer().values[ids()[1]]?.color).toEqual(fixed({ kind: "manual", values: { green: 0.2 } }));
  });

  it("只看编程中 / 选中的灯；搜索名称与 @地址；按名称（自然顺序）与地址排序", () => {
    act(() => useProgrammerStore.getState().setValues({ [ids()[2]]: { intensity: fixed(50) } }));
    render(<FixtureSheet />);
    expect(names()).toEqual(["前排 10", "前排 2", "后排", "通用16CH摇头灯 1"]);
    fireEvent.click(screen.getByRole("radio", { name: "编程中" }));
    expect(names()).toEqual(["后排"]);
    act(() => ui().setSelectedFixtures([ids()[1]]));
    fireEvent.click(screen.getByRole("radio", { name: "选中" }));
    expect(names()).toEqual(["前排 2"]);
    expect(useEditorPrefsStore.getState().sheet.filter).toBe("selected");
    fireEvent.click(screen.getByRole("radio", { name: "全部" }));

    const search = screen.getByRole("searchbox", { name: "搜索灯具（名称、型号、@地址）" });
    fireEvent.change(search, { target: { value: "前排" } });
    expect(names()).toEqual(["前排 10", "前排 2"]);
    fireEvent.change(search, { target: { value: "1.1" } });
    expect(names()).toEqual(["后排"]);
    fireEvent.change(search, { target: { value: "没有" } });
    expect(screen.getByText("没有符合条件的灯具")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });

    act(() => void useEditorPrefsStore.getState().setSheetPrefs({ sort: "name" }));
    expect(names()).toEqual(["后排", "前排 2", "前排 10", "通用16CH摇头灯 1"]);
    act(() => void useEditorPrefsStore.getState().setSheetPrefs({ sort: "address" }));
    expect(names()[names().length - 1]).toBe("后排");
  });

  it("按属性组隐藏列；型号列", async () => {
    render(<FixtureSheet />);
    expect(within(table()).getByRole("columnheader", { name: "水平 Pan" })).toBeTruthy();
    act(() => void useEditorPrefsStore.getState().setSheetPrefs({ hiddenGroups: ["position"], showModel: true }));
    expect(within(table()).queryByRole("columnheader", { name: "水平 Pan" })).toBeNull();
    expect(within(table()).getByRole("columnheader", { name: "型号" })).toBeTruthy();
    expect(within(rowOf("前排 10")).getByText("RGBW全彩灯")).toBeTruthy();
  });
});

describe("灯具表：键盘与联动", () => {
  it("方向键在单元格之间移动；Delete 清除这一层的编程器值；Enter 编辑后焦点回到单元格", () => {
    act(() =>
      useProgrammerStore.getState().setValues({
        [ids()[0]]: { intensity: fixed(100), color: fixed({ kind: "manual", values: { red: 1 } }) },
      }),
    );
    render(<FixtureSheet />);
    const red = within(rowOf("前排 10")).getByRole("button", { name: /^Red 100%/ });
    act(() => red.focus());
    fireEvent.keyDown(red, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Red 0%/);
    expect(rowOf("前排 2").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(red);

    fireEvent.keyDown(red, { key: "Delete" });
    expect(programmer().values[ids()[0]]).toEqual({ intensity: fixed(100) });
    expect(useAnnouncerStore.getState().message).toBe("已清除 1 台灯的 Red 编程器值");

    const green = within(rowOf("前排 10")).getByRole("button", { name: /^Green 0%/ });
    fireEvent.click(green);
    const input = within(rowOf("前排 10")).getByRole("textbox", { name: "Green（百分比）" });
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(programmer().values[ids()[0]]?.color).toEqual(fixed({ kind: "manual", values: { green: 0.3 } }));
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Green 30%/);
  });

  it("悬停行同步到共享悬停；别处悬停的灯高亮该行", () => {
    render(<FixtureSheet />);
    fireEvent.mouseEnter(rowOf("前排 2"));
    expect(ui().hoverFixtureId).toBe(ids()[1]);
    fireEvent.mouseLeave(rowOf("前排 2"));
    expect(ui().hoverFixtureId).toBeNull();
    act(() => ui().setHoverFixture(ids()[2]));
    expect(rowOf("后排").className).toContain("bg-surface-3");
  });

  it("展开 / 收起全部像素（记在偏好里）", () => {
    act(() =>
      useProjectStore.getState().load(
        produce(createEmptyProject("t"), (d) => {
          addFixtures(d, PIXEL_BAR, 2);
          d.durationMs = 10_000;
        }),
      ),
    );
    render(<FixtureSheet />);
    expect(within(table()).getAllByRole("row")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "展开全部像素" }));
    expect(within(table()).getAllByRole("row")).toHaveLength(9);
    expect(useEditorPrefsStore.getState().sheet.expandPixels).toBe(true);
    // 单独收起一台
    fireEvent.click(within(table()).getByRole("button", { name: "收起 灯条 1 的像素" }));
    expect(within(table()).getAllByRole("row")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "收起全部像素" }));
    expect(within(table()).getAllByRole("row")).toHaveLength(3);
  });
});
