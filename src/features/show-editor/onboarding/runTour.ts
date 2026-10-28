import type { TFunction } from "i18next";

import { useOnboardingStore } from "../stores/useOnboardingStore";
import { availableSteps, tourSelector, TOUR_STEPS } from "./guideContent";

/** 弹层的类名（样式见 `onboarding.css`）。 */
export const GUIDE_CLASS = "ans-guide";

/** 用户要求减少动态效果时关掉动画与平滑滚动。 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** 目标元素是否在页面上。 */
export const targetExists = (target: string) => document.querySelector(tourSelector(target)) !== null;

/** 进行中的导览（同一时间只有一个）。 */
let active: { destroy: () => void } | null = null;

/**
 * 播放整体导览：按需加载 driver.js 与样式，只播放页面上存在的步骤；看完、跳过或按 Esc 都记为已看过。
 * 导览弹层带 `role="dialog"`，期间编辑器快捷键只响应全局命令。
 *
 * @param t 翻译函数。
 * @returns 是否开始了导览（已有导览在进行时为 `false`）。
 */
export async function runTour(t: TFunction): Promise<boolean> {
  if (active) return false;
  const store = useOnboardingStore.getState();
  store.setTourRunning(true);
  try {
    const [{ driver }] = await Promise.all([
      import("driver.js"),
      import("driver.js/dist/driver.css"),
      import("./onboarding.css"),
    ]);
    const steps = availableSteps(TOUR_STEPS, targetExists);
    const total = steps.length;
    const reduce = prefersReducedMotion();
    const instance = driver({
      steps: steps.map((s) => ({
        ...(s.target ? { element: tourSelector(s.target) } : {}),
        popover: {
          title: t(`editor.guide.tour.${s.id}.title`),
          description: t(`editor.guide.tour.${s.id}.body`),
          ...(s.side ? { side: s.side, align: "start" as const } : {}),
        },
      })),
      animate: !reduce,
      smoothScroll: !reduce,
      overlayOpacity: 0.55,
      stagePadding: 4,
      stageRadius: 8,
      popoverClass: GUIDE_CLASS,
      showProgress: true,
      nextBtnText: t("editor.guide.next"),
      prevBtnText: t("editor.guide.prev"),
      doneBtnText: t("editor.guide.done"),
      closeBtnLabel: t("editor.guide.skip"),
      onPopoverRender: (popover, opts) => {
        // 进度文字自己写（库的占位符与 i18next 的插值语法冲突）
        popover.progress.textContent = t("editor.guide.progress", {
          current: (opts.driver.getActiveIndex() ?? 0) + 1,
          total,
        });
      },
      onDestroyed: () => {
        active = null;
        useOnboardingStore.getState().completeTour();
      },
    });
    active = instance;
    instance.drive();
    return true;
  } catch (e) {
    console.warn("[guide] 无法启动导览", e);
    active = null;
    useOnboardingStore.getState().setTourRunning(false);
    return false;
  }
}

/** 结束进行中的导览（离开编辑器时）。 */
export function stopTour(): void {
  active?.destroy();
  active = null;
}
