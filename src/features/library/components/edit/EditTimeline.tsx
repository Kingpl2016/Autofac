import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Film, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppearanceRevision } from "@/features/appearance";
import { themeColor } from "@/shared/lib/canvas";
import { drawHeatmap, heatmapCells, type Overview } from "@/features/recording";
import { gapsOf, type Segment } from "../../lib/segments";
import { formatTimecode } from "../../lib/timecode";

const HEAT_VARS = ["--heat-0", "--heat-1", "--heat-2", "--heat-3", "--heat-4"] as const;
/** 画布的最大像素列数。 */
const MAX_COLUMNS = 4096;
/** 热力图画布的目标高度（像素，CSS 负责拉伸）。 */
const HEAT_TARGET_PX = 64;
/** 标尺主刻度的候选间隔（微秒）。 */
const TICK_STEPS_US = [
  100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 15_000_000, 30_000_000,
  60_000_000, 120_000_000, 300_000_000, 600_000_000, 900_000_000, 1_800_000_000, 3_600_000_000,
];
/** 相邻主刻度的最小间距（像素）。 */
const MIN_TICK_PX = 96;
/** 每个主刻度之间的次刻度数。 */
const MINOR_PER_MAJOR = 5;
/** 次刻度的最小间距（像素），更密时不画。 */
const MIN_MINOR_PX = 10;
/** 键盘修剪 / 移动播放头的步长（微秒）：方向键 10ms，Shift + 方向键 1s。 */
const FINE_STEP_US = 10_000;
const COARSE_STEP_US = 1_000_000;
/** 片段卡片宽度小于该像素时只显示序号。 */
const NARROW_CLIP_PX = 96;
/** 主刻度落在最右侧这段比例（%）内时，标签改到刻度左边，避免被外框裁掉。 */
const LABEL_FLIP_RATIO = 92;
/**
 * 滚动区右侧留白处的底色：与标尺、片段轨的底色对齐，留白看起来是轨道的延续。
 * 高度与下方各行一致（标尺 2.25rem，片段轨 6rem）。
 */
const TRACK_BACKDROP = {
  backgroundImage:
    "linear-gradient(var(--surface-2), var(--surface-2)), linear-gradient(color-mix(in oklab, var(--background) 50%, transparent), color-mix(in oklab, var(--background) 50%, transparent))",
  backgroundSize: "100% 2.25rem, 100% 6rem",
  backgroundPosition: "0 0, 0 2.25rem",
  backgroundRepeat: "no-repeat",
} as const;

interface EditTimelineProps {
  overview: Overview | undefined;
  durationUs: number;
  segments: readonly Segment[];
  /** 保留的 Universe（不保留的行在热力图上压暗） */
  universes: readonly number[];
  selectedId: string | null;
  playheadUs: number;
  /** 缩放倍数（1 = 整段节目铺满可视宽度） */
  zoom: number;
  onSeek: (us: number) => void;
  onSelect: (id: string) => void;
  onTrim: (id: string, edge: "start" | "end", us: number) => void;
  /** 拖动修剪开始 / 结束（整个手势合并为一步撤销） */
  onTrimGestureStart: () => void;
  onTrimGestureEnd: () => void;
  /** Ctrl + 滚轮缩放（1 放大，-1 缩小） */
  onZoom?: (dir: 1 | -1) => void;
}

/** 按可视像素宽度选择主刻度间隔。 */
function tickStep(durationUs: number, widthPx: number): number {
  const perPx = durationUs / Math.max(1, widthPx);
  return TICK_STEPS_US.find((s) => s / perPx >= MIN_TICK_PX) ?? TICK_STEPS_US[TICK_STEPS_US.length - 1];
}

/** 刻度标签：整秒不带毫秒。 */
function tickLabel(us: number): string {
  const tc = formatTimecode(us);
  return us % 1_000_000 === 0 ? tc.replace(/\.000$/, "") : tc;
}

/** 时间 → 百分比（0..100）。 */
const ratio = (us: number, d: number) => (Math.min(Math.max(us, 0), d) / Math.max(1, d)) * 100;
const pct = (us: number, d: number) => `${ratio(us, d)}%`;

