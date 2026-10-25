import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useSeries } from "../hooks/useSeries";
import {
  curveStyle,
  curveWindow,
  drawCurves,
  parseChannelList,
  summarizeSeries,
  windowTimeToX,
  type CurveWindow,
} from "../lib/curves";
import { formatDurationUs } from "../lib/filter";

/** 曲线区高度（像素）。 */
const CANVAS_HEIGHT = 176;
/** 输入防抖（毫秒）。 */
const INPUT_DEBOUNCE_MS = 300;

interface ChannelCurvesProps {
  /** 节目路径 */
  path: string;
  /** 节目总时长（微秒） */
  durationUs: number;
  /** 当前播放位置（微秒） */
  posUs: number;
  /** 节目内的 Universe 编号 */
  universes: number[];
}

/** 读取主题变量解析后的颜色。 */
function themeColor(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 通道曲线：选定 Universe 与若干通道，查看其电平随时间的变化。
 *
 * 后端按画布宽度做 min/max 降采样，因此单帧尖峰不会在缩小显示时丢失；
 * 可看整段节目，也可只看播放头附近的 10 秒 / 60 秒窗口。
 */
export function ChannelCurves({ path, durationUs, posUs, universes }: ChannelCurvesProps) {
  const { t } = useTranslation();
  const theme = usePrefsStore((s) => s.theme);
  const accent = usePrefsStore((s) => s.accent);

  const [universeChoice, setUniverseChoice] = useState<number | null>(null);
  const universe =
    universeChoice !== null && universes.includes(universeChoice)
      ? universeChoice
      : (universes[0] ?? null);
  const [channelText, setChannelText] = useState("1");
  const [mode, setMode] = useState<CurveWindow>("all");
  const debouncedText = useDebouncedValue(channelText, INPUT_DEBOUNCE_MS);
  const channels = useMemo(() => parseChannelList(debouncedText), [debouncedText]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [t0, t1] = curveWindow(mode, posUs, durationUs);
  const maxPoints = Math.min(1200, Math.max(64, Math.floor(width / 2)));
  const query = useSeries({ path, universe, channels, t0Us: t0, t1Us: t1, maxPoints });
  // 通道清空后即使缓存里还留着上一次结果也不再显示
  const series = channels.length > 0 ? query.data : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // 测试环境（jsdom）没有 2D 上下文
    canvas.width = width; // 同时清空画布
    canvas.height = CANVAS_HEIGHT;
    if (!series) return;
    drawCurves(ctx, series, {
      t0,
      t1,
      width,
      height: CANVAS_HEIGHT,
      colors: series.map((_, i) =>
        themeColor(canvas, curveStyle(i).colorVar, "currentColor"),
      ),
      gridColor: themeColor(canvas, "--border", "currentColor"),
    });
    // theme / accent 只用于触发重绘：颜色变量变化后重新取色
  }, [series, t0, t1, width, theme, accent]);

  const summary = useMemo(() => (series ? summarizeSeries(series) : []), [series]);
  const playheadVisible = posUs >= t0 && posUs <= t1 && t1 > t0;
  const playheadX = windowTimeToX(posUs, t0, t1, 100);

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-[10rem_1fr_12rem]">
        <div className="grid content-start gap-1.5">
          <Label htmlFor="curve-universe">{t("player.curveUniverse")}</Label>
          <Select
            value={universe === null ? "" : String(universe)}
            onValueChange={(v) => setUniverseChoice(Number(v))}
          >
            <SelectTrigger id="curve-universe" className="tabular">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {universes.map((u) => (
                <SelectItem key={u} value={String(u)} className="tabular">
                  {u}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="curve-channels">{t("player.curveChannels")}</Label>
          <Input
            id="curve-channels"
            className="tabular"
            value={channelText}
            placeholder="1, 2, 10-12"
            onChange={(e) => setChannelText(e.target.value)}
          />
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="curve-window">{t("player.curveWindow")}</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as CurveWindow)}>
            <SelectTrigger id="curve-window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("player.windowAll")}</SelectItem>
              <SelectItem value="s10">{t("player.windowTen")}</SelectItem>
              <SelectItem value="s60">{t("player.windowSixty")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 图表块始终挂载，保证 ResizeObserver 持续跟踪宽度；无通道时在图上提示 */}
      <div className="grid content-start gap-1.5">
          <div className="flex">
            <div
              className="tabular flex w-9 shrink-0 flex-col justify-between pr-1.5 text-right text-[0.65rem] text-muted-foreground"
              style={{ height: CANVAS_HEIGHT }}
              aria-hidden
            >
              <span>255</span>
              <span>128</span>
              <span>0</span>
            </div>
            <div
              ref={wrapRef}
              className="relative min-w-0 flex-1 rounded-md border border-border bg-muted/30"
              style={{ height: CANVAS_HEIGHT }}
              role="img"
              aria-label={t("player.curveAria", {
                universe: universe ?? "",
                n: channels.length,
              })}
            >
              <canvas ref={canvasRef} className="block size-full" aria-hidden />
              {playheadVisible && (
                <div
                  className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground"
                  style={{ left: `${playheadX}%` }}
                  aria-hidden
                />
              )}
              {channels.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  {t("player.curveNoChannels")}
                </div>
              ) : (
                query.isFetching &&
                !series && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                    {t("player.overviewLoading")}
                  </div>
                )
              )}
            </div>
          </div>
          <div className="tabular ml-9 flex justify-between text-[0.7rem] text-muted-foreground" aria-hidden>
            <span>{formatDurationUs(t0)}</span>
            <span>{formatDurationUs(t1)}</span>
          </div>
      </div>

      {query.isError && (
        <p className="text-xs text-warning">{t("player.curveFailed")}</p>
      )}

      {/* 图例：颜色 + 线型 + 通道号 */}
      {series && series.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {series.map((s, i) => {
            const st = curveStyle(i);
            return (
              <li key={s.channel} className="tabular flex items-center gap-1.5">
                <svg width="22" height="8" aria-hidden>
                  <line
                    x1="0"
                    y1="4"
                    x2="22"
                    y2="4"
                    strokeWidth="2"
                    strokeDasharray={st.dash.join(" ")}
                    style={{ stroke: `var(${st.colorVar})` }}
                  />
                </svg>
                <span className={cn("text-muted-foreground")}>
                  {t("player.curveLegend", { ch: s.channel + 1 })}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* 文字替代：每个通道在窗口内的范围 */}
      {summary.length > 0 && (
        <table className="sr-only">
          <caption>{t("player.curveSummary")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("player.curveChannels")}</th>
              <th scope="col">{t("player.curveMin")}</th>
              <th scope="col">{t("player.curveMax")}</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((r) => (
              <tr key={r.channel}>
                <th scope="row">{r.channel}</th>
                <td>{r.min}</td>
                <td>{r.max}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
