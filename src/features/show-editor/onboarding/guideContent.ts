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

/**
 * 整体导览：素材库 → 预览 → 检查器 → 时间线 → 顶栏模式 → AI 助手 → 快捷操作与帮助按钮。
 *
 * 加了 AI 助手一步但没有递增 `TOUR_VERSION`：看过导览的用户不必整段重看，由下面的 AI 局部提示补上。
 */
export const TOUR_STEPS: readonly TourStepDef[] = [
  { id: "welcome" },
  { id: "library", target: "library", side: "right" },
  { id: "preview", target: "preview-views", side: "bottom" },
  { id: "inspector", target: "inspector", side: "left" },
  { id: "timeline", target: "timeline", side: "top" },
  { id: "mode", target: "app-mode", side: "bottom" },
  { id: "ai", target: "ai-toggle", side: "bottom" },
  // 最后一步指向帮助按钮（之后从这里重播 / 显示提示）；找不到按钮时为居中卡片
  { id: "shortcuts", target: "help", side: "bottom", optional: true },
];

/** 一条局部提示。 */
export interface HintDef {
  id: string;
  target: string;
  side?: GuideSide;
}

/**
 * 局部提示（按出现的优先顺序；同一时间只显示第一条可用的）。
 * AI 助手的四条排在最后：入口按钮一直在工具条上，排在前面会挡住各面板自己的提示。
 */
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
  // AI 助手：入口 → 输入框（模型、自动写入）→ 待审阅的改动 → 记忆
  { id: "aiToggle", target: "ai-toggle", side: "bottom" },
  { id: "aiComposer", target: "ai-composer", side: "top" },
  { id: "aiReview", target: "ai-review", side: "left" },
  { id: "aiMemory", target: "ai-memory", side: "bottom" },
  // 时间线上的 AI：音乐参考线 → 问 AI → 改动虚影 → 主动建议 → AI 历史
  { id: "aiGuides", target: "ai-guides", side: "bottom" },
  { id: "askAi", target: "ask-ai-button", side: "top" },
  { id: "aiGhosts", target: "ai-ghost", side: "top" },
  { id: "aiSuggestions", target: "ai-suggestion", side: "bottom" },
  { id: "aiHistory", target: "ai-history", side: "bottom" },
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
