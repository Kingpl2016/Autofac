// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { addFixtures, createGroup } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { DIMMER, RGBW } from "../../lib/__tests__/testkit";
import { useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
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
  useEditorPrefsStore.setState({ centerView: "swatches", swatchGroupBy: "universe", swatchDensity: "comfortable" });
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
