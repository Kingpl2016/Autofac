import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { useOverview } from "../hooks/useOverview";
import { formatDurationUs } from "../lib/filter";
import { drawHeatmap, heatmapCells, rowHeightFor, summarizeOverview } from "../lib/heatmap";
import { timeToX, xToTimeUs } from "../lib/overview";

/** 拖动时向后端发送 seek 的最小间隔（毫秒）。 */
const SEEK_THROTTLE_MS = 60;
/** 键盘左右键每次移动的时长占比。 */
const KEY_STEP_RATIO = 0.01;
/** 标尺刻度数（含两端）。 */
const RULER_TICKS = 5;

interface TimelineHeatmapProps {
  /** 节目路径 */
  path: string;
  /** 节目总时长（微秒） */
  durationUs: number;
  /** 当前播放位置（微秒） */
  posUs: number;
  /** 正在查看通道栅格的 Universe（行标签高亮） */
  viewed: number[];
  /** 跳转 */
  onSeek: (posUs: number) => void;
  /** 点击行标签：切换该 Universe 的查看状态 */
  onToggleUniverse: (universe: number) => void;
}

/** 读取主题变量解析后的颜色。 */
function themeColor(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 时间线热力图：横轴为时间，纵轴为 Universe，亮度反映电平与变化强度。
 *
 * - 画布只在数据 / 尺寸 / 主题变化时重绘；播放头是叠加的 DOM 元素，30Hz 移动不触发重绘。
 * - 点击或拖动跳转，键盘左右方向键微调，Home / End 回到两端。
 * - 为屏幕阅读器提供每路 Universe 的活动摘要作为文字替代。
 */
export function TimelineHeatmap({
  path,
  durationUs,
  posUs,
  viewed,
  onSeek,
  onToggleUniverse,
}: TimelineHeatmapProps) {
  const { t } = useTranslation();
  const overview = useOverview(path);
  const theme = usePrefsStore((s) => s.theme);
  const accent = usePrefsStore((s) => s.accent);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  const data = overview.data;
  const rows = data?.universes.length ?? 0;
  const rowHeight = rowHeightFor(rows);
  const height = rows * rowHeight;

  // 跟踪容器宽度
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const cells = useMemo(
    () => (data && width > 0 ? heatmapCells(data, width) : []),
    [data, width],
  );

  // 重绘画布（数据 / 尺寸 / 主题变化时）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // 测试环境（jsdom）没有 2D 上下文
    canvas.width = width;
    canvas.height = height;
    drawHeatmap(
      ctx,
      cells,
      rowHeight,
      width,
      themeColor(canvas, "--primary", "currentColor"),
      themeColor(canvas, "--muted", "transparent"),
    );
    // theme / accent 只用于触发重绘：颜色变量变化后重新取色
  }, [cells, rowHeight, width, height, theme, accent]);

  // 拖动跳转
  const dragging = useRef(false);
  const lastSeekAt = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (trailing.current) clearTimeout(trailing.current);
    },
    [],
  );

  const seekFromEvent = (clientX: number, final: boolean) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pos = xToTimeUs(clientX - rect.left, rect.width, durationUs);
    if (trailing.current) clearTimeout(trailing.current);
    const now = performance.now();
    if (final || now - lastSeekAt.current >= SEEK_THROTTLE_MS) {
      lastSeekAt.current = now;
      onSeek(pos);
    } else {
      trailing.current = setTimeout(() => {
        lastSeekAt.current = performance.now();
        onSeek(pos);
      }, SEEK_THROTTLE_MS);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = Math.max(1, Math.round(durationUs * KEY_STEP_RATIO));
    let next: number | null = null;
    if (e.key === "ArrowRight") next = posUs + step;
    else if (e.key === "ArrowLeft") next = posUs - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = durationUs;
    if (next === null) return;
    e.preventDefault();
    onSeek(Math.min(durationUs, Math.max(0, next)));
  };

  const summary = useMemo(() => (data ? summarizeOverview(data) : []), [data]);

  if (overview.isPending && overview.fetchStatus !== "idle") {
    return (
      <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("player.overviewLoading")}
      </div>
    );
  }
  if (overview.isError || !data) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
        {t("player.overviewFailed")}
      </div>
    );
  }
  if (rows === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
        {t("player.overviewEmpty")}
      </div>
    );
  }

  const playheadX = timeToX(posUs, 100, durationUs);

  return (
    <div className="grid gap-2">
      {/* 标尺 */}
      <div className="ml-14 flex justify-between text-[0.7rem] text-muted-foreground tabular" aria-hidden>
        {Array.from({ length: RULER_TICKS }, (_, i) => (
          <span key={i}>{formatDurationUs((durationUs * i) / (RULER_TICKS - 1))}</span>
        ))}
      </div>

      <div className="flex max-h-80 overflow-y-auto rounded-md border border-border">
        {/* 行标签：点击切换通道栅格的查看状态 */}
        <ul className="w-14 shrink-0 border-r border-border bg-card">
          {data.universes.map((u) => (
            <li key={u} style={{ height: rowHeight }}>
              <button
                type="button"
                onClick={() => onToggleUniverse(u)}
                aria-pressed={viewed.includes(u)}
                aria-label={t("player.toggleUniverse", { u })}
                className={cn(
                  "tabular flex size-full items-center justify-end pr-1.5 text-[0.65rem] leading-none",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  viewed.includes(u)
                    ? "bg-primary/15 font-semibold text-primary"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {rowHeight >= 8 ? u : ""}
              </button>
            </li>
          ))}
        </ul>

        {/* 画布 + 播放头 */}
        <div
          ref={wrapRef}
          role="slider"
          tabIndex={0}
          aria-label={t("player.timelineSlider")}
          aria-valuemin={0}
          aria-valuemax={durationUs}
          aria-valuenow={Math.min(posUs, durationUs)}
          aria-valuetext={`${formatDurationUs(posUs)} / ${formatDurationUs(durationUs)}`}
          className="relative min-w-0 flex-1 cursor-pointer touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ height }}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromEvent(e.clientX, false);
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekFromEvent(e.clientX, false);
          }}
          onPointerUp={(e) => {
            if (!dragging.current) return;
            dragging.current = false;
            seekFromEvent(e.clientX, true);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        >
          <canvas ref={canvasRef} className="block size-full" aria-hidden />
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground"
            style={{ left: `${playheadX}%` }}
            aria-hidden
          />
        </div>
      </div>

      {data.skippedFrames > 0 && (
        <p className="text-xs text-warning">
          {t("player.overviewSkipped", { n: data.skippedFrames })}
        </p>
      )}

      {/* 文字替代：每路 Universe 的活动摘要 */}
      <table className="sr-only">
        <caption>{t("player.overviewSummary")}</caption>
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
    </div>
  );
}
