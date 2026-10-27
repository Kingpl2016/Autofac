import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppearanceRevision } from "@/features/appearance";
import { useOverview } from "../hooks/useOverview";
import { useScrubSeek } from "../hooks/useScrubSeek";
import { formatDurationUs } from "../lib/filter";
import { drawHeatmap, heatmapCells, rowHeightFor, summarizeOverview } from "../lib/heatmap";
import { timeToX, xToTimeUs } from "../lib/overview";
import { themeColor } from "../lib/themeColor";

/** 键盘左右键每次移动的时长占比。 */
const KEY_STEP_RATIO = 0.01;
/** 标尺刻度数（含两端）。 */
const RULER_TICKS = 5;
/** 热力色阶（冷 → 暖）对应的主题变量。 */
const HEAT_VARS = ["--heat-0", "--heat-1", "--heat-2", "--heat-3", "--heat-4"] as const;
const HEAT_SWATCH = [
  "bg-heat-0",
  "bg-heat-1",
  "bg-heat-2",
  "bg-heat-3",
  "bg-heat-4",
] as const;

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
  const appearanceRevision = useAppearanceRevision();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  /** 指针悬停位置占宽度的比例（0..1），用于标尺上的时间气泡 */
  const [hover, setHover] = useState<number | null>(null);

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
      HEAT_VARS.map((v) => themeColor(canvas, v, "currentColor")),
      themeColor(canvas, "--muted", "transparent"),
    );
    // appearanceRevision 只用于触发重绘：颜色变量变化后重新取色
  }, [cells, rowHeight, width, height, appearanceRevision]);

  // 拖动跳转：拖动期间播放头与读屏数值都以本地位置为准，紧跟指针
  const dragging = useRef(false);
  const { dragPos, scrub, commit, cancel } = useScrubSeek(onSeek);
  const shownPos = dragPos ?? posUs;

  const posFromEvent = (clientX: number): number | null => {
    const el = wrapRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return xToTimeUs(clientX - rect.left, rect.width, durationUs);
  };
  const seekFromEvent = (clientX: number, final: boolean) => {
    const pos = posFromEvent(clientX);
    if (pos === null) return;
    if (final) commit(pos);
    else scrub(pos);
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

  const playheadPx = timeToX(shownPos, width, durationUs);

  const updateHover = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    setHover(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  return (
    <div className="grid gap-2">
      {/* 标尺：刻度 + 悬停时间气泡 */}
      <div className="relative ml-14 h-5" aria-hidden>
        <div className="tabular flex justify-between text-[0.7rem] text-muted-foreground">
          {Array.from({ length: RULER_TICKS }, (_, i) => (
            <span key={i}>{formatDurationUs((durationUs * i) / (RULER_TICKS - 1))}</span>
          ))}
        </div>
        {hover !== null && (
          <span
            className="tabular absolute top-0 -translate-x-1/2 rounded bg-surface-3 px-1.5 py-0.5 text-[0.7rem] font-medium text-foreground shadow-sm"
            style={{ left: `${hover * 100}%` }}
          >
            {formatDurationUs(hover * durationUs)}
          </span>
        )}
      </div>

      <div className="flex max-h-80 overflow-y-auto rounded-lg border border-border bg-surface-1">
        {/* 行标签：点击切换通道栅格的查看状态 */}
        <ul className="w-14 shrink-0 border-r border-border bg-surface-2">
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
          aria-valuenow={Math.min(shownPos, durationUs)}
          aria-valuetext={`${formatDurationUs(shownPos)} / ${formatDurationUs(durationUs)}`}
          className="relative min-w-0 flex-1 cursor-pointer touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ height }}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromEvent(e.clientX, false);
          }}
          onPointerMove={(e) => {
            updateHover(e.clientX);
            if (dragging.current) seekFromEvent(e.clientX, false);
          }}
          onPointerLeave={() => setHover(null)}
          onPointerUp={(e) => {
            if (!dragging.current) return;
            dragging.current = false;
            seekFromEvent(e.clientX, true);
          }}
          onPointerCancel={() => {
            dragging.current = false;
            cancel();
          }}
        >
          <canvas ref={canvasRef} className="block size-full" aria-hidden />
          {/* 播放头：只用 transform 移动，30Hz 更新不触发布局 */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-foreground glow-primary will-change-transform"
            style={{ transform: `translateX(${playheadPx}px)` }}
            aria-hidden
          />
        </div>
      </div>

      {/* 色阶图例：低 → 高（离散色块，不依赖单一颜色表达强度） */}
      <div className="flex items-center justify-end gap-2 text-[0.7rem] text-muted-foreground" aria-hidden>
        <span>{t("player.legendLow")}</span>
        <span className="flex overflow-hidden rounded-sm">
          {HEAT_SWATCH.map((c) => (
            <span key={c} className={cn("h-2 w-5", c)} />
          ))}
        </span>
        <span>{t("player.legendHigh")}</span>
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
