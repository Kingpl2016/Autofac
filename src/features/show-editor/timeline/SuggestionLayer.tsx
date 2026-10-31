import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Check, Lightbulb, Sparkles, X } from "lucide-react";

import { useWindowKeydown } from "@/shared/hooks/useWindowKeydown";
import { isTextEntry } from "@/shared/lib/keyboard";
import { announce } from "@/shared/stores/announcerStore";
import { cn } from "@/lib/utils";
import { visibleSuggestions, type Suggestion } from "../ai/suggestions";
import { acceptWithAnnounce, refineSuggestion, suggestionText } from "../hooks/suggestionActions";
import {
  activeSuggestion,
  dismissSuggestion,
  planSuggestion,
  useAiSuggestionStore,
  useTimelineSuggestions,
} from "../stores/useAiSuggestionStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import type { RowLayout } from "./timelineLayout";

/** 建议卡片的高度（像素，多张时上下错开）。 */
const CHIP_STEP = 30;

interface SuggestionLayerProps {
  trackIndex: ReadonlyMap<string, number>;
  layout: RowLayout;
  rowFrom: number;
  rowTo: number;
  timeFrom: number;
  timeTo: number;
  xOf: (ms: number) => number;
}

/** 一张建议卡片：说明，采纳（Tab）/ 忽略（Esc）/ 让 AI 细化。 */
function SuggestionChip({ s, left, top, active, first }: { s: Suggestion; left: number; top: number; active: boolean; first: boolean }) {
  const { t } = useTranslation();
  const setHover = useAiSuggestionStore((st) => st.setHover);
  const text = suggestionText(t, s);
  const btn = "inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div
      role="group"
      aria-label={t("editor.suggest.label", { text })}
      data-suggestion={s.rule}
      data-tour={first ? "ai-suggestion" : undefined}
      className={cn(
        "absolute z-30 flex max-w-[22rem] items-center gap-1 rounded-md border border-dashed border-primary/70 bg-popover/95 px-1.5 py-0.5 text-[11px] text-popover-foreground shadow-sm backdrop-blur-sm",
        active && "border-solid ring-2 ring-primary/40",
      )}
      style={{ left, top }}
      onPointerEnter={() => setHover(s.id)}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Lightbulb className="size-3 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      <button type="button" className={cn(btn, "text-primary")} aria-label={t("editor.suggest.accept")} title={t("editor.suggest.acceptHint")} onClick={() => acceptWithAnnounce(s, t)}>
        <Check className="size-3" aria-hidden />
        {active && <kbd className="font-sans text-[10px] text-muted-foreground">Tab</kbd>}
      </button>
      <button
        type="button"
        className={btn}
        aria-label={t("editor.suggest.refine.label")}
        title={t("editor.suggest.refine.label")}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          refineSuggestion(s, t, { x: r.left, y: r.bottom + 4 });
        }}
      >
        <Sparkles className="size-3" aria-hidden />
      </button>
      <button
        type="button"
        className={cn(btn, "text-muted-foreground")}
        aria-label={t("editor.suggest.dismiss")}
        title={t("editor.suggest.dismissHint")}
        onClick={() => {
          dismissSuggestion(s);
          announce(t("editor.suggest.dismissed"));
        }}
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}

/**
 * 时间线上的主动建议层：可见范围里最多 3 条，建议放的片段画成点线虚影（不能拖动、不挡操作），
 * 卡片放在可见区域顶部。当前建议（悬停 / 播放头所在）按 Esc 忽略（没有选中内容时；有选择时 Esc 照常取消选择）。
 */
export const SuggestionLayer = memo(function SuggestionLayer({ trackIndex, layout, rowFrom, rowTo, timeFrom, timeTo, xOf }: SuggestionLayerProps) {
  const { t } = useTranslation();
  const { list, project } = useTimelineSuggestions();
  const hoverId = useAiSuggestionStore((s) => s.hoverId);
  // 只在播放头跨过建议边界时更新（播放时不每帧重绘）
  const playheadIn = useEditorUiStore((s) => list.find((x) => s.playheadMs >= x.startMs && s.playheadMs < x.endMs)?.id ?? null);

  useWindowKeydown(
    (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTextEntry(e.target)) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      const ui = useEditorUiStore.getState();
      if (ui.selectedCueIds.length > 0 || ui.timeRange || ui.selectedTimelineObject || ui.selectedMediaClipIds.length > 0) return;
      const s = activeSuggestion();
      if (!s) return;
      e.preventDefault();
      dismissSuggestion(s);
      announce(t("editor.suggest.dismissed"));
    },
    { enabled: list.length > 0, capture: true },
  );

  if (list.length === 0 || rowTo <= rowFrom) return null;
  const playheadMs = useEditorUiStore.getState().playheadMs;
  const shown = visibleSuggestions(list, timeFrom, timeTo, playheadMs).flatMap((s) => {
    const plan = planSuggestion(project, s);
    return plan ? [{ s, plan }] : [];
  });
  const topBase = (layout.tops[rowFrom] ?? 0) + 2;
  const minLeft = xOf(timeFrom) + 4;
  return (
    <>
      {shown.map(({ s, plan }, i) => {
        const active = s.id === (hoverId ?? playheadIn);
        return (
          <div key={s.id} className="contents">
            {plan.cues.map((c) => {
              const row = trackIndex.get(c.trackId);
              if (row === undefined || row < rowFrom || row >= rowTo || c.endMs < timeFrom || c.startMs > timeTo) return null;
              return (
                <div
                  key={`${s.id}-${c.id}`}
                  aria-hidden
                  data-suggestion-ghost={s.rule}
                  className={cn(
                    "pointer-events-none absolute z-[14] rounded-sm border-2 border-dotted border-primary/60 bg-primary/5",
                    active && "border-primary bg-primary/10",
                  )}
                  style={{ left: xOf(c.startMs), width: Math.max(4, xOf(c.endMs) - xOf(c.startMs)), top: layout.tops[row] + 3, height: Math.max(8, layout.heights[row] - 6) }}
                />
              );
            })}
            <SuggestionChip s={s} active={active} first={i === 0} left={Math.max(minLeft, xOf(s.startMs))} top={topBase + i * CHIP_STEP} />
          </div>
        );
      })}
    </>
  );
});
