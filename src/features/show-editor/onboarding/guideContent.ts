/**
 * 上手引导的内容（纯数据）：首次进入编辑器的整体导览，以及各面板第一次出现时的局部提示。
 * 元素一律用 `data-tour="…"` 定位；找不到元素的导览步骤会被跳过（例如顶栏的模式切换不在当前窗口里）。
 * 文案在语言包 `editor.guide.*`。
 */

/** 弹层相对元素的方向。 */
export type GuideSide = "top" | "right" | "bottom" | "left";

/** 导览的一步。 */
export interface TourStepDef {
  id: string;
  /** 目标元素的 `data-tour`；省略时为居中的说明卡片 */
  target?: string;
  side?: GuideSide;
}

/** 整体导览：素材库 → 预览 → 检查器 → 时间线 → 顶栏模式 → 快捷操作。 */
export const TOUR_STEPS: readonly TourStepDef[] = [
  { id: "welcome" },
  { id: "library", target: "library", side: "right" },
  { id: "preview", target: "preview-views", side: "bottom" },
  { id: "inspector", target: "inspector", side: "left" },
  { id: "timeline", target: "timeline", side: "top" },
  { id: "mode", target: "app-mode", side: "bottom" },
  { id: "shortcuts" },
];

/** 一条局部提示。 */
export interface HintDef {
  id: string;
  target: string;
  side?: GuideSide;
}

/** 局部提示（按出现的优先顺序；同一时间只显示第一条可用的）。 */
export const HINTS: readonly HintDef[] = [
  { id: "swatches", target: "preview-swatch-tools", side: "bottom" },
  { id: "trackHeaders", target: "track-headers", side: "right" },
  { id: "patchBatch", target: "patch-batch", side: "left" },
  { id: "universeView", target: "universe-view", side: "left" },
  { id: "colorInput", target: "color-input", side: "left" },
];

/**
 * `data-tour` 的选择器。
 *
 * @param target 标记值。
 * @returns CSS 选择器。
 */
export const tourSelector = (target: string) => `[data-tour="${target}"]`;

/**
 * 页面上还存在目标的导览步骤（没有目标的说明卡片总是保留）。
 *
 * @param steps 全部步骤。
 * @param exists 判断目标是否存在。
 * @returns 可以播放的步骤。
 */
export function availableSteps(steps: readonly TourStepDef[], exists: (target: string) => boolean): TourStepDef[] {
  return steps.filter((s) => !s.target || exists(s.target));
}

/**
 * 现在应显示的局部提示：没关闭过、目标在页面上的第一条。
 *
 * @param hints 全部提示。
 * @param dismissed 已关闭的提示。
 * @param exists 判断目标是否存在。
 * @returns 提示；没有时为 `null`。
 */
export function nextHint(
  hints: readonly HintDef[],
  dismissed: readonly string[],
  exists: (target: string) => boolean,
): HintDef | null {
  return hints.find((h) => !dismissed.includes(h.id) && exists(h.target)) ?? null;
}
