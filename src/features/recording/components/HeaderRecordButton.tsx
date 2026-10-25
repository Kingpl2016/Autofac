import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Circle, Loader2, Square, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppModeStore } from "@/features/app-mode";
import { formatDiskBytes } from "@/shared/domain/disk";
import { cn } from "@/lib/utils";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { formatBytes, formatDurationUs } from "../lib/filter";
import { startQuickRecording, stopRecordingWithToast } from "../lib/recordControl";
import { useRecordingStore } from "../stores/useRecordingStore";
import { PulseRing } from "./console/PulseRing";

/** 鼠标离开后延迟多久收起详情（毫秒）：给指针从按钮移到浮层留出时间。 */
const HOVER_CLOSE_MS = 150;

/**
 * 顶栏录制按钮：在任何页面都能开始 / 停止录制。
 *
 * - 空闲：轮廓按钮“● 录制”，点击以“快速录制”（全量采集）开始，与全局快捷键共用同一实现；
 * - 录制中：红色“■ 时间码”停止按钮 + 脉冲指示，旁边的“录制详情”展开时长 / 帧数 / 丢帧 / 大小 / 空间；
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

  const recording = status.recording;
  const blocked = appMode === "player";

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
      await startQuickRecording(t);
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
              {/* 预留固定宽度，时间码跳动时不挤动旁边的控件 */}
              <span className="num inline-block min-w-[6ch] text-left">
                {formatDurationUs(status.elapsedUs)}
              </span>
              <PulseRing active className="-mr-1" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("header.recStopHint", { key: stopKey })}</TooltipContent>
        </Tooltip>

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
            <RecordStats />
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  const label = t("header.recStart");
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
          aria-label={blocked ? `${label}：${t("mode.guardRecord")}` : label}
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
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {blocked ? t("mode.guardRecord") : t("header.recStartHint", { key: startKey })}
      </TooltipContent>
    </Tooltip>
  );
}

/** 录制详情：两列定义列表，丢帧 > 0 时用图标 + 文字标出（不只靠颜色）。 */
function RecordStats() {
  const { t } = useTranslation();
  const s = useRecordingStore((st) => st.status);

  const rows: Array<{ label: string; value: string; warn?: boolean }> = [
    { label: t("recording.statDuration"), value: formatDurationUs(s.elapsedUs) },
    { label: t("recording.statFrames"), value: String(s.stats.frames) },
    { label: t("recording.statDropped"), value: String(s.dropped), warn: s.dropped > 0 },
    { label: t("recording.statSize"), value: formatBytes(s.stats.bytes) },
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
  );
}
