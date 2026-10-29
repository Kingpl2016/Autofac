import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { useAppearanceRevision } from "@/features/appearance";
import { useElementSize } from "@/shared/hooks/useElementSize";
import { prepareCanvas } from "@/shared/lib/canvas";
import { clamp } from "@/shared/lib/math";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { contentWidth, START_LEFT } from "./timelineData";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 概览条高度（像素）。 */
export const OVERVIEW_HEIGHT = 22;

/** 片段类型 → 颜色 token。 */
const KIND_TOKEN = { static: "--clip-light", look: "--clip-light", scene: "--clip-scene", effect: "--clip-effect" } as const;

/**
 * 全片概览条（剪映底部的缩略导航）：整场节目压缩成一条，每条轨道一行细线画出片段分布，
 * 方框是当前视口；点击或拖动方框横向跳转，←/→ 翻页。
 *
 * @param props.onScrollTo 请求轨道区横向滚动到某个位置（像素）。
 */
export function OverviewBar({ onScrollTo }: { onScrollTo: (left: number) => void }) {
  const { t } = useTranslation();
  const tracks = useProjectStore((s) => s.project.tracks);
  const cues = useProjectStore((s) => s.project.cues);
  const durationMs = useProjectStore((s) => s.project.durationMs);
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const viewWidth = useTimelineScrollStore((s) => s.viewWidth);
  const revision = useAppearanceRevision();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width } = useElementSize(wrapRef);
  const dragging = useRef<{ offset: number } | null>(null);

  const total = Math.max(1, contentWidth(durationMs, pxPerSec));
  const scale = width / total;
  const boxLeft = scrollLeft * scale;
  const boxWidth = Math.max(8, Math.min(width, viewWidth * scale));

  // 片段分布：每条轨道一行细线，颜色按片段类型
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const ctx = prepareCanvas(canvas, width, OVERVIEW_HEIGHT);
    if (!ctx) return;
    const style = getComputedStyle(canvas);
    const colors = Object.fromEntries(
      Object.entries(KIND_TOKEN).map(([k, v]) => [k, style.getPropertyValue(v).trim() || "gray"]),
    ) as Record<keyof typeof KIND_TOKEN, string>;
    const rows = Math.max(1, tracks.length);
    const rowH = Math.max(1, (OVERVIEW_HEIGHT - 4) / rows);
    const index = new Map(tracks.map((tr, i) => [tr.id, i]));
    for (const c of cues) {
      const row = index.get(c.trackId);
      if (row === undefined) continue;
      const x = ((c.startMs / 1000) * pxPerSec + START_LEFT) * scale;
      const w = Math.max(1, ((c.endMs - c.startMs) / 1000) * pxPerSec * scale);
      ctx.fillStyle = colors[c.kind];
      ctx.fillRect(x, 2 + row * rowH, w, Math.max(1, rowH - (rowH > 2 ? 1 : 0)));
    }
  }, [tracks, cues, pxPerSec, scale, width, revision]);

  const scrollToBox = (boxX: number) => {
    if (scale <= 0) return;
    onScrollTo(clamp(boxX / scale, 0, Math.max(0, total - viewWidth)));
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const x = e.clientX - (wrapRef.current?.getBoundingClientRect().left ?? 0);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // 点在方框里：按住拖动；点在方框外：方框中心跳到这里再拖
    const inside = x >= boxLeft && x <= boxLeft + boxWidth;
    const offset = inside ? x - boxLeft : boxWidth / 2;
    dragging.current = { offset };
    if (!inside) scrollToBox(x - offset);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const x = e.clientX - (wrapRef.current?.getBoundingClientRect().left ?? 0);
    scrollToBox(x - dragging.current.offset);
  };
  const onUp = () => {
    dragging.current = null;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(40, viewWidth * 0.8);
    if (e.key === "ArrowRight") onScrollTo(clamp(scrollLeft + page, 0, Math.max(0, total - viewWidth)));
    else if (e.key === "ArrowLeft") onScrollTo(clamp(scrollLeft - page, 0, Math.max(0, total - viewWidth)));
    else if (e.key === "Home") onScrollTo(0);
    else if (e.key === "End") onScrollTo(Math.max(0, total - viewWidth));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const percent = total > viewWidth ? Math.round((scrollLeft / (total - viewWidth)) * 100) : 0;

  return (
    <div
      ref={wrapRef}
      role="scrollbar"
      tabIndex={0}
      aria-label={t("editor.timeline.overview")}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-controls="timeline-body"
      className="relative shrink-0 cursor-pointer select-none border-t border-border bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      style={{ height: OVERVIEW_HEIGHT }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
    >
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
      <div
        aria-hidden
        data-testid="overview-box"
        className="absolute inset-y-0.5 rounded-sm border border-foreground/60 bg-foreground/10"
        style={{ left: boxLeft, width: boxWidth }}
      />
    </div>
  );
}
