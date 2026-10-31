import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AudioWaveform, Clapperboard, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { primaryMedia } from "../lib/media";
import { ensureVideoAnalysis } from "../hooks/videoAnalysisActions";
import { MediaTagsDialog } from "./MediaTagsDialog";
import { guideCounts } from "../timeline/analysisGuideMarks";
import { useAiChatStore } from "../stores/useAiChatStore";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { sensitivityOf, useMediaAnalysisStore, useTimelineAnalysis, videoMedia } from "../stores/useMediaAnalysisStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 灵敏度档位。 */
const SENSITIVITY_STEPS = { low: 0.7, normal: 1, high: 1.5 } as const;
type Step = keyof typeof SENSITIVITY_STEPS;

/** 最接近的档位。 */
const stepOf = (v: number): Step => (v < 0.85 ? "low" : v > 1.25 ? "high" : "normal");

/**
 * 时间线工具条的“音乐分析”菜单：参考线与 AI 建议的开关、分析概要、灵敏度、重新分析、让忽略过的建议重新出现。
 */
export function AnalysisMenu() {
  const { t } = useTranslation();
  const media = useProjectStore((s) => primaryMedia(s.project));
  const entry = useMediaAnalysisStore((s) => (media ? s.entries[media.id] : undefined));
  // 画面分析（有视频素材时）
  const video = useProjectStore((s) => videoMedia(s.project));
  const videoStatus = useMediaAnalysisStore((s) => (video ? (s.videos[video.id]?.path === video.path ? s.videos[video.id].status : null) : null));
  const analysis = useTimelineAnalysis();
  const guides = useEditorPrefsStore((s) => s.aiGuides);
  const setGuides = useEditorPrefsStore((s) => s.setAiGuides);
  const suggestions = useEditorPrefsStore((s) => s.aiSuggestions);
  const setSuggestions = useEditorPrefsStore((s) => s.setAiSuggestions);
  const dismissed = useAiChatStore((s) => s.dismissedSuggestions.length);
  const [tagsOpen, setTagsOpen] = useState(false);
  useAiChatStore((s) => s.media);
  const busy = entry?.status === "loading" || entry?.refreshing;
  const counts = guideCounts(analysis);
  const step = media ? stepOf(sensitivityOf(media.id)) : "normal";

  const reanalyze = async (value: number) => {
    if (!media) return;
    const ok = await useMediaAnalysisStore.getState().reanalyze(media, value);
    const e = useMediaAnalysisStore.getState().entries[media.id];
    announce(ok ? t("editor.guides.reanalyzed") : t("editor.guides.reanalyzeFailed", { reason: e?.error ?? "" }));
  };

  // 还没分析过（导入素材后不会自动分析）
  const notAnalyzed = !!media && (!entry || entry.status === "none");
  const startAudio = async () => {
    if (!media) return;
    const ok = (await useMediaAnalysisStore.getState().ensure(media)) !== null;
    const e = useMediaAnalysisStore.getState().entries[media.id];
    announce(ok ? t("editor.guides.reanalyzed") : t("editor.guides.reanalyzeFailed", { reason: e?.error ?? "" }));
  };
  const startVideo = async () => {
    if (!video) return;
    announce(t((await ensureVideoAnalysis(video)) ? "editor.guides.video.ready" : "editor.guides.video.error"));
  };
  const videoIdle = !!video && (videoStatus === null || videoStatus === "none" || videoStatus === "error");

  let status: string;
  if (!media) status = t("editor.guides.noMedia");
  else if (notAnalyzed) status = t("editor.guides.notAnalyzed");
  else if (busy && !analysis) status = t("editor.guides.running");
  else if (analysis && analysis.bpm > 0) status = t("editor.guides.status", { bpm: analysis.bpm, sections: analysis.sections.length, hits: counts.hit, drops: counts.drop, cuts: counts.cut });
  else status = t("editor.guides.failed", { reason: entry?.error ?? "" });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-tour="ai-guides"
          className={cn("size-6", guides && analysis && "bg-primary/20 text-primary")}
          aria-label={t("editor.guides.menu")}
          title={t("editor.guides.menu")}
        >
          {busy ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <AudioWaveform aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" aria-label={t("editor.guides.menu")}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{status}</DropdownMenuLabel>
        {videoStatus && videoStatus !== "none" && (
          <DropdownMenuLabel className="pt-0 text-xs font-normal text-muted-foreground">{t(`editor.guides.video.${videoStatus}`)}</DropdownMenuLabel>
        )}
        {(notAnalyzed || (entry?.status === "error" && !entry.audio)) && (
          <DropdownMenuItem onSelect={() => void startAudio()}>
            <AudioWaveform aria-hidden />
            {t("editor.guides.analyzeAudio", { name: media?.name ?? "" })}
          </DropdownMenuItem>
        )}
        {entry?.status === "loading" && media && (
          <DropdownMenuItem onSelect={() => useMediaAnalysisStore.getState().cancel(media.id)}>{t("editor.guides.cancelAnalysis")}</DropdownMenuItem>
        )}
        {videoIdle && (
          <DropdownMenuItem onSelect={() => void startVideo()}>
            <Clapperboard aria-hidden />
            {t("editor.guides.analyzeVideo", { name: video?.name ?? "" })}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={guides} onCheckedChange={(on) => setGuides(on === true)} onSelect={(e) => e.preventDefault()}>
          {t("editor.guides.show")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={suggestions} onCheckedChange={(on) => setSuggestions(on === true)} onSelect={(e) => e.preventDefault()}>
          {t("editor.guides.suggestions")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("editor.guides.sensitivity")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={step} onValueChange={(v) => void reanalyze(SENSITIVITY_STEPS[v as Step])}>
          {(Object.keys(SENSITIVITY_STEPS) as Step[]).map((k) => (
            <DropdownMenuRadioItem key={k} value={k} disabled={!media || busy}>
              {t(`editor.guides.steps.${k}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!media || busy} onSelect={() => media && void reanalyze(sensitivityOf(media.id))}>
          {t("editor.guides.reanalyze")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!analysis || analysis.sections.length === 0} onSelect={() => setTagsOpen(true)}>
          {t("editor.mediaTags.menu")}
          {analysis?.tags?.genre && <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{analysis.tags.genre}</span>}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={dismissed === 0}
          onSelect={() => {
            useAiChatStore.getState().resetSuggestions();
            announce(t("editor.guides.suggestionsReset"));
          }}
        >
          {t("editor.guides.resetSuggestions", { count: dismissed })}
        </DropdownMenuItem>
      </DropdownMenuContent>
      {tagsOpen && <MediaTagsDialog open onOpenChange={setTagsOpen} />}
    </DropdownMenu>
  );
}
