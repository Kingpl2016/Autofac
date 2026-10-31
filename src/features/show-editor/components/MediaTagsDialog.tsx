import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

import {
  aiErrorText,
  isAiAbort,
  loadLanguageModel,
  unsupportedInput,
  useActiveAiProfile,
  useDisableModality,
  type AiModality,
  type AiProfileView,
} from "@/features/ai";
import { announce } from "@/shared/stores/announcerStore";
import { excerptPlan, uploadBytes, type TagExcerpt } from "../ai/mediaTagsPlan";
import { keyframesJpeg } from "../hooks/videoAnalysisActions";
import { primaryMedia } from "../lib/media";
import { mediaExcerpt } from "../lib/mediaApi";
import { firstClipOf } from "../lib/mediaAnalysis";
import type { MediaRef, ShowProject } from "../lib/project";
import { useAiChatStore } from "../stores/useAiChatStore";
import { currentAnalysis, videoMedia } from "../stores/useMediaAnalysisStore";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 多模态标注：征得同意后，把每个段落中间的一小段音频（16 kHz 单声道）/ 一张关键帧发给当前 AI 配置的模型，
 * 标出曲风、情绪、人声与段落角色（时刻仍来自本地分析）。对话框写明发什么、发给谁、大约多大。
 */

/** 能发什么：配置勾选的输入模态与工程里的素材。 */
function tagCapabilities(profile: Pick<AiProfileView, "inputModalities"> | null, project: Pick<ShowProject, "media" | "mediaClips">) {
  const modalities = profile?.inputModalities ?? [];
  const audio = primaryMedia(project);
  const video = videoMedia(project);
  return { audio: modalities.includes("audio") && !!audio, frames: modalities.includes("image") && !!video, media: audio, video };
}

/** 接口地址的主机名（对话框里写明发给谁）。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 主素材的片段时刻换成视频素材内的时刻（两者是不同素材时按各自片段在时间线上的位置换算）。 */
function videoTimes(project: ShowProject, main: MediaRef, video: MediaRef, plan: readonly TagExcerpt[]): number[] {
  const mid = (p: TagExcerpt) => p.startMs + p.lengthMs / 2;
  if (main.id === video.id) return plan.map(mid);
  const a = firstClipOf(project, main.id);
  const v = firstClipOf(project, video.id);
  if (!a || !v) return plan.map(() => -1);
  return plan.map((p) => {
    const t = mid(p) - a.inMs + a.startMs;
    return t >= v.startMs && t < v.startMs + v.durationMs ? t - v.startMs + v.inMs : -1;
  });
}

/**
 * 标注对话框。
 *
 * @param props 打开状态。
 */
