import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Circle, ListFilter, Loader2, Square, TriangleAlert } from "lucide-react";
import { Link, useInRouterContext } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppModeStore } from "@/features/app-mode";
import { formatDiskBytes } from "@/shared/domain/disk";
import { cn } from "@/lib/utils";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { formatBytesIec } from "@/shared/lib/format";
import { formatDurationUs } from "../lib/filter";
import { startRecording, stopRecordingWithToast } from "../lib/recordControl";
import { describePreset, isPresetFiltered, renderNameTemplate } from "../lib/recordingPreset";
import { useRecordingPreset, useRecordingPresetStore } from "../stores/useRecordingPresetStore";
import { useRecordingStore } from "../stores/useRecordingStore";
import { useRecordingClock } from "../hooks/useRecordingClock";
import { PulseRing } from "./console/PulseRing";
import { RecordHeadStrip } from "./RecordHeadStrip";

/** 鼠标离开后延迟多久收起详情（毫秒）：给指针从按钮移到浮层留出时间。 */
const HOVER_CLOSE_MS = 150;

/**
 * 顶栏录制按钮：在任何页面都能开始 / 停止录制。
 *
 * - 空闲：轮廓按钮“● 录制”，点击按“当前录制预设”开始（与录制页、全局快捷键共用同一实现）；
 *   预设带过滤时按钮上有“已过滤”标记，提示里列出预设摘要与下一个节目名称，避免误以为在全量录制；
 * - 录制中：红色“■ 时间码”停止按钮 + 脉冲指示，旁边的“录制详情”展开时长 / 帧数 / 丢帧 / 大小 / 空间、
 *   本次使用的预设摘要与“打开录制页”链接；
 * - 播放器模式：**不隐藏**，用 `aria-disabled` 保持可聚焦，悬停 / 聚焦时说明原因。
 *
 * 详情用 Popover 而不是 Tooltip：内容要能被键盘到达，也不能只靠悬停。
 * 鼠标悬停时自动展开（带收起延迟），键盘 / 触屏则点击或 `Enter` 展开。
 */
