import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { setLoopRange } from "../lib/ops";
import { OUTPUT_FPS } from "../lib/project";
import { clamp, formatTimecode, snapToFrame } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { RULER_HEIGHT, START_LEFT } from "./timelineData";
import { rulerTicks } from "./timelineLayout";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 一帧的毫秒数。 */
const FRAME = Math.round(1000 / OUTPUT_FPS);

/**
 * 时间线标尺：自适应刻度（缩放到帧级时显示帧号）、A-B 循环区间（可拖动 / 方向键调整入点出点），
 * 点击或拖动标尺定位播放头。
 */
export function Ruler() {
  const { t } = useTranslation();
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const setPlayhead = useEditorUiStore((s) => s.setPlayhead);
  const durationMs = useProjectStore((s) => s.project.durationMs);
  const loop = useProjectStore((s) => s.project.loopRange);
  const update = useProjectStore((s) => s.update);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const seeking = useRef(false);
  /** 拖动循环端点时的预览（松手才写入工程，一次手势一步撤销） */
  const [edgeDrag, setEdgeDrag] = useState<{ edge: "in" | "out"; ms: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const xOf = (ms: number) => START_LEFT + (ms / 1000) * pxPerSec - scrollLeft;
  const msAt = (clientX: number) => {
    const left = ref.current?.getBoundingClientRect().left ?? 0;
    return snapToFrame(clamp(((clientX - left + scrollLeft - START_LEFT) / pxPerSec) * 1000, 0, durationMs));
  };

  const ticks = useMemo(() => {
    const fromMs = ((scrollLeft - START_LEFT) / pxPerSec) * 1000;
    const toMs = Math.min(durationMs, fromMs + ((width + START_LEFT) / pxPerSec) * 1000);
    return rulerTicks(pxPerSec, fromMs, toMs);
  }, [scrollLeft, pxPerSec, durationMs, width]);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    seeking.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setPlayhead(msAt(e.clientX));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (seeking.current) setPlayhead(msAt(e.clientX));
  };
  const onUp = () => {
    seeking.current = false;
  };

  const range = loop
    ? {
        startMs: edgeDrag?.edge === "in" ? edgeDrag.ms : loop.startMs,
        endMs: edgeDrag?.edge === "out" ? edgeDrag.ms : loop.endMs,
      }
    : null;

  const commitEdge = (edge: "in" | "out", ms: number) => {
    if (!loop) return;
    const next = edge === "in" ? { startMs: ms, endMs: loop.endMs } : { startMs: loop.startMs, endMs: ms };
    if (next.startMs > next.endMs) [next.startMs, next.endMs] = [next.endMs, next.startMs];
    update((d) => setLoopRange(d, next));
  };

  const edgeHandle = (edge: "in" | "out") => {
    if (!range) return null;
    const ms = edge === "in" ? range.startMs : range.endMs;
    const label = t(edge === "in" ? "editor.ruler.loopIn" : "editor.ruler.loopOut", { time: formatTimecode(ms) });
    return (
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={durationMs}
        aria-valuenow={ms}
        aria-valuetext={formatTimecode(ms)}
        title={label}
        className={cn(
          "absolute top-0 z-10 h-full w-2 cursor-ew-resize bg-primary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          edge === "in" ? "-translate-x-full rounded-l-sm" : "rounded-r-sm",
        )}
        style={{ left: xOf(ms) }}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setEdgeDrag({ edge, ms });
        }}
        onPointerMove={(e) => {
          if (edgeDrag?.edge === edge) setEdgeDrag({ edge, ms: msAt(e.clientX) });
        }}
        onPointerUp={() => {
          if (edgeDrag?.edge === edge) commitEdge(edge, edgeDrag.ms);
          setEdgeDrag(null);
        }}
        onPointerCancel={() => setEdgeDrag(null)}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          const step = e.shiftKey ? FRAME * 10 : FRAME;
          if (e.key === "ArrowLeft") commitEdge(edge, clamp(ms - step, 0, durationMs));
          else if (e.key === "ArrowRight") commitEdge(edge, clamp(ms + step, 0, durationMs));
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
    );
  };

  return (
    <div
      ref={ref}
      role="group"
      aria-label={t("editor.ruler.label")}
      className="relative shrink-0 cursor-pointer select-none overflow-hidden border-b border-border bg-surface-2"
      style={{ height: RULER_HEIGHT }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {range && (
        <div
          aria-hidden
          className="absolute inset-y-0 bg-loop-range"
          style={{ left: xOf(range.startMs), width: Math.max(0, xOf(range.endMs) - xOf(range.startMs)) }}
        />
      )}
      <svg aria-hidden className="absolute inset-0 h-full w-full text-muted-foreground">
        {ticks.minor.map((ms) => (
          <line key={`m${ms}`} x1={xOf(ms)} x2={xOf(ms)} y1={RULER_HEIGHT - 5} y2={RULER_HEIGHT} className="stroke-current opacity-50" />
        ))}
        {ticks.major.map((tick) => (
          <line key={`M${tick.ms}`} x1={xOf(tick.ms)} x2={xOf(tick.ms)} y1={RULER_HEIGHT - 11} y2={RULER_HEIGHT} className="stroke-current" />
        ))}
      </svg>
      {ticks.major.map((tick) => (
        <span
          key={`L${tick.ms}`}
          aria-hidden
          className="num pointer-events-none absolute top-1 ml-1 text-[10px] leading-none text-muted-foreground"
          style={{ left: xOf(tick.ms) }}
        >
          {tick.label}
        </span>
      ))}
      {edgeHandle("in")}
      {edgeHandle("out")}
    </div>
  );
}
