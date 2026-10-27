import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { mediaGainAt, visibleVideoClip } from "../lib/mediaClips";
import { planSync } from "../lib/mediaSync";
import type { MediaClip, MediaRef } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useMediaStore } from "../stores/useMediaStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";

type MediaElement = HTMLAudioElement | HTMLVideoElement;

/** 当前时间线位置：播放中以后端为准，否则以播放头为准（拖动播放头时后端会稍后回报同一位置）。 */
function timelinePosition(): { transport: "playing" | "paused" | "stopped"; positionMs: number } {
  const state = usePlaybackStore.getState().state;
  const transport = state?.transport ?? "stopped";
  return {
    transport,
    positionMs: transport === "playing" ? (state?.positionMs ?? 0) : useEditorUiStore.getState().playheadMs,
  };
}

/**
 * 渲染并同步时间线上的所有媒体片段（每个片段一个 `<audio>` / `<video>` 元素，同一素材可以放多次）。
 *
 * 后端是播放主时钟：每次后端推送位置（播放中约 30 次/秒）、或用户在未播放时拖动播放头，
 * 就按 {@link planSync} 的策略让每个元素跟上片段的入点 / 出点 —— 小偏差用变速追平，大偏差直接跳转；
 * 同时按 {@link mediaGainAt} 设置音量（片段音量 × 轨道音量 × 淡入淡出，静音 / 独奏）。
 * 播放头处只显示一个视频：最上面那条有片段的视频轨道（上面的盖住下面的），其余视频隐藏播放（只出声）。
 * 当前系统无法播放的格式、以及文件丢失的素材不会渲染元素。
 */
export const MediaPlayers = memo(function MediaPlayers() {
  const { t } = useTranslation();
  const media = useProjectStore((s) => s.project.media);
  const clips = useProjectStore((s) => s.project.mediaClips);
  const tracks = useProjectStore((s) => s.project.mediaTracks);
  const items = useMediaStore((s) => s.items);
  const muted = useEditorUiStore((s) => s.mediaMuted);
  // 显示哪个视频随播放头（播放中跟随后端位置）变化：只订阅结果，避免每帧重新渲染
  const visibleId = useEditorUiStore((s) => visibleVideoClip({ mediaTracks: tracks, mediaClips: clips }, s.playheadMs));
  const elements = useRef(new Map<string, MediaElement>());
  const reported = useRef(new Set<string>());

  const mediaById = new Map(media.map((m) => [m.id, m]));
  const playable = clips.filter((c) => {
    const rt = items[c.mediaId];
    return rt?.status === "ready" && rt.url !== undefined && !rt.unplayable && mediaById.has(c.mediaId);
  });

  useEffect(() => {
    const byClip = new Map(clips.map((c) => [c.id, c]));
    const trackById = new Map(tracks.map((tr) => [tr.id, tr]));
    const sourceById = new Map(media.map((m) => [m.id, m]));
    const anySolo = tracks.some((tr) => tr.solo);
    const fail = (m: MediaRef) => {
      if (reported.current.has(m.id)) return;
      reported.current.add(m.id);
      toast.error(t("editor.media.errors.playFailed", { name: m.name }));
    };
    const sync = () => {
      const { transport, positionMs } = timelinePosition();
      for (const [id, el] of elements.current) {
        const clip = byClip.get(id);
        const track = clip ? trackById.get(clip.trackId) : undefined;
        const source = clip ? sourceById.get(clip.mediaId) : undefined;
        if (!clip || !track || !source) continue;
        const plan = planSync({
          transport,
          positionMs,
          offsetMs: clip.startMs - clip.inMs,
          rangeStartMs: clip.inMs,
          mediaDurationMs: clip.inMs + clip.durationMs,
          currentTimeMs: el.currentTime * 1000,
          elementPaused: el.paused,
        });
        if (plan.seekToMs !== null) el.currentTime = plan.seekToMs / 1000;
        if (el.playbackRate !== plan.rate) el.playbackRate = plan.rate;
        const gain = mediaGainAt(clip, track, positionMs, anySolo);
        if (Math.abs(el.volume - gain) > 0.005) el.volume = gain;
        if (plan.play) {
          void Promise.resolve(el.play()).catch(() => fail(source));
        } else if (plan.pause && !el.paused) {
          el.pause();
        }
      }
    };
    sync();
    const offState = usePlaybackStore.subscribe(sync);
    const offPlayhead = useEditorUiStore.subscribe((s, prev) => {
      if (s.playheadMs !== prev.playheadMs && usePlaybackStore.getState().state?.transport !== "playing") sync();
    });
    return () => {
      offState();
      offPlayhead();
    };
  }, [clips, tracks, media, items, t]);

  // 元素被移除（片段删除、文件丢失、离开页面）时先停掉，免得声音留在后台
  const register = (id: string) => (el: MediaElement | null) => {
    if (el) {
      elements.current.set(id, el);
    } else {
      elements.current.get(id)?.pause();
      elements.current.delete(id);
    }
  };

  const element = (c: MediaClip) => {
    const source = mediaById.get(c.mediaId) as MediaRef;
    const url = items[c.mediaId]?.url;
    if (source.kind === "video") {
      const shown = c.id === visibleId;
      return (
        <video
          key={c.id}
          ref={register(c.id)}
          src={url}
          muted={muted}
          preload="auto"
          playsInline
          data-clip-id={c.id}
          aria-label={shown ? t("editor.preview.video", { name: source.name }) : undefined}
          aria-hidden={!shown}
          className={shown ? "max-h-64 w-full rounded-md bg-surface-2 object-contain" : "hidden"}
        />
      );
    }
    return <audio key={c.id} ref={register(c.id)} data-clip-id={c.id} src={url} muted={muted} preload="auto" className="hidden" />;
  };

  return <>{playable.map(element)}</>;
});