export function HeaderRecordButton() {
  const { t } = useTranslation();
  const status = useRecordingStore((s) => s.status);
  const appMode = useEngineStatusStore((s) => s.appMode);
  const transitioning = useAppModeStore((s) => s.transitioning);
  const startKey = usePrefsStore((s) => s.recordHotkeys.start);
  const stopKey = usePrefsStore((s) => s.recordHotkeys.stop);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const clock = useRecordingClock();
  const preset = useRecordingPreset();
  const sacnEnabled = useRecordingPresetStore((s) => s.sacnEnabled);

  const recording = status.recording;
  const blocked = appMode === "player";
  const filtered = isPresetFiltered(preset, sacnEnabled);
  const presetText = describePreset(preset, sacnEnabled, t).join(" · ");
  const nextName = renderNameTemplate(preset.nameTemplate, preset.nextIndex);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const hoverOpen = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    cancelClose();
    setDetailsOpen(true);
  };
  const hoverClose = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => setDetailsOpen(false), HOVER_CLOSE_MS);
  };

  const start = async () => {
    setBusy("start");
    try {
      await startRecording(t);
    } finally {
      setBusy(null);
    }
  };
  const stop = async () => {
    setBusy("stop");
    try {
      await stopRecordingWithToast(t);
    } finally {
      setBusy(null);
    }
  };

  if (recording) {
    return (
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="destructive"
              size="sm"
              className="h-9 gap-2"
              disabled={busy !== null || transitioning}
              aria-busy={busy === "stop"}
              aria-label={t("header.recStop")}
              onClick={() => void stop()}
            >
              {busy === "stop" ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Square className="fill-current" aria-hidden />
              )}
              {/* 预留固定宽度，时间码跳动时不挤动旁边的控件；显示整个会话的时长（跨分段累加） */}
              <span className="num inline-block min-w-[6ch] text-left">
                {formatDurationUs(clock.sessionUs)}
              </span>
              <PulseRing active className="-mr-1" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("header.recStopHint", { key: stopKey })}</TooltipContent>
        </Tooltip>

        {status.part > 1 && (
          <Badge
            variant="outline"
            className="num"
            title={t("header.recPartLabel", { n: status.part })}
            aria-label={t("header.recPartLabel", { n: status.part })}
          >
            {t("header.recPartShort", { n: status.part })}
          </Badge>
        )}
        {status.dropped > 0 && (
          <Badge variant="warning" className="num" data-testid="header-rec-dropped">
            <TriangleAlert className="size-3" aria-hidden />
            {t("header.recDropped", { n: status.dropped })}
          </Badge>
        )}
        <div className="ml-1 hidden lg:block">
          <RecordHeadStrip
            sessionUs={clock.sessionUs}
            label={t("header.recHeadStrip", { elapsed: formatDurationUs(clock.sessionUs) })}
          />
        </div>

        <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              aria-label={t("header.recDetails")}
              onPointerEnter={hoverOpen}
              onPointerLeave={hoverClose}
            >
              <ChevronDown aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            aria-label={t("header.recDetails")}
            onPointerEnter={hoverOpen}
            onPointerLeave={hoverClose}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <RecordStats sessionUs={clock.sessionUs} partUs={clock.partUs} presetText={presetText} />
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  const label = t("header.recStart");
  const fullLabel = filtered ? `${label}（${t("header.recFiltered")}）` : label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-9 gap-2", blocked && "cursor-not-allowed opacity-60")}
          // 播放器模式下用 aria-disabled 而不是 disabled：保持可聚焦，键盘用户也能读到原因
          aria-disabled={blocked || undefined}
          disabled={busy !== null || transitioning}
          aria-busy={busy === "start"}
          aria-label={blocked ? `${fullLabel}：${t("mode.guardRecord")}` : fullLabel}
          onClick={() => {
            if (blocked) return;
            void start();
          }}
        >
          {busy === "start" ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Circle className="fill-recording text-recording" aria-hidden />
          )}
          <span className="max-xl:sr-only">{label}</span>
          {/* 预设带过滤时的标记：避免以为在全量录制，实际却被过滤 */}
          {filtered && (
            <ListFilter className="text-primary" data-testid="header-rec-filtered" aria-hidden />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        {blocked ? (
          t("mode.guardRecord")
        ) : (
          <div className="grid gap-1">
            <p className="font-medium">{t("header.recStartHint", { key: startKey })}</p>
            <p className="opacity-80">{presetText}</p>
            <p className="opacity-80">
              {t("recording.nextName")} {nextName || t("recording.nameTimestampOnly")}
            </p>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

interface RecordStatsProps {
  /** 会话总时长（微秒，已平滑外推） */
  sessionUs: number;
  /** 当前分段时长（微秒） */
  partUs: number;
  /** 本次使用的录制预设摘要（录制中预设不可修改，即开始时的预设） */
  presetText: string;
}

/**
 * 录制详情：迷你录制时间线 + 两列定义列表，丢帧 > 0 时用图标 + 文字标出（不只靠颜色）。
 * 分段录制时同时列出“本段时长”与“会话总时长”。
 */
function RecordStats({ sessionUs, partUs, presetText }: RecordStatsProps) {
  const { t } = useTranslation();
  const inRouter = useInRouterContext();
  const s = useRecordingStore((st) => st.status);

  const durationRows: Array<{ label: string; value: string; warn?: boolean }> =
    s.part > 1
      ? [
          { label: t("recording.statSessionDuration"), value: formatDurationUs(sessionUs) },
          {
            label: t("recording.statPartDuration", { n: s.part }),
            value: formatDurationUs(partUs),
          },
        ]
      : [{ label: t("recording.statDuration"), value: formatDurationUs(sessionUs) }];
  const rows: Array<{ label: string; value: string; warn?: boolean }> = [
    ...durationRows,
    { label: t("recording.statFrames"), value: String(s.stats.frames) },
    { label: t("recording.statDropped"), value: String(s.dropped), warn: s.dropped > 0 },
    { label: t("recording.statSize"), value: formatBytesIec(s.stats.bytes) },
    { label: t("recording.statUniverses"), value: String(s.universes.length) },
  ];
  if (s.diskFreeBytes !== null) {
    rows.push({
      label: t("recording.statDiskFree"),
      value: formatDiskBytes(s.diskFreeBytes),
      warn: s.diskLevel !== "ok",
    });
  }

  return (
    <div className="grid gap-3">
      <RecordHeadStrip
        sessionUs={sessionUs}
        label={t("header.recHeadStrip", { elapsed: formatDurationUs(sessionUs) })}
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className={cn("text-muted-foreground", r.warn && "text-warning")}>{r.label}</dt>
            <dd className={cn("num text-right font-medium", r.warn && "text-warning")}>
              {r.warn && <TriangleAlert className="mr-1 inline size-3.5 align-text-bottom" aria-hidden />}
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-2 border-t border-border pt-3 text-xs">
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{t("recording.presetLabel")}</span>{" "}
          {presetText}
        </p>
        {inRouter && (
          <Link to="/recording" className="text-primary underline-offset-2 hover:underline">
            {t("header.recOpenPage")}
          </Link>
        )}
      </div>
    </div>
  );
}
