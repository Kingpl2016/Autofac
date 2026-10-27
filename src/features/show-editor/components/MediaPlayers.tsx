import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { planSync } from "../lib/mediaSync";
import type { MediaRef } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useMediaStore } from "../stores/useMediaStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";

type MediaElement = HTMLAudioElement | HTMLVideoElement;

/**
 * 渲染并同步所有可播放的音视频素材。
 *
 * 后端是播放主时钟：每次后端推送位置（播放中约 30 次/秒）、或用户在未播放时拖动播放头，
 * 就按 {@link planSync} 的策略让每个元素跟上 —— 小偏差用变速追平，大偏差直接跳转。
 * 第一个视频显示在预览区，其余素材隐藏播放（只出声）。
 * 当前系统无法播放的格式、以及文件丢失的素材不会渲染元素。
 */
export const MediaPlayers = memo(function MediaPlayers() {
  const { t } = useTranslation();
  const media = useProjectStore((s) => s.project.media);
  const items = useMediaStore((s) => s.items);
  const muted = useEditorUiStore((s) => s.mediaMuted);
  const elements = useRef(new Map<string, MediaElement>());
  const reported = useRef(new Set<string>());

  const playable = media.filter((m) => {
    const rt = items[m.id];
    return rt?.status === "ready" && rt.url !== undefined && !rt.unplayable;
  });
  const visibleVideoId = playable.find((m) => m.kind === "video")?.id;

  useEffect(() => {
    const byId = new Map(media.map((m) => [m.id, m]));
    const fail = (m: MediaRef) => {
      if (reported.current.has(m.id)) return;
      reported.current.add(m.id);
      toast.error(t("editor.media.errors.playFailed", { name: m.name }));
    };
    const sync = () => {
      const state = usePlaybackStore.getState().state;
      const transport = state?.transport ?? "stopped";
      for (const [id, el] of elements.current) {
        const m = byId.get(id);
        if (!m) continue;
        const plan = planSync({
          transport,
          // 播放中以后端位置为准；未播放时以播放头为准（拖动播放头时后端会稍后回报同一位置）
          positionMs: transport === "playing" ? (state?.positionMs ?? 0) : useEditorUiStore.getState().playheadMs,
          offsetMs: m.offsetMs,
          mediaDurationMs: m.durationMs,
          currentTimeMs: el.currentTime * 1000,
          elementPaused: el.paused,
        });
        if (plan.seekToMs !== null) el.currentTime = plan.seekToMs / 1000;
        if (el.playbackRate !== plan.rate) el.playbackRate = plan.rate;
        if (plan.play) {
          void Promise.resolve(el.play()).catch(() => fail(m));
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
  }, [media, items, t]);

  // 元素被移除（素材删除、文件丢失、离开页面）时先停掉，免得声音留在后台
  const register = (id: string) => (el: MediaElement | null) => {
    if (el) {
      elements.current.set(id, el);
    } else {
      elements.current.get(id)?.pause();
      elements.current.delete(id);
    }
  };

  return (
    <>
      {playable.map((m) => {
        const url = items[m.id]?.url;
        if (m.kind === "video") {
          const shown = m.id === visibleVideoId;
          return (
            <video
              key={m.id}
              ref={register(m.id)}
              src={url}
              muted={muted}
              preload="auto"
              playsInline
              aria-label={shown ? t("editor.preview.video", { name: m.name }) : undefined}
              aria-hidden={!shown}
              className={shown ? "max-h-64 w-full rounded-md bg-surface-2 object-contain" : "hidden"}
            />
          );
        }
        return <audio key={m.id} ref={register(m.id)} src={url} muted={muted} preload="auto" className="hidden" />;
      })}
    </>
  );
});
