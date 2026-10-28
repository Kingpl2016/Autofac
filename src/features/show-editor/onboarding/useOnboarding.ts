import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Hints } from "driver.js/hints";

import { tourSeen, useOnboardingStore } from "../stores/useOnboardingStore";
import { HINTS, nextHint, tourSelector, type HintDef } from "./guideContent";
import { GUIDE_CLASS, prefersReducedMotion, runTour, stopTour, targetExists } from "./runTour";

/** 等布局稳定后再开始导览（面板尺寸由可拖动分隔条在首帧之后算出）。 */
const TOUR_DELAY_MS = 600;

/** 局部提示检查页面变化的节流间隔。 */
const HINT_CHECK_MS = 400;

/**
 * 第一次进入编辑器时播放整体导览：等引导状态从磁盘读回、确认没看过当前版本后才开始；
 * 离开编辑器时结束进行中的导览。
 */
export function useFirstRunTour(): void {
  const { t } = useTranslation();
  const hydrated = useOnboardingStore((s) => s.hydrated);
  const seen = useOnboardingStore(tourSeen);
  const started = useRef(false);

  useEffect(() => {
    if (!hydrated || seen || started.current) return;
    started.current = true;
    const timer = window.setTimeout(() => void runTour(t), TOUR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hydrated, seen, t]);

  useEffect(() => () => stopTour(), []);
}

/**
 * 局部提示：导览看过之后，面板第一次出现时在它旁边放一个闪烁小点（不遮挡、不打断操作），
 * 点开是说明，点“知道了”后记住不再出现。同一时间只显示一条（按 `HINTS` 的顺序取第一条可用的）。
 *
 * 页面变化（切换标签、打开面板）由 `MutationObserver` 节流检查。
 */
export function useContextHints(): void {
  const { t } = useTranslation();
  const hydrated = useOnboardingStore((s) => s.hydrated);
  const seen = useOnboardingStore(tourSeen);
  const running = useOnboardingStore((s) => s.tourRunning);
  const dismissed = useOnboardingStore((s) => s.dismissedHints);

  useEffect(() => {
    if (!hydrated || !seen || running) return;
    let cancelled = false;
    let instance: Hints | null = null;
    /** 当前显示的提示与它的目标元素（元素换了要重新挂） */
    let shown: { id: string; el: Element } | null = null;
    let timer: number | undefined;

    const build = (h: HintDef) => ({
      id: h.id,
      element: tourSelector(h.target),
      beacon: { side: "top" as const, align: "end" as const, animate: !prefersReducedMotion(), className: "ans-guide-beacon" },
      popover: {
        title: t(`editor.guide.hints.${h.id}.title`),
        description: t(`editor.guide.hints.${h.id}.body`),
        ...(h.side ? { side: h.side } : {}),
      },
    });

    const sync = async () => {
      timer = undefined;
      const h = nextHint(HINTS, useOnboardingStore.getState().dismissedHints, targetExists);
      const el = h ? document.querySelector(tourSelector(h.target)) : null;
      if (shown && h && el && shown.id === h.id && shown.el === el) {
        instance?.refresh();
        return;
      }
      if (!h || !el) {
        if (shown) instance?.setHints([]);
        shown = null;
        return;
      }
      if (!instance) {
        const [{ hints }] = await Promise.all([import("driver.js/hints"), import("driver.js/dist/hints.css"), import("./onboarding.css")]);
        if (cancelled) return;
        instance = hints({
          popoverClass: GUIDE_CLASS,
          buttonText: t("editor.guide.gotIt"),
          onDismiss: (_el, hint) => {
            if (hint.id) useOnboardingStore.getState().dismissHint(hint.id);
          },
        });
      }
      shown = { id: h.id, el };
      instance.setHints([build(h)]);
      instance.show();
    };
    const schedule = () => {
      if (timer === undefined) timer = window.setTimeout(() => void sync(), HINT_CHECK_MS);
    };

    void sync();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    observer?.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelled = true;
      observer?.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
      instance?.hide();
    };
  }, [hydrated, seen, running, dismissed, t]);
}

/** 挂在编辑器里的引导运行时（不渲染任何内容）。 */
export function OnboardingRuntime(): null {
  useFirstRunTour();
  useContextHints();
  return null;
}
