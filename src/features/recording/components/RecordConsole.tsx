import { useTranslation } from "react-i18next";
import { Circle, Loader2, Square, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UniverseSnapshot } from "@/shared/domain/engine";
import { MetricChip } from "./console/MetricChip";
import { PulseRing } from "./console/PulseRing";
import { StatusPill } from "./console/StatusPill";
import { SurfacePanel } from "./console/SurfacePanel";
import { TimeCode } from "./console/TimeCode";
import { formatBytes } from "../lib/filter";
import type { RecordingResult, RecordingStatus, UniversePlan } from "../lib/types";

/** 活动条最多显示的 Universe 数，其余折叠为“另有 N 个”。 */
const MAX_ACTIVITY_CHIPS = 32;
/** 一个 Universe 的通道数，用于换算活动比例。 */
const CHANNELS_PER_UNIVERSE = 512;

/** 列表过长时截断显示。 */
function summarize(list: number[], max = 8): string {
  return list.length <= max
    ? list.join(", ")
    : `${list.slice(0, max).join(", ")} … (+${list.length - max})`;
}

interface RecordConsoleProps {
  status: RecordingStatus;
  /** 最近一次录制的结果（空闲时展示摘要） */
  last: RecordingResult | null;
  /** 正在处理的动作（开始 / 停止） */
  busy: "start" | "stop" | null;
  /** 回放模式中不允许开始录制 */
  playbackLoaded: boolean;
  /** 实时 Universe 快照，用于活动条 */
  snapshots: UniverseSnapshot[];
  /** 按当前过滤条件规划出的 Universe（空闲时作为“将录制”预览） */
  plan: UniversePlan;
  /** 当前检测到的来源（发送方 IP）数量，待机时作为“有没有信号”的提示 */
  sourceCount: number;
  /** 节目名称 / 备注（受控输入，录制中锁定） */
  name: string;
  notes: string;
  onNameChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
}

/**
 * 录制舱：左侧是状态、大号时间码与实时指标，右侧是节目名称 / 备注与开始 / 停止主按钮，
 * 底部是 Universe 活动条（空闲时即“将录制什么”的预览，录制中即已录 Universe 的实时活动）。
 */
