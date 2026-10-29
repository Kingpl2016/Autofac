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
  /** 目标不在页面上时退回居中卡片（而不是跳过这一步） */
  optional?: boolean;
}

/** 整体导览：素材库 → 预览 → 检查器 → 时间线 → 顶栏模式 → 快捷操作与帮助按钮。 */
export const TOUR_STEPS: readonly TourStepDef[] = [
  { id: "welcome" },
  { id: "library", target: "library", side: "right" },
  { id: "preview", target: "preview-views", side: "bottom" },
  { id: "inspector", target: "inspector", side: "left" },
  { id: "timeline", target: "timeline", side: "top" },
  { id: "mode", target: "app-mode", side: "bottom" },
  // 最后一步指向帮助按钮（之后从这里重播 / 显示提示）；找不到按钮时为居中卡片
  { id: "shortcuts", target: "help", side: "bottom", optional: true },
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
  { id: "timelineObjects", target: "marker-strip", side: "bottom" },
  { id: "templates", target: "templates", side: "right" },
  { id: "fixtureAdd", target: "fixture-add", side: "right" },
  { id: "effects", target: "effects", side: "right" },
  { id: "patchBatch", target: "patch-batch", side: "left" },
  { id: "universeView", target: "universe-view", side: "left" },
  { id: "colorInput", target: "color-input", side: "left" },
  { id: "programmer", target: "programmer-tools", side: "left" },
];

/**
 * `data-tour` 的选择器。
 *
 * @param target 标记值。
 * @returns CSS 选择器。
 */
export const tourSelector = (target: string) => `[data-tour="${target}"]`;

/**
 * 页面上还存在目标的导览步骤（没有目标的说明卡片总是保留；`optional` 的步骤目标不在时退回居中卡片）。
 *
 * @param steps 全部步骤。
 * @param exists 判断目标是否存在。
 * @returns 可以播放的步骤。
 */
export function availableSteps(steps: readonly TourStepDef[], exists: (target: string) => boolean): TourStepDef[] {
  return steps.flatMap((s) => {
    if (!s.target || exists(s.target)) return [s];
    return s.optional ? [{ id: s.id }] : [];
  });
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
