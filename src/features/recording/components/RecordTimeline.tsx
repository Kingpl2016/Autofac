import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useElementSize } from "@/shared/hooks/useElementSize";
import { useHeatCanvas } from "../hooks/useHeatCanvas";
import { useRecordingClock } from "../hooks/useRecordingClock";
import { formatDurationUs } from "../lib/filter";
import { rowHeightFor, summarizeOverview } from "../lib/heatmap";
import { timeToX } from "../lib/overview";
import { activityAsOverview, axisSpanUs, dataWidth, headX } from "../lib/recordTimeline";
import { useRecordingStore } from "../stores/useRecordingStore";

/** 标尺刻度数（含两端）。 */
const RULER_TICKS = 5;
/** 录制时间线的最大行高（像素）：行少时也不铺得太高。 */
const MAX_ROW_PX = 12;

/**
 * 录制时间线（录制舱）：纵轴 Universe、横轴时间，颜色反映各路电平与变化强度，
 * 竖线“录制头”随录制实时向右推进，分段边界画虚线。
 *
 * - 数据来自后端按时间分桶统计的活动时间线（`recording:stats` 增量，只在内存里，不影响节目文件）；
 * - 时间轴总长按 1 / 5 / 10 / 30 / 60 分钟分档自动扩展，录制头因此在轴上推进；
 * - 录制中不能跳转：整体是一张带文字替代的图（`role="img"` + 读屏摘要表）。
 * - 没在录制、也没有上一次录制的数据时不渲染。
 */
export function RecordTimeline() {
  const { t } = useTranslation();
  const activity = useRecordingStore((s) => s.activity);
  const recording = useRecordingStore((s) => s.status.recording);
  const hasLast = useRecordingStore((s) => s.last !== null);
  const clock = useRecordingClock();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const visible = recording || (hasLast && activity !== null && activity.len > 0);
  const rows = activity?.universes.length ?? 0;
  // 画布随 visible / rows 条件渲染：变化时重新观测
  const { width } = useElementSize(wrapRef, { key: `${visible}:${rows}` });


  // 停止后录制头停在数据末端
  const elapsedUs = recording
    ? clock.sessionUs
    : activity
      ? activity.len * activity.bucketUs
      : 0;
  const spanUs = axisSpanUs(elapsedUs);
  const dataPx = dataWidth(activity, width, spanUs);
  const rowHeight = Math.min(MAX_ROW_PX, rowHeightFor(rows));
  const overview = useMemo(() => (activity ? activityAsOverview(activity) : null), [activity]);
  useHeatCanvas(canvasRef, overview, dataPx, rowHeight);
  const summary = useMemo(() => (overview ? summarizeOverview(overview) : []), [overview]);

  if (!visible) return null;

  const partStarts = (activity?.partStartsUs ?? []).filter((s) => s > 0);
  const head = headX(elapsedUs, width, spanUs);
  const height = Math.max(rows, 1) * rowHeight;
  const alt = t("recording.timelineAlt", {
    elapsed: formatDurationUs(elapsedUs),
    span: formatDurationUs(spanUs),
    parts: partStarts.length + 1,
    n: rows,
  });

  const updateHover = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    setHover(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  return (
    <section className="grid gap-2" aria-labelledby="record-timeline-title">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="record-timeline-title" className="text-sm font-medium">
          {t("recording.timelineTitle")}
        </h3>
        <span className="num text-xs text-muted-foreground">
          {t("recording.timelineSpan", { span: formatDurationUs(spanUs) })}
        </span>
      </div>

      {/* 标尺：刻度 + 悬停时间 */}
      <div className="relative ml-14 h-5" aria-hidden>
        <div className="num flex justify-between text-[0.7rem] text-muted-foreground">
          {Array.from({ length: RULER_TICKS }, (_, i) => (
            <span key={i}>{formatDurationUs((spanUs * i) / (RULER_TICKS - 1))}</span>
          ))}
        </div>
        {hover !== null && (
          <span
            className="num absolute top-0 -translate-x-1/2 rounded bg-surface-3 px-1.5 py-0.5 text-[0.7rem] font-medium text-foreground shadow-sm"
            style={{ left: `${hover * 100}%` }}
          >
            {formatDurationUs(hover * spanUs)}
          </span>
        )}
      </div>

      <div className="flex max-h-48 overflow-y-auto rounded-lg border border-border bg-surface-1">
        <ul className="w-14 shrink-0 border-r border-border bg-surface-2" aria-hidden>
          {(activity?.universes ?? []).map((u) => (
            <li
              key={u}
              className="num flex items-center justify-end pr-1.5 text-[0.65rem] leading-none text-muted-foreground"
              style={{ height: rowHeight }}
            >
              {rowHeight >= 8 ? u : ""}
            </li>
          ))}
        </ul>
        <div
          ref={wrapRef}
          role="img"
          aria-label={alt}
          className="relative min-w-0 flex-1 bg-muted/40"
          style={{ height }}
          onPointerMove={(e) => updateHover(e.clientX)}
          onPointerLeave={() => setHover(null)}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-y-0 left-0 block h-full"
            style={{ width: dataPx }}
            aria-hidden
          />
          {/* 分段边界 */}
          {partStarts.map((s) => (
            <div
              key={s}
              data-testid="record-part-line"
              className="pointer-events-none absolute inset-y-0 left-0 w-0 border-l border-dashed border-foreground/60"
              style={{ transform: `translateX(${timeToX(s, width, spanUs)}px)` }}
              aria-hidden
            />
          ))}
          {/* 录制头：只用 transform 移动 */}
          <div
            data-testid="record-head"
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 will-change-transform",
              recording ? "bg-recording glow-recording" : "bg-muted-foreground",
            )}
            style={{ transform: `translateX(${head}px)` }}
            aria-hidden
          />
        </div>
      </div>

      {/* 文字替代：每路 Universe 的活动摘要 */}
      <table className="sr-only">
        <caption>{t("recording.timelineSummary")}</caption>
        <thead>
          <tr>
            <th scope="col">Universe</th>
            <th scope="col">{t("player.summaryActive")}</th>
            <th scope="col">{t("player.summaryPeak")}</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((r) => (
            <tr key={r.universe}>
              <th scope="row">{r.universe}</th>
              <td>{Math.round(r.activeShare * 100)}%</td>
              <td>{r.peakLevel}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