export function MediaTagsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { profile } = useActiveAiProfile(useAiChatStore((s) => s.profileId));
  const project = useProjectStore((s) => s.project);
  const uploadAlways = useAiChatStore((s) => s.uploadAlways);
  const [remember, setRemember] = useState(false);
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 模型拒绝了的输入（两种都发不出去时，错误下方给出“在配置里关闭”） */
  const [rejected, setRejected] = useState<AiModality | null>(null);
  const disableModality = useDisableModality();
  const disableInput = async (target: AiProfileView, m: AiModality) => {
    try {
      await disableModality(target, m);
      setRejected(null);
      setError(null);
      toast.success(t(`editor.mediaTags.disabled_${m}`, { name: target.name }));
    } catch (e) {
      toast.error(aiErrorText(t, e));
    }
  };

  const caps = tagCapabilities(profile, project);
  const analysis = open ? currentAnalysis(project) : null;
  const plan = analysis ? excerptPlan(analysis) : [];
  const bytes = uploadBytes(plan, caps.audio, caps.frames);
  const host = profile ? hostOf(profile.baseUrl) : "";
  // 这个素材已经同意过（或工程设置了总是允许）：打开即开始
  const granted = uploadAlways || (caps.media ? useAiChatStore.getState().media[caps.media.id]?.consent === "granted" : false);
  const started = useRef(false);
  const runRef = useRef<() => Promise<void>>(async () => undefined);

  const run = async () => {
    if (!profile || !caps.media || !analysis || plan.length === 0) return;
    const controller = new AbortController();
    setBusy(controller);
    setError(null);
    setRejected(null);
    const main = caps.media;
    try {
      const [{ tagMedia }, loaded] = await Promise.all([import("../ai/mediaTags"), loadLanguageModel(profile)]);
      const outcome = await tagMedia({
        loaded,
        analysis,
        signal: controller.signal,
        excerpts: caps.audio ? (p) => mediaExcerpt(main.path, p.map((x) => ({ startMs: x.startMs, lengthMs: x.lengthMs }))) : undefined,
        frames:
          caps.frames && caps.video
            ? async (p) => {
                const video = caps.video!;
                const times = videoTimes(project, main, video, p);
                const valid = times.filter((x) => x >= 0);
                const shots = valid.length > 0 ? await keyframesJpeg(video, valid) : [];
                let k = 0;
                return times.map((x) => (x >= 0 ? (shots[k++] ?? "") : ""));
              }
            : undefined,
      });
      if (!outcome) {
        setError(t("editor.mediaTags.nothing"));
        return;
      }
      const { tags, dropped } = outcome;
      // 模型不接受某种输入：只用另一种标注完成；提示并可在配置里关掉它
      for (const m of dropped) {
        toast.warning(t(`editor.mediaTags.dropped_${m}`, { name: profile.name }), {
          duration: 10_000,
          action: { label: t("editor.mediaTags.disableInput"), onClick: () => void disableInput(profile, m) },
        });
      }
      const chat = useAiChatStore.getState();
      chat.setMediaDoc(main.id, { tags, ...(remember ? { consent: "granted" as const } : {}) });
      if (always) chat.setUploadAlways(true);
      announce(t("editor.mediaTags.done", { genre: tags.genre ?? "?", mood: tags.mood ?? "?", count: Object.keys(tags.roles).length }));
      onOpenChange(false);
    } catch (e) {
      if (!isAiAbort(e) && !(e instanceof DOMException && e.name === "AbortError")) {
        setError(aiErrorText(t, e));
        setRejected(unsupportedInput(e));
      }
    } finally {
      setBusy(null);
    }
  };
  // 先于下面的效果更新（效果按声明顺序执行）
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (!open) {
      started.current = false;
      return;
    }
    if (granted && !started.current) {
      started.current = true;
      void runRef.current();
    }
  }, [open, granted]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) busy?.abort();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editor.mediaTags.title")}</DialogTitle>
          <DialogDescription>{t("editor.mediaTags.description")}</DialogDescription>
        </DialogHeader>
        {!profile || (!caps.audio && !caps.frames) ? (
          <p className="text-sm text-muted-foreground">{t("editor.mediaTags.unsupported")}</p>
        ) : plan.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("editor.mediaTags.noSections")}</p>
        ) : (
          <div className="grid gap-3 text-sm">
            <ul className="grid list-disc gap-1 pl-5">
              {caps.audio && <li>{t("editor.mediaTags.sendAudio", { count: plan.length, seconds: Math.round(plan[0].lengthMs / 1000) })}</li>}
              {caps.frames && <li>{t("editor.mediaTags.sendFrames", { count: plan.length })}</li>}
              <li>{t("editor.mediaTags.sendTo", { name: profile.name, host, size: (bytes / 1024 / 1024).toFixed(1) })}</li>
              <li>{t("editor.mediaTags.notSent")}</li>
            </ul>
            <label className="flex items-center gap-2">
              <Checkbox checked={remember || uploadAlways} disabled={uploadAlways} onCheckedChange={(v) => setRemember(v === true)} />
              {t("editor.mediaTags.remember")}
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={always || uploadAlways} onCheckedChange={(v) => (uploadAlways && v !== true ? useAiChatStore.getState().setUploadAlways(false) : setAlways(v === true))} />
              {t("editor.mediaTags.always")}
            </label>
            {error && (
              <div role="alert" className="grid justify-items-start gap-2 text-destructive">
                <p>{error}</p>
                {rejected && (
                  <Button variant="outline" size="sm" onClick={() => void disableInput(profile, rejected)}>
                    {t("editor.mediaTags.disableInput")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => (busy ? busy.abort() : onOpenChange(false))}>
            {t(busy ? "editor.mediaTags.stop" : "common.cancel")}
          </Button>
          <Button disabled={!profile || (!caps.audio && !caps.frames) || plan.length === 0 || !!busy} loading={!!busy} onClick={() => void run()}>
            {t("editor.mediaTags.agree")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
