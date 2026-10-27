import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Circle, Loader2, Square } from "lucide-react";
import { Link, useInRouterContext } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { InlineAlert } from "@/shared/components/InlineAlert";
import { StatusPill } from "@/shared/components/StatusPill";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { MIN_START_FREE_BYTES, formatDiskBytes, type DiskInfo } from "@/shared/domain/disk";
import { MetricChip } from "./console/MetricChip";
import { PulseRing } from "./console/PulseRing";
import { TimeCode } from "./console/TimeCode";
import { sessionBase, useRecordingClock } from "../hooks/useRecordingClock";
import { formatBytes, formatDurationUs } from "../lib/filter";
import type { RecordingResult, RecordingStatus } from "../lib/types";

/** 磁盘不足说明的元素 id（开始按钮经 `aria-describedby` 关联）。 */
const DISK_HELP_ID = "rec-disk-help";

interface TransportBarProps {
  status: RecordingStatus;
  /** 最近一次录制的结果（只用于异常提示：被迫停止 / 丢帧） */
  last: RecordingResult | null;
  /** 正在处理的动作（开始 / 停止） */
  busy: "start" | "stop" | null;
  /** 空闲时的录制目录空间信息（录制中改用 `status` 里的实时值）；未知为 null */
  disk: DiskInfo | null;
  /** 当前检测到的来源数量 */
  sourceCount: number;
  /** 当前活跃 Universe 数量 */
  activeCount: number;
  /** 按预设将录制的 Universe 数量 */
  plannedCount: number;
  /** 当前预设的摘要短语 */
  presetParts: string[];
  /** 下一次录制的节目名称（空表示只用时间戳） */
  nextName: string;
  onStart: () => void;
  onStop: () => void;
}

/**
 * 走带条：录制页最上方的固定控制区（参照 DAW / OBS 的走带区）。
 *
 * 左：状态 + 大号时间码；中：4 个固定指标位（待机：来源 / 活跃 Universe / 将录制 / 剩余空间，
 * 录制中：帧数 / 文件大小 / 丢帧 / 剩余空间）；右：当前预设摘要、节目名称与开始 / 停止主按钮。
 * 三种状态下的栅格、指标位数量与尺寸都不变，数字原地更新、布局不跳。
 *
 * 只有异常结果（因磁盘空间被迫停止、丢帧）会在下方留下可关闭的告警，下次开始录制时自动清除；
 * 正常录完直接回到待机，结果在节目库里体现。
 */
