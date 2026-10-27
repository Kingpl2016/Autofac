import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Film, Music, VolumeX } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Peaks } from "../lib/mediaApi";
import type { MediaClip, MediaRef } from "../lib/project";
import { formatTimecode } from "../lib/time";
import { peakColumns } from "../lib/waveform";

/** 片段宽度小于这个值时不显示裁剪手柄。 */
const MIN_HANDLE_WIDTH_PX = 18;

interface MediaClipViewProps {
  clip: MediaClip;
  media: MediaRef;
  peaks: Peaks | undefined;
  /** 片段在内容坐标里的位置与尺寸 */
  left: number;
  top: number;
  width: number;
  height: number;
  /** 可见的横向范围（内容坐标），只在这一段画波形 */
  visibleFrom: number;
  visibleTo: number;
  pxPerSec: number;
  selected: boolean;
  locked: boolean;
  dimmed: boolean;
  dragging: boolean;
  invalid: boolean;
}

/**
 * 媒体轨道上的一个片段：类型色底 + 名称 + 波形（只画可见部分）+ 淡入淡出斜线 + 左右裁剪手柄。
 *
 * 指针交互由媒体轨道区统一处理，这里只用 `data-media-clip-id` / `data-edge` 标出命中区域。
 */
export const MediaClipView = memo(function MediaClipView({
  clip,
  media,
  peaks,
  left,
  top,
  width,
  height,
  visibleFrom,
  visibleTo,
  pxPerSec,
  selected,
  locked,
  dimmed,
  dragging,
  invalid,
}: MediaClipViewProps) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  // 波形只画在片段与视口的交集上
  const drawFrom = Math.max(left, visibleFrom);
  const drawTo = Math.min(left + width, visibleTo);
  const drawWidth = Math.max(0, Math.floor(drawTo - drawFrom));
  const waveHeight = Math.max(0, height - 16);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !peaks || drawWidth === 0 || waveHeight < 8) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(drawWidth * dpr);
    el.height = Math.round(waveHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, drawWidth, waveHeight);
    ctx.fillStyle = getComputedStyle(el).color;
    const msPerPx = 1000 / pxPerSec;
    // 第 0 列对应的素材内时刻 = 入点 + （可见起点 − 片段左边缘）
    const startMs = clip.inMs + (drawFrom - left) * msPerPx;
    const mid = waveHeight / 2;
    const half = mid - 1;
    const scale = clip.muted ? 0.2 : Math.max(0.15, clip.volume);
    peakColumns(peaks, startMs, msPerPx, drawWidth).forEach((col, x) => {
      if (!col) return;
      const topY = mid - (col.max / 127) * half * scale;
      const bottomY = mid - (col.min / 127) * half * scale;
      ctx.fillRect(x, topY, 1, Math.max(1, bottomY - topY));
    });
  }, [peaks, drawWidth, drawFrom, left, waveHeight, pxPerSec, clip.inMs, clip.volume, clip.muted]);

  const label = t("editor.mediaTracks.clipLabel", {
    name: media.name,
    start: formatTimecode(clip.startMs),
    end: formatTimecode(clip.startMs + clip.durationMs),
  });
  const handles = !locked && width >= MIN_HANDLE_WIDTH_PX;
  const fadeIn = (clip.fadeInMs / Math.max(1, clip.durationMs)) * 100;
  const fadeOut = (clip.fadeOutMs / Math.max(1, clip.durationMs)) * 100;
  const Icon = media.kind === "video" ? Film : Music;

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={label}
      aria-pressed={selected}
      data-media-clip-id={clip.id}
      className={cn(
        "group absolute overflow-hidden rounded-[5px] border",
        media.kind === "video" ? "bg-clip-video/25 text-clip-video" : "bg-clip-audio/25 text-clip-audio",
        locked ? "cursor-default" : "cursor-grab",
        selected ? "border-foreground ring-1 ring-foreground/70" : "border-border/70",
        dimmed && "opacity-45",
        dragging && "z-10 cursor-grabbing shadow-lg",
        invalid && "border-destructive ring-1 ring-destructive",
      )}
      style={{ left, top, width: Math.max(2, width), height }}
    >
      <div className="pointer-events-none flex h-4 items-center gap-1 px-1 text-[10px] text-foreground/80">
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{media.name}</span>
        {clip.muted && <VolumeX aria-hidden className="size-3 shrink-0" />}
        {!clip.muted && clip.volume < 1 && <span className="num shrink-0 text-muted-foreground">{Math.round(clip.volume * 100)}%</span>}
      </div>
      {peaks && drawWidth > 0 && waveHeight >= 8 && (
        <canvas
          ref={canvas}
          aria-hidden
          data-testid="media-clip-wave"
          className="pointer-events-none absolute"
          style={{ left: drawFrom - left, top: 16, width: drawWidth, height: waveHeight }}
        />
      )}
      {/* 淡入淡出：左上 / 右上的斜线三角 */}
      {fadeIn > 0 && (
        <svg aria-hidden className="pointer-events-none absolute inset-y-0 left-0 h-full" style={{ width: `${fadeIn}%` }} preserveAspectRatio="none" viewBox="0 0 10 10">
          <path d="M0 10 L10 0 L0 0 Z" className="fill-background/45" />
          <path d="M0 10 L10 0" className="stroke-foreground/60" strokeWidth={0.4} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {fadeOut > 0 && (
        <svg aria-hidden className="pointer-events-none absolute inset-y-0 right-0 h-full" style={{ width: `${fadeOut}%` }} preserveAspectRatio="none" viewBox="0 0 10 10">
          <path d="M0 0 L10 10 L10 0 Z" className="fill-background/45" />
          <path d="M0 0 L10 10" className="stroke-foreground/60" strokeWidth={0.4} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {handles && (
        <>
          <span
            aria-hidden
            data-edge="start"
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-foreground/0 transition-colors group-hover:bg-foreground/25"
          />
          <span
            aria-hidden
            data-edge="end"
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-foreground/0 transition-colors group-hover:bg-foreground/25"
          />
        </>
      )}
    </div>
  );
});
