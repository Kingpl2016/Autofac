import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useElementSize } from "@/shared/hooks/useElementSize";
import { cn } from "@/lib/utils";
import { primaryMedia } from "../lib/media";
import type { TimelineEvent, TimelineSection } from "../lib/mediaAnalysis";
import { useAiChatStore } from "../stores/useAiChatStore";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { peekVideoAnalysis } from "../hooks/videoAnalysisActions";
import { useMediaAnalysisStore, useTimelineAnalysis, videoMedia } from "../stores/useMediaAnalysisStore";
import { useProjectStore } from "../stores/useProjectStore";
import { guideMarks } from "./analysisGuideMarks";
import { START_LEFT } from "./timelineData";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 一个分析段落的标签（点开可以改；改过的以用户的为准，可恢复成分析结果）。 */
function SectionLabel({ section, left, mediaId }: { section: TimelineSection; left: number; mediaId: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(section.label);
  const [open, setOpen] = useState(false);
  const unsure = !section.edited && section.labelConfidence < 0.5;
  const save = (label: string | null) => {
    const chat = useAiChatStore.getState();
    const prefs = chat.media[mediaId]?.prefs ?? { sensitivity: 1, labels: {} };
    const labels = { ...prefs.labels };
    const key = String(section.sourceStartMs);
    if (label && label.trim()) labels[key] = label.trim().slice(0, 24);
    else delete labels[key];
    chat.setMediaDoc(mediaId, { prefs: { ...prefs, labels } });
    setOpen(false);
  };
  const text = `${section.label}${unsure ? "?" : ""}${section.role ? ` · ${t(`editor.guides.roles.${section.role}`, { defaultValue: section.role })}` : ""}`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(section.label);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-guide-label
          className={cn(
            "pointer-events-auto absolute top-0.5 z-20 max-w-32 truncate rounded-sm px-1 text-[10px] leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            section.edited ? "bg-primary/25 text-primary" : "bg-background/70 text-muted-foreground hover:text-foreground",
          )}
          style={{ left: Math.max(0, left) + 2 }}
          aria-label={t("editor.guides.label", { label: text })}
          title={unsure ? t("editor.guides.unsure") : t("editor.guides.editLabel")}
        >
          {text}
        </button>
      </PopoverTrigger>
      <PopoverContent className="grid w-56 gap-2 p-3" align="start">
        <label className="grid gap-1 text-xs">
          {t("editor.guides.labelField")}
          <Input
            value={draft}
            maxLength={24}
            className="h-8 text-sm"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save(draft)}
          />
        </label>
        <p className="text-[11px] text-muted-foreground">{t("editor.guides.labelHint")}</p>
        <div className="flex justify-end gap-1.5">
          {section.edited && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => save(null)}>
              {t("editor.guides.resetLabel")}
            </Button>
          )}
          <Button size="sm" className="h-7 px-2 text-xs" onClick={() => save(draft)}>
            {t("common.save")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 每种事件的线条样式（只用语义色，主题换色时跟着变）。 */
const LINE_CLASS: Record<TimelineEvent["kind"], string> = {
  hit: "stroke-primary/35",
  drop: "stroke-warning",
  break: "stroke-muted-foreground",
  cut: "stroke-chart-2",
  build: "",
};

/**
 * 音乐分析的参考线：叠在轨道区上（在节拍网格之上、片段之下），不拦截指针事件。
 *
 * 重拍画细线，爆点 / 断层 / 切镜画粗线（切镜为虚线），渐强画渐变带；分析段落的结构标签显示在顶部，可点开修改。
 * 打开时（参考线开着且有主素材）开始分析主素材（后端有缓存）。
 */
export function AnalysisGuides() {
  const { t } = useTranslation();
  const show = useEditorPrefsStore((s) => s.aiGuides);
  const media = useProjectStore((s) => primaryMedia(s.project));
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const analysis = useTimelineAnalysis();
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);

  // 视频素材（画面分析，切镜参考线）
  const video = useProjectStore((s) => videoMedia(s.project));
  useEffect(() => {
    // 只读缓存：导入素材后不自动分析（分析在“音乐分析”菜单里手动开始，或 AI 生成时进行）
    if (show && media) void useMediaAnalysisStore.getState().peek(media);
  }, [show, media]);
  useEffect(() => {
    if (show && video) void peekVideoAnalysis(video);
  }, [show, video]);

  const marks = useMemo(
    () => (show && analysis && width > 0 ? guideMarks(analysis.events, { scrollLeft, width, pxPerSec }) : []),
    [show, analysis, scrollLeft, width, pxPerSec],
  );
  const labels = useMemo(() => {
    if (!show || !analysis || width === 0) return [];
    return analysis.sections
      .map((s) => ({ s, left: START_LEFT + (s.startMs / 1000) * pxPerSec - scrollLeft, right: START_LEFT + (s.endMs / 1000) * pxPerSec - scrollLeft }))
      .filter((l) => l.right > 0 && l.left < width);
  }, [show, analysis, scrollLeft, width, pxPerSec]);

  if (!show) return null;
  return (
    <div ref={ref} data-testid="analysis-guides" className="pointer-events-none absolute inset-0 z-[1] overflow-hidden">
      <svg aria-hidden className="h-full w-full">
        <defs>
          <linearGradient id="ans-build" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" className="[stop-color:var(--color-warning)]" stopOpacity="0" />
            <stop offset="100%" className="[stop-color:var(--color-warning)]" stopOpacity="0.22" />
          </linearGradient>
        </defs>
        {marks.map((m) =>
          m.kind === "build" ? (
            <rect key={m.key} x={m.x} y={0} width={Math.max(1, m.width ?? 0)} height="100%" fill="url(#ans-build)" />
          ) : (
            <line
              key={m.key}
              x1={m.x}
              x2={m.x}
              y1={0}
              y2="100%"
              className={LINE_CLASS[m.kind]}
              strokeWidth={m.kind === "hit" ? 1 : 2}
              strokeDasharray={m.kind === "cut" ? "4 3" : undefined}
            />
          ),
        )}
      </svg>
      {analysis && media && labels.map((l) => <SectionLabel key={l.s.sourceStartMs} section={l.s} left={l.left} mediaId={media.id} />)}
      {analysis && <span className="sr-only">{t("editor.guides.summary", { sections: analysis.sections.length, events: analysis.events.length })}</span>}
    </div>
  );
}