/** 时间标签贴近两端时向内对齐，不被裁掉。 */
function tagAlign(r: number): string {
  if (r < 4) return "translate-x-0";
  if (r > 96) return "-translate-x-full";
  return "-translate-x-1/2";
}

/**
 * 编辑时间轴（参考 Premiere / DaVinci Resolve / 剪映等非线性编辑器的布局）：
 *
 * - 左侧固定轨道头；右侧可横向滚动的轴：标尺（主 / 次刻度）、片段轨、信号轨。
 * - 片段轨：每个保留片段是一张圆角卡片，标题条写序号与时长，卡片里是该时段的热力图（胶片条）；
 *   选中的片段高亮，两端出现方括号形的修剪手柄（悬停 / 键盘聚焦时也会出现）。
 *   删掉的时段是带斜线纹理与 ✕ 的虚线框，标出删掉的时长。
 * - 信号轨：整段节目的热力图，删掉的时段压暗，便于对照上下文。
 * - 播放头：贯穿各轨的竖线，顶部是时间码标签；鼠标在轴上移动时显示虚线位置与时间。
 *
 * 播放头（标尺）与片段边缘都是 `role="slider"`：方向键 10ms、Shift + 方向键 1s、Home / End 到两端；
 * 拖动之外都有键盘与时间码输入两种替代方式。Ctrl + 滚轮缩放，缩放后播放头离开视野时自动跟随。
 */
