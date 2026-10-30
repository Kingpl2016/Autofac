// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";

/** driver.js 的替身：记录传入的配置，`destroy` 时调用 `onDestroyed`。 */
const tour = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[], drive: vi.fn(), destroy: vi.fn() }));
vi.mock("driver.js", () => ({
  driver: (config: Record<string, unknown>) => {
    tour.configs.push(config);
    const instance = {
      drive: tour.drive,
      getActiveIndex: () => 0,
      destroy: () => {
        tour.destroy();
        (config.onDestroyed as (() => void) | undefined)?.();
      },
    };
    return instance;
  },
}));
const hintsApi = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  setHints: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("driver.js/hints", () => ({
  hints: (config: Record<string, unknown>) => {
    hintsApi.config = config;
    return { setHints: hintsApi.setHints, show: hintsApi.show, hide: hintsApi.hide, refresh: hintsApi.refresh };
  },
}));
vi.mock("driver.js/dist/driver.css", () => ({}));
vi.mock("driver.js/dist/hints.css", () => ({}));

import { availableSteps, HINTS, nextHint, TOUR_STEPS } from "../guideContent";
import { runTour, stopTour } from "../runTour";
import { OnboardingRuntime } from "../useOnboarding";
import { sanitizeOnboarding, TOUR_VERSION, useOnboardingStore } from "../../stores/useOnboardingStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { HelpMenu } from "../../components/HelpMenu";
import { useEditorHotkeys } from "../../hooks/useEditorHotkeys";

/** 挂上全局快捷键（F1 打开帮助菜单）。 */
function Hotkeys() {
  useEditorHotkeys();
  return null;
}

const store = () => useOnboardingStore.getState();

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  tour.configs = [];
  tour.drive.mockReset();
  tour.destroy.mockReset();
  hintsApi.config = null;
  for (const fn of [hintsApi.setHints, hintsApi.show, hintsApi.hide, hintsApi.refresh]) fn.mockReset();
  useOnboardingStore.setState({ tourVersion: 0, dismissedHints: [], hydrated: true, tourRunning: false });
  document.body.innerHTML = "";
});

afterEach(() => {
  stopTour();
  cleanup();
  vi.useRealTimers();
});

/** 在页面上放几个带 `data-tour` 的元素。 */
function mount(...targets: string[]) {
  for (const t of targets) {
    const el = document.createElement("div");
    el.dataset.tour = t;
    document.body.appendChild(el);
  }
}

describe("引导内容", () => {
  it("缺少目标的步骤跳过，说明卡片保留；局部提示取第一条没关闭且在页面上的", () => {
    const ids = availableSteps(TOUR_STEPS, (t) => t !== "app-mode").map((s) => s.id);
    expect(ids).toEqual(["welcome", "library", "preview", "inspector", "timeline", "ai", "shortcuts"]);
    const present = new Set(["patch-batch", "track-headers"]);
    expect(nextHint(HINTS, [], (t) => present.has(t))?.id).toBe("trackHeaders");
    expect(nextHint(HINTS, ["trackHeaders"], (t) => present.has(t))?.id).toBe("patchBatch");
    expect(nextHint(HINTS, ["trackHeaders", "patchBatch"], (t) => present.has(t))).toBeNull();
  });

  it("AI 助手的提示排在各面板之后，按入口 → 输入框 → 审阅 → 记忆依次出现；每条都有中英文文案", () => {
    const present = new Set(["track-headers", "ai-toggle", "ai-composer", "ai-review", "ai-memory"]);
    const exists = (t: string) => present.has(t);
    expect(nextHint(HINTS, [], exists)?.id).toBe("trackHeaders");
    const order: string[] = [];
    for (let dismissed = ["trackHeaders"], h = nextHint(HINTS, dismissed, exists); h; h = nextHint(HINTS, dismissed, exists)) {
      order.push(h.id);
      dismissed = [...dismissed, h.id];
    }
    expect(order).toEqual(["aiToggle", "aiComposer", "aiReview", "aiMemory"]);
    for (const lang of ["zh", "en"]) {
      for (const id of order) {
        expect(i18n.exists(`editor.guide.hints.${id}.title`, { lng: lang }), `${lang} ${id}`).toBe(true);
        expect(i18n.exists(`editor.guide.hints.${id}.body`, { lng: lang }), `${lang} ${id}`).toBe(true);
      }
      expect(i18n.exists("editor.guide.tour.ai.body", { lng: lang })).toBe(true);
    }
  });

  it("读回的数据逐项校验", () => {
    expect(sanitizeOnboarding({ tourVersion: -1, dismissedHints: ["a", 3, "a"] })).toEqual({ tourVersion: 0, dismissedHints: ["a"] });
    expect(sanitizeOnboarding(null)).toEqual({ tourVersion: 0, dismissedHints: [] });
  });
});

