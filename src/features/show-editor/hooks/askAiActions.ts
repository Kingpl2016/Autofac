import type { AskScope } from "../ai/askScope";
import { useAskAiStore } from "../stores/useAskAiStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 按当前选择得到“问 AI”的范围：选中的片段 → 时间范围 → 播放头处（带选中的轨道）。
 *
 * @returns 范围。
 */
export function selectionScope(): AskScope {
  const ui = useEditorUiStore.getState();
  const alive = new Set(useProjectStore.getState().project.cues.map((c) => c.id));
  const ids = ui.selectedCueIds.filter((id) => alive.has(id));
  if (ids.length > 0) return { kind: "clips", ids };
  if (ui.timeRange) return { kind: "range", ...ui.timeRange };
  return { kind: "point", timeMs: ui.playheadMs, trackId: ui.selectedTrackId };
}

/**
 * 在选中的片段下方（没有时在窗口中间）打开“问 AI”弹层，范围取当前选择（`Ctrl+Shift+J`、片段快捷条）。
 *
 * @param anchor 锚点元素；省略时找最后一个选中片段的元素。
 */
export function openAskAi(anchor?: Element | null): void {
  const scope = selectionScope();
  const cueId = scope.kind === "clips" ? scope.ids.at(-1) : undefined;
  const el = anchor ?? (cueId ? document.querySelector(`[data-cue-id="${CSS.escape(cueId)}"]`) : null);
  const r = el?.getBoundingClientRect();
  const at = r ? { x: r.left, y: r.bottom + 4 } : { x: Math.round(window.innerWidth / 2 - 160), y: Math.round(window.innerHeight / 3) };
  useAskAiStore.getState().openAt(scope, at);
}

/**
 * 焦点在时间线上（没有聚焦任何控件、在轨道区或片段上）：此时 Tab 用来采纳建议，否则留给焦点切换。
 *
 * @returns 是否在时间线上。
 */
export function timelineFocused(): boolean {
  const a = document.activeElement;
  if (!a || a === document.body) return true;
  return a.id === "timeline-body" || a.closest("[data-cue-id]") !== null;
}