export function TransportBar({
  status,
  last,
  busy,
  disk,
  sourceCount,
  activeCount,
  plannedCount,
  presetParts,
  nextName,
  onStart,
  onStop,
}: TransportBarProps) {
  const { t } = useTranslation();
  const recording = status.recording;
  const clock = useRecordingClock();
  // 已关闭告警对应的那次结果；换了一次结果后告警重新出现
  const [dismissedStop, setDismissedStop] = useState<RecordingResult | null>(null);
  const [dismissedDrop, setDismissedDrop] = useState<RecordingResult | null>(null);

  // 录制中显示整个会话的时长（跨分段累加），两次推送之间平滑外推
  const shownUs = recording ? Math.max(clock.sessionUs, sessionBase(status)) : 0;

  const diskFree = recording ? status.diskFreeBytes : (disk?.freeBytes ?? null);
  const diskLevel = recording ? status.diskLevel : (disk?.level ?? "ok");
  const diskBlocked = !recording && disk !== null && !disk.canStart;
  const diskValue =
    diskFree === null
      ? "—"
      : diskLevel === "ok"
        ? formatDiskBytes(diskFree)
        : `${formatDiskBytes(diskFree)} · ${t("recording.diskLowTag")}`;
  const diskWarn = diskFree !== null && diskLevel !== "ok";

  const showStopAlert = !recording && last?.stoppedBy === "disk" && dismissedStop !== last;
  const lastDropped = last?.dropped ?? 0;
  const showDropAlert = !recording && last !== null && lastDropped > 0 && dismissedDrop !== last;

  return (
    // 按自身宽度（容器查询）而不是窗口宽度排版：旁边常驻节目库时主区可能比窗口窄得多
    <SurfacePanel tone={recording ? "recording" : "default"} className="@container grid gap-5">
      {/* 两侧列给定宽度上限，中间指标区始终拿到剩余空间，不被长文案挤窄 */}
      <div className="grid items-center gap-x-8 gap-y-5 @3xl:grid-cols-[minmax(12rem,15rem)_minmax(0,1fr)_minmax(15rem,18rem)]">
        {/* 左：状态 + 时间码 */}
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <PulseRing active={recording} />
            <StatusPill tone={recording ? "recording" : "idle"}>
              {recording ? t("recording.recording") : t("recording.idle")}
            </StatusPill>
            {recording && status.part > 1 && (
              <Badge variant="outline" className="num">
                {t("recording.partBadge", {
                  n: status.part,
                  time: formatDurationUs(clock.partUs),
                })}
              </Badge>
            )}
          </div>
          <TimeCode valueUs={shownUs} size="xl" tone={recording ? "recording" : "idle"} />
          <p
            className={cn("text-xs text-muted-foreground", recording ? "truncate" : "line-clamp-2")}
            title={recording ? status.path : undefined}
          >
            {recording ? status.path : t("recording.idleHint")}
          </p>
        </div>

        {/* 中：4 个固定指标位 */}
        <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-4 @md:grid-cols-4 @3xl:grid-cols-2 @6xl:grid-cols-4">
          {recording ? (
            <>
              <MetricChip label={t("recording.statFrames")} value={String(status.stats.frames)} />
              <MetricChip label={t("recording.statSize")} value={formatBytes(status.stats.bytes)} />
              <MetricChip
                label={t("recording.statDropped")}
                value={String(status.dropped)}
                warn={status.dropped > 0}
              />
            </>
          ) : (
            <>
              <MetricChip label={t("recording.statSources")} value={String(sourceCount)} />
              <MetricChip label={t("recording.statActiveUniverses")} value={String(activeCount)} />
              <MetricChip
                label={t("recording.statPlanned")}
                value={String(plannedCount)}
                warn={plannedCount === 0}
              />
            </>
          )}
          <MetricChip label={t("recording.statDiskFree")} value={diskValue} warn={diskWarn} />
        </dl>

        {/* 右：预设摘要 + 名称 + 主按钮 */}
        <div className="grid min-w-0 content-start gap-3">
          <div className="grid gap-1 text-xs">
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">{t("recording.presetLabel")}</span>{" "}
              {presetParts.join(" · ")}
            </p>
            <p className="truncate text-muted-foreground">
              <span className="font-medium text-foreground">
                {recording ? t("recording.currentName") : t("recording.nextName")}
              </span>{" "}
              {(recording ? status.name : nextName) || t("recording.nameTimestampOnly")}
            </p>
          </div>

          {recording ? (
            <Button
              variant="destructive"
              className="h-14 w-full rounded-xl text-base"
              onClick={onStop}
              disabled={busy === "stop"}
              aria-busy={busy === "stop"}
            >
              {busy === "stop" ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Square className="fill-current" aria-hidden />
              )}
              {busy === "stop" ? t("recording.saving") : t("recording.stop")}
            </Button>
          ) : (
            <Button
              className="h-14 w-full rounded-xl bg-recording text-base text-recording-foreground hover:bg-recording/90"
              onClick={onStart}
              disabled={busy === "start" || diskBlocked}
              aria-busy={busy === "start"}
              aria-describedby={diskBlocked ? DISK_HELP_ID : undefined}
            >
              {busy === "start" ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Circle className="fill-current" aria-hidden />
              )}
              {t("recording.start")}
            </Button>
          )}
        </div>
      </div>

      {(diskBlocked || showStopAlert || showDropAlert || (recording && status.dropped > 0)) && (
        <div className="grid gap-2 empty:hidden">
          {diskBlocked && disk && (
            <InlineAlert tone="destructive">
              <span id={DISK_HELP_ID}>
                {t("recording.diskBlocked", {
                  free: formatDiskBytes(disk.freeBytes ?? 0),
                  min: formatDiskBytes(MIN_START_FREE_BYTES),
                })}
              </span>{" "}
              <SettingsLink />
            </InlineAlert>
          )}
          {showStopAlert && (
            <InlineAlert tone="destructive" assertive onDismiss={() => setDismissedStop(last)}>
              {t("recording.stoppedByDisk")}
            </InlineAlert>
          )}
          {showDropAlert && (
            <InlineAlert onDismiss={() => setDismissedDrop(last)}>
              {t("recording.droppedWarn", { n: lastDropped })}
            </InlineAlert>
          )}
          {recording && status.dropped > 0 && (
            <InlineAlert>{t("recording.droppedWarn", { n: status.dropped })}</InlineAlert>
          )}
        </div>
      )}
    </SurfacePanel>
  );
}

/** “更改录制目录”链接；不在路由上下文中（单元测试）时不渲染。 */
function SettingsLink() {
  const { t } = useTranslation();
  const inRouter = useInRouterContext();
  if (!inRouter) return null;
  return (
    <Link to="/settings" className="underline underline-offset-2">
      {t("recording.diskChangeDir")}
    </Link>
  );
}
