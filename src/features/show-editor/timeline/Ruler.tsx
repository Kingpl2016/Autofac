import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { requestShowDuration } from "../hooks/editorActions";
import { clearLoop } from "../hooks/timelineObjectActions";
import { normalizeDuration } from "../lib/duration";
import { MAX_DURATION_MS, setLoopRange } from "../lib/ops";
import { OUTPUT_FPS } from "../lib/project";
import { clamp, formatTimecode, snapToFrame } from "../lib/time";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { RULER_HEIGHT, START_LEFT } from "./timelineData";
import { barTicks, rulerTicks } from "./timelineLayout";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 一帧的毫秒数。 */
const FRAME = Math.round(1000 / OUTPUT_FPS);

/**
 * 时间线标尺：自适应刻度（时间码，缩放到帧级时显示帧号；或小节·拍）、A-B 循环区间（可拖动 / 方向键调整入点出点，
 * 在手柄上按 Delete 或点循环带中间的 × 清除），点击或拖动标尺定位播放头。
 */
export function Ruler() {
  const { t } = useTranslation();
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const setPlayhead = useEditorUiStore((s) => s.setPlayhead);
  const durationMs = useProjectStore((s) => s.project.durationMs);
  const loop = useProjectStore((s) => s.project.loopRange);
  const update = useProjectStore((s) => s.update);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const tempo = useProjectStore((s) => s.project.tempo);
  // 小节·拍刻度需要节拍设置；没有时退回时间码
  const bars = useEditorPrefsStore((s) => s.rulerFormat === "bars") && tempo !== null;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const seeking = useRef(false);
  /** 拖动循环端点时的预览（松手才写入工程，一次手势一步撤销） */
  const [edgeDrag, setEdgeDrag] = useState<{ edge: "in" | "out"; ms: number } | null>(null);
  /** 指针悬停处的时刻：画一条“幽灵线”，预示点下去播放头落在哪 */
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  /** 拖动节目结尾把手时的预览 */
  const [endDrag, setEndDrag] = useState<number | null>(null);
  const endMs = endDrag ?? durationMs;

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
    return bars && tempo ? barTicks(tempo, pxPerSec, fromMs, toMs) : rulerTicks(pxPerSec, fromMs, toMs);
  }, [scrollLeft, pxPerSec, durationMs, width, bars, tempo]);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    seeking.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setPlayhead(msAt(e.clientX));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const ms = msAt(e.clientX);
    if (seeking.current) setPlayhead(ms);
    setHoverMs(ms);
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
          else if (e.key === "Delete" || e.key === "Backspace") clearLoop();
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
      data-timeline-ruler
      aria-label={t("editor.ruler.label")}
      className="relative shrink-0 cursor-pointer select-none overflow-hidden border-b border-border bg-surface-2"
      style={{ height: RULER_HEIGHT }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setHoverMs(null)}
    >
      {hoverMs !== null && (
        <div aria-hidden data-testid="ruler-ghost" className="pointer-events-none absolute inset-y-0 z-[5]" style={{ left: xOf(hoverMs) }}>
          <span className="absolute inset-y-0 w-px bg-playhead/50" />
          <span className="num absolute bottom-0.5 left-1 whitespace-nowrap rounded bg-popover/90 px-1 text-[10px] leading-tight text-foreground shadow-sm">
            {formatTimecode(hoverMs)}
          </span>
        </div>
      )}
      {range && (
        <div
          data-loop
          className="group/loop absolute inset-y-0 bg-loop-range"
          style={{ left: xOf(range.startMs), width: Math.max(0, xOf(range.endMs) - xOf(range.startMs)) }}
        >
          {/* 悬停循环带时在中间出现 ×：清除循环区间（也可在入点 / 出点手柄上按 Delete） */}
          {xOf(range.endMs) - xOf(range.startMs) >= 24 && !edgeDrag && (
            <button
              type="button"
              aria-label={t("editor.loop.clear")}
              title={t("editor.loop.clear")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                clearLoop();
              }}
              className={cn(
                "absolute left-1/2 top-1/2 z-[6] flex size-4 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm",
                "bg-surface-3/90 text-muted-foreground opacity-0 transition-opacity group-hover/loop:opacity-100",
                "hover:bg-destructive hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </div>
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
      {/* 节目结尾把手：拖动改节目时长（缩短会裁掉内容时先确认） */}
      <div
        role="slider"
        tabIndex={0}
        aria-label={t("editor.duration.handle", { time: formatTimecode(endMs) })}
        aria-valuemin={0}
        aria-valuemax={MAX_DURATION_MS}
        aria-valuenow={endMs}
        aria-valuetext={formatTimecode(endMs)}
        title={t("editor.duration.handle", { time: formatTimecode(endMs) })}
        data-testid="duration-handle"
        className="absolute top-0 z-10 flex h-full w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ left: xOf(endMs) }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setEndDrag(durationMs);
        }}
        onPointerMove={(e) => {
          if (endDrag === null) return;
          const left = ref.current?.getBoundingClientRect().left ?? 0;
          setEndDrag(normalizeDuration(((e.clientX - left + scrollLeft - START_LEFT) / pxPerSec) * 1000));
        }}
        onPointerUp={() => {
          if (endDrag !== null && endDrag !== durationMs) requestShowDuration(endDrag);
          setEndDrag(null);
        }}
        onPointerCancel={() => setEndDrag(null)}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          const step = e.shiftKey ? 1000 : FRAME;
          if (e.key === "ArrowLeft") requestShowDuration(durationMs - step);
          else if (e.key === "ArrowRight") requestShowDuration(durationMs + step);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <span aria-hidden className="h-full w-0.5 rounded-full bg-foreground/70" />
        <span aria-hidden className="absolute top-0.5 h-2 w-2.5 rounded-sm bg-foreground/70" />
      </div>
    </div>
  );
}
