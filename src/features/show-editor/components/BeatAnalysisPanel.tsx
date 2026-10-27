import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AudioWaveform, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { announce } from "@/shared/stores/announcerStore";
import { primaryMedia } from "../lib/media";
import { MEDIA_ERR, mediaAnalyzeBeats, type BeatAnalysis } from "../lib/mediaApi";
import { applyBeatPlan, planFromAnalysis, type BeatPlan } from "../lib/sections";
import { useProjectStore } from "../stores/useProjectStore";

type State =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; analysis: BeatAnalysis; plan: BeatPlan; name: string }
  | { status: "error"; message: string };

/**
 * 从音乐自动分析节拍（节拍设置弹层里的一节）：分析主素材（时间线上最早的音频），给出 BPM、置信度和段落数，
 * 一键应用为节拍网格（强拍对齐），或连同按能量划分的段落一起应用（替换现有段落）。
 *
 * 分析在后端完成并缓存；时刻按素材在时间线上的位置（片段起点 − 入点）换算。
 */
export function BeatAnalysisPanel() {
  const { t } = useTranslation();
  const media = useProjectStore((s) => primaryMedia(s.project));
  const update = useProjectStore((s) => s.update);
  const [state, setState] = useState<State>({ status: "idle" });

  const run = async () => {
    if (!media) return;
    setState({ status: "running" });
    try {
      const analysis = await mediaAnalyzeBeats(media.path);
      const project = useProjectStore.getState().project;
      // 用该素材在时间线上最早的片段定位；还没放上时间线时按 0 点
      const clip = [...project.mediaClips].filter((c) => c.mediaId === media.id).sort((a, b) => a.startMs - b.startMs)[0] ?? null;
      const plan = planFromAnalysis(analysis, clip, {
        low: t("editor.beats.tier.low"),
        mid: t("editor.beats.tier.mid"),
        high: t("editor.beats.tier.high"),
      });
      setState({ status: "done", analysis, plan, name: media.name });
    } catch (e) {
      const code = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      setState({
        status: "error",
        message: code === MEDIA_ERR.noBeat ? t("editor.beats.noBeat") : t("editor.beats.failed", { reason: code }),
      });
    }
  };

  const apply = (withSections: boolean) => {
    if (state.status !== "done") return;
    update((d) => applyBeatPlan(d, state.plan, withSections));
    announce(
      withSections
        ? t("editor.beats.appliedWithSections", { bpm: state.plan.tempo.bpm, count: state.plan.sections.length })
        : t("editor.beats.applied", { bpm: state.plan.tempo.bpm }),
    );
  };

  return (
    <section aria-label={t("editor.beats.title")} className="grid gap-2 border-t border-border pt-3">
      <h4 className="text-xs font-medium">{t("editor.beats.title")}</h4>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 justify-start gap-1.5"
        disabled={!media || state.status === "running"}
        onClick={() => void run()}
      >
        {state.status === "running" ? <Loader2 aria-hidden className="animate-spin" /> : <AudioWaveform aria-hidden />}
        <span className="truncate">{media ? t("editor.beats.analyze", { name: media.name }) : t("editor.beats.noMedia")}</span>
      </Button>
      <div role="status" aria-live="polite" className="text-xs">
        {state.status === "running" && <span className="text-muted-foreground">{t("editor.beats.running")}</span>}
        {state.status === "error" && <span className="text-destructive">{state.message}</span>}
        {state.status === "done" && (
          <span>
            {t("editor.beats.result", {
              bpm: state.plan.tempo.bpm,
              confidence: Math.round(state.analysis.confidence * 100),
              count: state.plan.sections.length,
            })}
          </span>
        )}
      </div>
      {state.status === "done" && (
        <>
          {state.analysis.confidence < 0.4 && <p className="text-xs text-warning">{t("editor.beats.lowConfidence")}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="h-8" onClick={() => apply(false)}>
              {t("editor.beats.applyTempo")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              disabled={state.plan.sections.length === 0}
              onClick={() => apply(true)}
            >
              {t("editor.beats.applyAll", { count: state.plan.sections.length })}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