describe("整体导览", () => {
  it("只播放页面上存在的步骤；进度自己写；结束（含跳过）记为已看过", async () => {
    mount("library", "preview-views", "timeline");
    expect(await runTour(i18n.t)).toBe(true);
    expect(store().tourRunning).toBe(true);
    expect(tour.drive).toHaveBeenCalledTimes(1);
    const config = tour.configs[0] as {
      steps: { element?: string; popover: { title: string } }[];
      onPopoverRender: (p: { progress: HTMLElement }, o: { driver: { getActiveIndex: () => number } }) => void;
      nextBtnText: string;
    };
    expect(config.steps.map((s) => s.element ?? "card")).toEqual([
      "card",
      '[data-tour="library"]',
      '[data-tour="preview-views"]',
      '[data-tour="timeline"]',
      "card",
    ]);
    expect(config.steps[0].popover.title).toBe(i18n.t("editor.guide.tour.welcome.title"));
    expect(config.nextBtnText).toBe("下一步");
    const progress = document.createElement("span");
    config.onPopoverRender({ progress }, { driver: { getActiveIndex: () => 1 } });
    expect(progress.textContent).toBe("2 / 5");
    // 同时只能有一个导览
    expect(await runTour(i18n.t)).toBe(false);
    stopTour();
    expect(store()).toMatchObject({ tourVersion: TOUR_VERSION, tourRunning: false });
  });

  it("第一次进来：读回之后才开始；看过的不再自动播放", async () => {
    vi.useFakeTimers();
    useOnboardingStore.setState({ hydrated: false });
    render(<OnboardingRuntime />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(tour.drive).not.toHaveBeenCalled();
    act(() => {
      useOnboardingStore.setState({ hydrated: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(tour.drive).toHaveBeenCalledTimes(1);
    cleanup();
    stopTour();

    tour.drive.mockReset();
    render(<OnboardingRuntime />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(tour.drive).not.toHaveBeenCalled();
  });
});

describe("局部提示", () => {
  it("导览没看过时不显示；看过后显示第一条，点“知道了”记住", async () => {
    mount("patch-batch");
    useOnboardingStore.setState({ tourVersion: 0 });
    // 没看过导览：会自动开始导览，但不显示提示
    useOnboardingStore.setState({ tourRunning: true });
    render(<OnboardingRuntime />);
    await act(async () => {});
    expect(hintsApi.show).not.toHaveBeenCalled();
    cleanup();

    act(() => {
      useOnboardingStore.setState({ tourVersion: TOUR_VERSION, tourRunning: false });
    });
    render(<OnboardingRuntime />);
    await act(async () => {});
    await vi.waitFor(() => expect(hintsApi.show).toHaveBeenCalled());
    const [list] = hintsApi.setHints.mock.lastCall as [{ id: string; element: string; popover: { title: string } }[]];
    expect(list.map((h) => [h.id, h.element])).toEqual([["patchBatch", '[data-tour="patch-batch"]']]);
    expect(list[0].popover.title).toBe(i18n.t("editor.guide.hints.patchBatch.title"));
    expect(hintsApi.config?.buttonText).toBe("知道了");

    act(() => {
      (hintsApi.config?.onDismiss as (el: Element, hint: { id: string }) => void)(document.body, { id: "patchBatch" });
    });
    expect(store().dismissedHints).toEqual(["patchBatch"]);
  });
});

describe("帮助菜单", () => {
  it("F1 打开；“显示本页提示”把已关掉的提示也显示出来，全部看完后自动退出", async () => {
    mount("patch-batch", "track-headers");
    useOnboardingStore.setState({ tourVersion: TOUR_VERSION, dismissedHints: ["trackHeaders", "patchBatch"] });
    useEditorUiStore.setState({ helpOpen: false, hintsShowAll: false });
    render(
      <>
        <Hotkeys />
        <HelpMenu />
        <OnboardingRuntime />
      </>,
    );
    await act(async () => {});
    expect(hintsApi.show).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "F1" });
    expect(useEditorUiStore.getState().helpOpen).toBe(true);
    fireEvent.click(await screen.findByRole("menuitem", { name: "显示本页提示" }));
    expect(useEditorUiStore.getState().hintsShowAll).toBe(true);
    await vi.waitFor(() => expect(hintsApi.show).toHaveBeenCalled());
    const [list] = hintsApi.setHints.mock.lastCall as [{ id: string }[]];
    expect(list.map((h) => h.id)).toEqual(["trackHeaders", "patchBatch"]);

    const dismiss = hintsApi.config?.onDismiss as (el: Element, hint: { id: string }) => void;
    act(() => dismiss(document.body, { id: "trackHeaders" }));
    expect(useEditorUiStore.getState().hintsShowAll).toBe(true);
    act(() => dismiss(document.body, { id: "patchBatch" }));
    expect(useEditorUiStore.getState().hintsShowAll).toBe(false);
  });

  it("菜单里可以重新播放引导、重置引导与提示", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useOnboardingStore.setState({ tourVersion: TOUR_VERSION, dismissedHints: ["swatches"] });
    useEditorUiStore.setState({ helpOpen: true, hintsShowAll: false });
    render(<HelpMenu />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "重新播放上手引导" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(tour.drive).toHaveBeenCalledTimes(1);
    stopTour();

    act(() => useEditorUiStore.setState({ helpOpen: true }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重置上手引导与提示" }));
    expect(store()).toMatchObject({ tourVersion: 0, dismissedHints: [] });
  });
});