export function RecordConsole({
  status,
  last,
  busy,
  playbackLoaded,
  snapshots,
  plan,
  sourceCount,
  name,
  notes,
  onNameChange,
  onNotesChange,
  onStart,
  onStop,
}: RecordConsoleProps) {
  const { t } = useTranslation();
  const recording = status.recording;
  const s = status.stats;

  const lastFrames = last?.files.reduce((n, f) => n + f.frames, 0) ?? 0;
  const lastBytes = last?.files.reduce((n, f) => n + f.bytes, 0) ?? 0;
  const lastDuration = last?.files.reduce((n, f) => n + f.durationUs, 0) ?? 0;
  const lastDropped = last?.dropped ?? 0;

  const shownUs = recording ? status.elapsedUs : lastDuration;
  const shownUniverses = recording ? status.universes : plan.accepted;
  const fieldLabel = "text-xs font-medium text-muted-foreground";

  return (
    <SurfacePanel tone={recording ? "recording" : "default"}>
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        {/* 左：状态 + 时间码 + 指标 */}
        <div className="grid min-w-0 content-between gap-6">
          <div className="grid gap-4">
            <div className="flex items-center gap-2.5">
              <PulseRing active={recording} />
              <StatusPill tone={recording ? "recording" : playbackLoaded ? "warning" : "idle"}>
                {recording
                  ? t("recording.recording")
                  : playbackLoaded
                    ? t("recording.playback")
                    : t("recording.idle")}
              </StatusPill>
              {!recording && last && (
                <span className="text-xs text-muted-foreground">{t("recording.lastResult")}</span>
              )}
            </div>
            <TimeCode
              valueUs={shownUs}
              size="xl"
              tone={recording ? "recording" : last ? "default" : "idle"}
            />
            {recording ? (
              <p className="break-all text-xs text-muted-foreground" title={status.path}>
                {status.path}
              </p>
            ) : (
              !last && <p className="text-sm text-muted-foreground">{t("recording.idleHint")}</p>
            )}
          </div>

          {/* 待机：显示“有没有信号”，让空闲的录制舱也有实时反馈 */}
          {!recording && !last && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <MetricChip label={t("recording.statSources")} value={String(sourceCount)} />
              <MetricChip
                label={t("recording.statActiveUniverses")}
                value={String(snapshots.length)}
              />
              <MetricChip
                label={t("recording.statPlanned")}
                value={String(plan.accepted.length)}
              />
            </dl>
          )}

          {(recording || last) && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
              {recording ? (
                <>
                  <MetricChip label={t("recording.statFrames")} value={String(s.frames)} />
                  <MetricChip label={t("recording.statSize")} value={formatBytes(s.bytes)} />
                  <MetricChip
                    label={t("recording.statUniverses")}
                    value={String(status.universes.length)}
                  />
                  <MetricChip label={t("recording.statPart")} value={String(status.part)} />
                  <MetricChip
                    label={t("recording.statFiltered")}
                    value={String(s.filteredPackets)}
                  />
                  <MetricChip
                    label={t("recording.statDropped")}
                    value={String(status.dropped)}
                    warn={status.dropped > 0}
                  />
                </>
              ) : (
                <>
                  <MetricChip label={t("recording.statFrames")} value={String(lastFrames)} />
                  <MetricChip label={t("recording.statSize")} value={formatBytes(lastBytes)} />
                  <MetricChip
                    label={t("recording.statFiles")}
                    value={String(last?.files.length ?? 0)}
                  />
                  <MetricChip
                    label={t("recording.statDropped")}
                    value={String(lastDropped)}
                    warn={lastDropped > 0}
                  />
                </>
              )}
            </dl>
          )}
        </div>

        {/* 右：节目信息 + 主按钮 */}
        <div className="grid content-start gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="rec-name" className={fieldLabel}>
              {t("recording.name")}
            </Label>
            <Input
              id="rec-name"
              value={name}
              disabled={recording}
              placeholder={t("recording.namePlaceholder")}
              onChange={(e) => onNameChange(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rec-notes" className={fieldLabel}>
              {t("recording.notes")}
            </Label>
            <Input
              id="rec-notes"
              value={notes}
              disabled={recording}
              onChange={(e) => onNotesChange(e.target.value)}
            />
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
                <Loader2 className="animate-spin" />
              ) : (
                <Square className="fill-current" />
              )}
              {busy === "stop" ? t("recording.saving") : t("recording.stop")}
            </Button>
          ) : (
            <Button
              className="h-14 w-full rounded-xl bg-recording text-base text-recording-foreground hover:bg-recording/90"
              onClick={onStart}
              disabled={busy === "start" || playbackLoaded}
              aria-busy={busy === "start"}
            >
              {busy === "start" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Circle className="fill-current" />
              )}
              {t("recording.start")}
            </Button>
          )}
          {playbackLoaded && !recording && (
            <p className="flex items-start gap-2 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t("recording.playbackBlocks")}
            </p>
          )}
        </div>
      </div>

      {/* 底部：Universe 预览 / 活动 */}
      <div className="mt-6 border-t border-border pt-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          {recording ? (
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("recording.activityTitle")}
            </h3>
          ) : (
            <>
              <Badge variant={plan.accepted.length > 0 ? "default" : "warning"}>
                {plan.accepted.length > 0
                  ? t("recording.previewCount", { n: plan.accepted.length })
                  : t("recording.previewNone")}
              </Badge>
              <span className="text-xs text-muted-foreground">{t("recording.fixedSetNote")}</span>
            </>
          )}
        </div>

        {shownUniverses.length > 0 && (
          <UniverseActivity universes={shownUniverses} snapshots={snapshots} />
        )}

        {!recording && plan.rejectedOutOfRange.length > 0 && (
          <Warn>
            {t("recording.rejectedOutOfRange", { list: summarize(plan.rejectedOutOfRange) })}
          </Warn>
        )}
        {!recording && plan.rejectedOverCapacity.length > 0 && (
          <Warn>
            {t("recording.rejectedOverCapacity", { list: summarize(plan.rejectedOverCapacity) })}
          </Warn>
        )}
        {!recording && last && (
          <ul className="mt-3 grid gap-1 text-xs text-muted-foreground">
            {last.files.map((f) => (
              <li key={f.path} className="break-all" title={f.path}>
                {f.path}
              </li>
            ))}
          </ul>
        )}
        {recording && status.stats.ignoredUniverses > 0 && (
          <Warn>{t("recording.ignoredWarn", { n: status.stats.ignoredUniverses })}</Warn>
        )}
        {(recording ? status.dropped : lastDropped) > 0 && (
          <Warn>
            {t("recording.droppedWarn", { n: recording ? status.dropped : lastDropped })}
          </Warn>
        )}
      </div>
    </SurfacePanel>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 flex items-start gap-2 text-xs text-warning">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

interface UniverseActivityProps {
  universes: number[];
  snapshots: UniverseSnapshot[];
}

/**
 * Universe 活动条：每路一个小块，条的长度按“有输出的通道数 / 512”缩放（只用 transform）。
 */
function UniverseActivity({ universes, snapshots }: UniverseActivityProps) {
  const { t } = useTranslation();
  const active = new Map(snapshots.map((u) => [u.universe, u.activeChannels] as const));
  const shown = universes.slice(0, MAX_ACTIVITY_CHIPS);
  const more = universes.length - shown.length;

  return (
    <ul className="flex flex-wrap gap-2" aria-label={t("recording.activityTitle")}>
      {shown.map((u) => {
        const channels = active.get(u) ?? 0;
        const ratio = Math.min(1, channels / CHANNELS_PER_UNIVERSE);
        return (
          <li
            key={u}
            className="w-[4.5rem] rounded-lg bg-surface-1 px-2.5 py-2"
            title={t("recording.activityChip", { u, n: channels })}
          >
            <div className="num text-xs font-semibold">{u}</div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full origin-left rounded-full bg-success transition-transform duration-200"
                style={{ transform: `scaleX(${ratio})` }}
              />
            </div>
          </li>
        );
      })}
      {more > 0 && (
        <li className="flex items-center px-1 text-xs text-muted-foreground">
          {t("recording.activityMore", { n: more })}
        </li>
      )}
    </ul>
  );
}