export function EditTimeline({
  overview,
  durationUs,
  segments,
  universes,
  selectedId,
  playheadUs,
  zoom,
  onSeek,
  onSelect,
  onTrim,
  onTrimGestureStart,
  onTrimGestureEnd,
  onZoom,
}: EditTimelineProps) {
  const { t } = useTranslation();
  const appearanceRevision = useAppearanceRevision();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const signalRef = useRef<HTMLCanvasElement>(null);
  const clipCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const [widthPx, setWidthPx] = useState(0);
  const [hoverUs, setHoverUs] = useState<number | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidthPx(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl + 滚轮缩放（需要非被动监听才能阻止浏览器缩放页面）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onZoom) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      onZoom(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onZoom]);

  // 缩放后播放头离开可视范围时自动滚动跟随（播放预览时尤其需要）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || zoom <= 1 || widthPx === 0) return;
    const x = (ratio(playheadUs, durationUs) / 100) * widthPx;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 24) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
    }
  }, [playheadUs, durationUs, zoom, widthPx]);

  // 热力图：信号轨画整段，片段卡片从中截取各自的时段（胶片条）；不保留的 Universe 行压暗
  useEffect(() => {
    const canvas = signalRef.current;
    if (!canvas || !overview || overview.universes.length === 0 || widthPx === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // 测试环境（jsdom）没有 2D 上下文
    const columns = Math.min(MAX_COLUMNS, widthPx);
    const rows = overview.universes.length;
    const rowHeight = Math.max(1, Math.floor(HEAT_TARGET_PX / rows));
    canvas.width = columns;
    canvas.height = rows * rowHeight;
    const track = themeColor(canvas, "--surface-1", "transparent");
    drawHeatmap(
      ctx,
      heatmapCells(overview, columns),
      rowHeight,
      columns,
      HEAT_VARS.map((v) => themeColor(canvas, v, "currentColor")),
      track,
    );
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = track;
    overview.universes.forEach((u, r) => {
      if (!universes.includes(u)) ctx.fillRect(0, r * rowHeight, columns, rowHeight);
    });
    ctx.globalAlpha = 1;

    for (const s of segments) {
      const clip = clipCanvases.current.get(s.id);
      const cctx = clip?.getContext("2d");
      if (!clip || !cctx) continue;
      const sx = (ratio(s.startUs, durationUs) / 100) * columns;
      const sw = Math.max(1, (ratio(s.endUs, durationUs) / 100) * columns - sx);
      clip.width = Math.max(1, Math.round(sw));
      clip.height = canvas.height;
      cctx.drawImage(canvas, sx, 0, sw, canvas.height, 0, 0, clip.width, clip.height);
    }
    // appearanceRevision 只用于触发重绘：颜色变量变化后重新取色
  }, [overview, widthPx, universes, segments, durationUs, appearanceRevision]);

  const gaps = useMemo(() => gapsOf(segments, durationUs), [segments, durationUs]);
  const step = tickStep(durationUs, widthPx);
  const ticks = useMemo(() => {
    const major: number[] = [];
    const minor: number[] = [];
    if (durationUs <= 0) return { major, minor };
    const minorStep = step / MINOR_PER_MAJOR;
    const showMinor = widthPx > 0 && (minorStep / durationUs) * widthPx >= MIN_MINOR_PX;
    for (let us = 0; us <= durationUs && major.length < 2000; us += step) {
      major.push(us);
      if (!showMinor) continue;
      for (let k = 1; k < MINOR_PER_MAJOR; k += 1) {
        const m = us + k * minorStep;
        if (m < durationUs) minor.push(m);
      }
    }
    return { major, minor };
  }, [durationUs, step, widthPx]);

  const usAt = (clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(durationUs, Math.max(0, Math.round(((clientX - rect.left) / rect.width) * durationUs)));
  };

  // ---- 播放头：在标尺 / 信号轨上点击或拖动 ----
  const scrubbing = useRef(false);
  const onScrubDown = (e: PointerEvent<HTMLElement>) => {
    scrubbing.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onSeek(usAt(e.clientX));
  };
  const onScrubMove = (e: PointerEvent<HTMLElement>) => {
    if (scrubbing.current) onSeek(usAt(e.clientX));
  };
  const onScrubUp = () => {
    scrubbing.current = false;
  };

  const sliderKeys = (e: KeyboardEvent<HTMLElement>, value: number, apply: (us: number) => void) => {
    const stepUs = e.shiftKey ? COARSE_STEP_US : FINE_STEP_US;
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - stepUs;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + stepUs;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = durationUs;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    apply(Math.min(Math.max(0, next), durationUs));
  };

  // ---- 片段边缘：拖动修剪 ----
  const dragging = useRef<{ id: string; edge: "start" | "end" } | null>(null);
  const onEdgeDown = (e: PointerEvent<HTMLDivElement>, id: string, edge: "start" | "end") => {
    e.stopPropagation();
    dragging.current = { id, edge };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onSelect(id);
    onTrimGestureStart();
  };
  const onEdgeMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragging.current;
    if (d) onTrim(d.id, d.edge, usAt(e.clientX));
  };
  const onEdgeUp = () => {
    if (!dragging.current) return;
    dragging.current = null;
    onTrimGestureEnd();
  };

  const playheadR = ratio(playheadUs, durationUs);
  const hoverR = hoverUs === null ? null : ratio(hoverUs, durationUs);
  const pxOf = (us: number) => (us / Math.max(1, durationUs)) * widthPx;

  return (
    <div className="grid gap-2">
      <div className="flex overflow-hidden rounded-xl border border-border bg-surface-1 panel-edge">
        {/* 轨道头 */}
        <div aria-hidden className="flex w-24 shrink-0 flex-col border-r border-border bg-surface-2">
          <div className="num flex h-9 items-center border-b border-border px-3 text-xs text-muted-foreground">
            {formatTimecode(durationUs)}
          </div>
          <div className="flex h-24 items-center gap-2 px-3 text-xs font-medium">
            <Film className="size-4 text-primary" />
            {t("library.trackSegments")}
          </div>
          <div className="flex h-16 items-center gap-2 border-t border-border px-3 text-xs font-medium text-muted-foreground">
            <Activity className="size-4" />
            {t("library.trackSignal")}
          </div>
        </div>

        {/* 可滚动的轴 */}
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden pr-4" style={TRACK_BACKDROP}>
          <div
            ref={contentRef}
            className="relative min-w-full select-none"
            style={{ width: `${zoom * 100}%` }}
            onPointerMove={(e) => {
              if (!dragging.current) setHoverUs(usAt(e.clientX));
            }}
            onPointerLeave={() => setHoverUs(null)}
          >
            {/* 标尺 */}
            <div
              role="slider"
              tabIndex={0}
              aria-label={t("library.editPlayhead")}
              aria-valuemin={0}
              aria-valuemax={durationUs}
              aria-valuenow={playheadUs}
              aria-valuetext={formatTimecode(playheadUs)}
              className="relative h-9 cursor-col-resize border-b border-border bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubUp}
              onPointerCancel={onScrubUp}
              onKeyDown={(e) => sliderKeys(e, playheadUs, onSeek)}
            >
              {ticks.minor.map((us) => (
                <span
                  key={`m${us}`}
                  aria-hidden
                  className="pointer-events-none absolute bottom-0 h-1.5 border-l border-foreground/20"
                  style={{ left: pct(us, durationUs) }}
                />
              ))}
              {ticks.major.map((us) => {
                const flip = ratio(us, durationUs) > LABEL_FLIP_RATIO;
                return (
                  <span
                    key={us}
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-y-0 flex flex-col justify-between",
                      flip && "-translate-x-full items-end",
                    )}
                    style={{ left: pct(us, durationUs) }}
                  >
                    <span
                      className={cn(
                        "num whitespace-nowrap pt-1 text-xs leading-none text-muted-foreground",
                        flip ? "pr-1" : "pl-1",
                      )}
                    >
                      {tickLabel(us)}
                    </span>
                    <span className={cn("h-3", flip ? "border-r" : "border-l", "border-foreground/45")} />
                  </span>
                );
              })}
              {hoverR !== null && hoverUs !== null && (
                <span
                  aria-hidden
                  className={cn(
                    "num pointer-events-none absolute bottom-1 z-10 whitespace-nowrap rounded bg-surface-3 px-1.5 py-0.5 text-xs text-foreground shadow-sm",
                    tagAlign(hoverR),
                  )}
                  style={{ left: `${hoverR}%` }}
                >
                  {formatTimecode(hoverUs)}
                </span>
              )}
            </div>

            {/* 片段轨 */}
            <div
              className="relative h-24 bg-background/50"
              onPointerMove={onEdgeMove}
              onPointerUp={onEdgeUp}
              onPointerCancel={onEdgeUp}
            >
              {gaps.map((g) => (
                <div
                  key={`${g.startUs}-${g.endUs}`}
                  aria-hidden
                  className="hatch-removed pointer-events-none absolute inset-y-2 flex items-center justify-center gap-1 overflow-hidden rounded-md border border-dashed border-destructive/50 px-2 text-xs text-destructive"
                  style={{ left: pct(g.startUs, durationUs), width: pct(g.endUs - g.startUs, durationUs) }}
                >
                  <X className="size-3.5 shrink-0" />
                  {pxOf(g.endUs - g.startUs) >= NARROW_CLIP_PX && (
                    <span className="num truncate">{t("library.removedLength", { time: formatTimecode(g.endUs - g.startUs) })}</span>
                  )}
                </div>
              ))}

              {segments.map((s, i) => {
                const selected = s.id === selectedId;
                const n = i + 1;
                const narrow = pxOf(s.endUs - s.startUs) < NARROW_CLIP_PX;
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "group/clip absolute inset-y-2 overflow-hidden rounded-md border bg-surface-3 shadow-sm",
                      "transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none",
                      selected
                        ? "z-10 border-primary shadow-[0_0_0_2px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
                        : "border-border hover:border-foreground/40",
                    )}
                    // 相邻片段之间留 2px 缝，看得出是两段
                    style={{
                      left: `calc(${pct(s.startUs, durationUs)} + 1px)`,
                      width: `calc(${pct(s.endUs - s.startUs, durationUs)} - 2px)`,
                    }}
                  >
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={t("library.segmentAria", {
                        n,
                        start: formatTimecode(s.startUs),
                        end: formatTimecode(s.endUs),
                      })}
                      className="absolute inset-0 flex cursor-pointer flex-col rounded-[inherit] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => onSelect(s.id)}
                    >
                      <span
                        className={cn(
                          "flex h-6 w-full shrink-0 items-center gap-1.5 px-4 text-xs font-medium",
                          selected ? "bg-primary text-primary-foreground" : "bg-primary/15 text-foreground",
                        )}
                      >
                        <span className="num">{n}</span>
                        {!narrow && (
                          <>
                            <span className="truncate">{t("library.segmentLabel", { n })}</span>
                            <span className="num ml-auto shrink-0 opacity-80">{formatTimecode(s.endUs - s.startUs)}</span>
                          </>
                        )}
                      </span>
                      <canvas
                        aria-hidden
                        ref={(el) => {
                          if (el) clipCanvases.current.set(s.id, el);
                          else clipCanvases.current.delete(s.id);
                        }}
                        className="block min-h-0 w-full flex-1"
                      />
                    </button>
                    {(["start", "end"] as const).map((edge) => {
                      const value = edge === "start" ? s.startUs : s.endUs;
                      return (
                        <div
                          key={edge}
                          role="slider"
                          tabIndex={0}
                          aria-label={t(edge === "start" ? "library.segmentStartHandle" : "library.segmentEndHandle", { n })}
                          aria-valuemin={0}
                          aria-valuemax={durationUs}
                          aria-valuenow={value}
                          aria-valuetext={formatTimecode(value)}
                          className={cn(
                            "absolute inset-y-0 z-20 flex w-2.5 cursor-ew-resize items-center justify-center gap-0.5",
                            "transition-opacity duration-150 motion-reduce:transition-none",
                            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            edge === "start" ? "left-0 rounded-l-[inherit]" : "right-0 rounded-r-[inherit]",
                            selected
                              ? "bg-primary text-primary-foreground opacity-100"
                              : "bg-foreground/50 text-background opacity-0 group-hover/clip:opacity-100",
                          )}
                          onPointerDown={(e) => onEdgeDown(e, s.id, edge)}
                          onFocus={() => onSelect(s.id)}
                          onKeyDown={(e) => sliderKeys(e, value, (us) => onTrim(s.id, edge, us))}
                        >
                          {/* 握把：两道竖线 */}
                          <span aria-hidden className="h-4 w-px rounded-full bg-current" />
                          <span aria-hidden className="h-4 w-px rounded-full bg-current" />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/* 信号轨：整段热力图，删掉的时段压暗；也可以点击 / 拖动定位播放头 */}
            <div
              className="relative h-16 cursor-col-resize border-t border-border"
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerUp={onScrubUp}
              onPointerCancel={onScrubUp}
            >
              {overview && overview.universes.length > 0 ? (
                <canvas ref={signalRef} aria-hidden className="absolute inset-x-0 inset-y-2 block h-12 w-full" />
              ) : (
                <div aria-hidden className="absolute inset-x-0 inset-y-2 animate-pulse rounded bg-accent motion-reduce:animate-none" />
              )}
              {gaps.map((g) => (
                <div
                  key={`s${g.startUs}-${g.endUs}`}
                  aria-hidden
                  className="hatch-removed pointer-events-none absolute inset-y-2"
                  style={{ left: pct(g.startUs, durationUs), width: pct(g.endUs - g.startUs, durationUs) }}
                />
              ))}
            </div>

            {/* 悬停位置 */}
            {hoverR !== null && (
              <div
                aria-hidden
                className="pointer-events-none absolute bottom-0 top-9 z-20 border-l border-dashed border-foreground/50"
                style={{ left: `${hoverR}%` }}
              />
            )}

            {/* 播放头：时间码标签 + 贯穿各轨的竖线 */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 z-30 -ml-px w-0.5 bg-primary shadow-[0_0_8px_var(--primary)]"
              style={{ left: `${playheadR}%` }}
            >
              <span
                className={cn(
                  "num absolute top-1 whitespace-nowrap rounded-md bg-primary px-1.5 py-0.5 text-xs font-medium leading-none text-primary-foreground shadow-md",
                  tagAlign(playheadR),
                )}
              >
                {formatTimecode(playheadUs)}
              </span>
              <span className="absolute left-1/2 top-[1.375rem] size-2 -translate-x-1/2 rotate-45 bg-primary" />
            </div>
          </div>
        </div>
      </div>

      {/* 图例 */}
      <div aria-hidden className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-5 rounded-sm border border-primary bg-surface-3" />
          {t("library.legendKept")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="hatch-removed h-3 w-5 rounded-sm border border-dashed border-destructive/50" />
          {t("library.legendRemoved")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-0.5 rounded-full bg-primary" />
          {t("library.legendPlayhead")}
        </span>
        <span className="ml-auto">{t("library.timelineHint")}</span>
      </div>
    </div>
  );
}
