import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { primaryMedia } from "../lib/media";
import { peakColumns } from "../lib/waveform";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useMediaStore } from "../stores/useMediaStore";
import { useProjectStore } from "../stores/useProjectStore";
import { START_LEFT } from "./timelineData";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 波形条的高度（像素），需与轨道头列顶部的占位一致。 */
export const WAVEFORM_HEIGHT = 40;

/**
 * 主素材的波形条：时间线上方一条带，随横向滚动 / 缩放重绘，素材偏移会体现在位置上。
 *
 * 用 Canvas 逐像素列画竖线，只画可见范围；颜色取自元素的文字颜色（跟随主题）。
 * 主素材没有波形（无音轨、尚在计算）时不显示。
 */
export function WaveformStrip() {
  const { t } = useTranslation();
  const media = useProjectStore((s) => primaryMedia(s.project));
  const peaks = useMediaStore((s) => (media ? s.items[media.id]?.peaks : undefined));
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [peaks]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !peaks || !media || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(WAVEFORM_HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, WAVEFORM_HEIGHT);
    ctx.fillStyle = getComputedStyle(el).color;
    const msPerPx = 1000 / pxPerSec;
    // 第 0 列对应的素材内时刻 = 时间线时刻 - 素材偏移
    const startMs = ((scrollLeft - START_LEFT) / pxPerSec) * 1000 - media.offsetMs;
    const mid = WAVEFORM_HEIGHT / 2;
    const half = mid - 2;
    peakColumns(peaks, startMs, msPerPx, width).forEach((col, x) => {
      if (!col) return;
      const top = mid - (col.max / 127) * half;
      const bottom = mid - (col.min / 127) * half;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    });
  }, [peaks, media, pxPerSec, scrollLeft, width]);

  if (!peaks || !media) return null;
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={t("editor.media.waveform", { name: media.name })}
      className="block w-full shrink-0 border-b border-border bg-surface-2 text-primary/70"
      style={{ height: WAVEFORM_HEIGHT }}
    />
  );
}
