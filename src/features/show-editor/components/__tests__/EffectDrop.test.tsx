// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
import { resetRecoveryCheck } from "../../hooks/useShowFile";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { HINTS } from "../../onboarding/guideContent";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useEffectLibraryStore } from "../../stores/useEffectLibraryStore";
import { TOUR_VERSION, useOnboardingStore } from "../../stores/useOnboardingStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { ShowEditorView } from "../ShowEditorView";

/** 时间线编辑区在屏幕上的位置（jsdom 没有布局，手动给出）。 */
const TIMELINE = { left: 300, top: 500, width: 1200, height: 300 };

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.setPointerCapture = () => undefined;
  // jsdom 没有 PointerEvent：dnd-kit 的指针传感器要读 isPrimary / button / clientX
  if (typeof window.PointerEvent === "undefined") {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    Object.defineProperty(window, "PointerEvent", { value: PointerEventPolyfill, configurable: true, writable: true });
  }
  // 时间线（轨道区及其内部）给一个大矩形；其余元素都在左上角的素材库里
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const inTimeline = this.closest('[aria-label="轨道与 Cue"]') || this.closest("[data-testid='timeline-body']");
    // 分隔条放到屏幕外：面板库会在分隔条的命中区内拦截 pointerdown
    const separator = this.closest("[data-separator], [role='separator']");
    const r = separator
      ? { left: -5000, top: -5000, width: 1, height: 1 }
      : inTimeline
        ? TIMELINE
        : { left: 10, top: 100, width: 120, height: 32 };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  };
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useOnboardingStore.setState({ tourVersion: TOUR_VERSION, dismissedHints: HINTS.map((h) => h.id) });
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "fixture_list" ? [] : cmd === "effect_library_load" ? { text: null } : null));
  resetRecoveryCheck();
  useEffectLibraryStore.setState({ user: [], status: "ready", error: null, issues: [] });
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 1);
      d.durationMs = 60_000;
    }),
  );
  useEditorUiStore.setState({ libraryTab: "effects", pxPerSec: 100, selectedCueIds: [], libraryCollapsed: false, inspectorCollapsed: false });
});

afterEach(() => cleanup());

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/editor"]}>
      <QueryClientProvider client={client}>
        <ShowEditorView />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** 用指针把元素拖到时间线第一条轨道的 `x` 处。 */
async function dragToTimeline(el: Element, x = 800) {
  const y = TIMELINE.top + 22;
  fireEvent.pointerDown(el, { button: 0, isPrimary: true, clientX: 30, clientY: 110, pointerId: 1 });
  const tick = () => new Promise((r) => setTimeout(r, 50));
  await act(async () => {
    fireEvent.pointerMove(document, { clientX: 60, clientY: 140, pointerId: 1, isPrimary: true });
    await tick();
    fireEvent.pointerMove(document, { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
    await tick();
  });
  await act(async () => {
    fireEvent.pointerUp(document, { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
  });
}

describe("灯具拖到时间线", () => {
  it("灯具卡片拖到时间线生成轨道", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "fixture_list" ? [RGBW] : null));
    useEditorUiStore.setState({ libraryTab: "fixtures" });
    renderView();
    const card = await screen.findByTestId("fixture-model-drag");
    await dragToTimeline(card);
    await waitFor(() => expect(useProjectStore.getState().project.fixtures).toHaveLength(2));
  });
});

describe("特效拖到时间线", () => {
  it("经典特效：拖到轨道上生成特效片段", async () => {
    renderView();
    const classic = screen.getByRole("region", { name: "经典 RGB 特效" });
    await dragToTimeline(within(classic).getByRole("button", { name: "彩虹" }));
    await waitFor(() => expect(useProjectStore.getState().project.cues).toHaveLength(1));
    expect(useProjectStore.getState().project.cues[0]).toMatchObject({ kind: "effect", effect: "rainbow" });
  });

  it("属性特效：拖到轨道上生成外观片段，名称为特效名", async () => {
    renderView();
    const lib = await screen.findByRole("region", { name: "属性特效" });
    await dragToTimeline(within(lib).getByRole("button", { name: "双色交替" }));
    await waitFor(() => expect(useProjectStore.getState().project.cues).toHaveLength(1));
    expect(useProjectStore.getState().project.cues[0]).toMatchObject({ kind: "look", label: "双色交替" });
  });

  it("放在轨道之外：给出提示，而不是没有反应", async () => {
    renderView();
    const classic = screen.getByRole("region", { name: "经典 RGB 特效" });
    const el = within(classic).getByRole("button", { name: "彩虹" });
    // 落在时间线区域里、但低于唯一一条轨道（第 2 行没有轨道）
    fireEvent.pointerDown(el, { button: 0, isPrimary: true, clientX: 30, clientY: 110, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerMove(document, { clientX: 60, clientY: 140, pointerId: 1, isPrimary: true });
      await new Promise((r) => setTimeout(r, 50));
      fireEvent.pointerMove(document, { clientX: 800, clientY: TIMELINE.top + 200, pointerId: 1, isPrimary: true });
      await new Promise((r) => setTimeout(r, 50));
    });
    await act(async () => {
      fireEvent.pointerUp(document, { clientX: 800, clientY: TIMELINE.top + 200, pointerId: 1, isPrimary: true });
    });
    expect(useProjectStore.getState().project.cues).toHaveLength(0);
    expect(useAnnouncerStore.getState().message).toBe("没有放到轨道上：请松手在某条轨道的空白处");
  });
});
