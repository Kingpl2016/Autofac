import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { InlineAlert } from "@/shared/components/InlineAlert";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { UniverseSnapshot } from "@/shared/domain/engine";
import { RecordTimeline } from "./RecordTimeline";
import { MAX_UNIVERSE, MAX_UNIVERSES_PER_FILE } from "../lib/filter";
import type { RecordingStatus, UniversePlan } from "../lib/types";

/** 活动块最多显示的 Universe 数，其余折叠为“另有 N 个”。 */
const MAX_ACTIVITY_CHIPS = 32;
/** 一个 Universe 的通道数，用于换算活动比例。 */
const CHANNELS_PER_UNIVERSE = 512;

/** 列表过长时截断显示。 */
function summarize(list: number[], max = 8): string {
  return list.length <= max
    ? list.join(", ")
    : `${list.slice(0, max).join(", ")} … (+${list.length - max})`;
}

interface RecordMonitorProps {
  status: RecordingStatus;
  /** 实时 Universe 快照，用于活动块 */
  snapshots: UniverseSnapshot[];
  /** 按预设规划出的 Universe（待机时即“将录制什么”） */
  plan: UniversePlan;
}

/**
 * 实时监看：待机时预览按预设将录制的 Universe 及其实时活动，
 * 录制中显示已录 Universe 的活动与录制时间线。超范围 / 超容量 / 被忽略的 Universe 用告警条写明。
 */
export function RecordMonitor({ status, snapshots, plan }: RecordMonitorProps) {
  const { t } = useTranslation();
  const recording = status.recording;
  const shown = recording ? status.universes : plan.accepted;

  return (
    <SurfacePanel
      title={recording ? t("recording.activityTitle") : t("recording.monitorTitle")}
      actions={
        recording ? (
          <Badge variant="secondary" className="num">
            {t("recording.libUniverses", { n: status.universes.length })}
          </Badge>
        ) : (
          <Badge variant={plan.accepted.length > 0 ? "default" : "warning"}>
            {plan.accepted.length > 0
              ? t("recording.previewCount", { n: plan.accepted.length })
              : t("recording.previewNone")}
          </Badge>
        )
      }
    >
      <div className="grid gap-4">
        {shown.length > 0 ? (
          <UniverseActivity universes={shown} snapshots={snapshots} />
        ) : (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {t("recording.monitorEmpty")}
          </p>
        )}

        <div className="empty:hidden">
          <RecordTimeline />
        </div>

        {!recording && plan.rejectedOutOfRange.length > 0 && (
          <InlineAlert>
            {t("recording.rejectedOutOfRange", {
              list: summarize(plan.rejectedOutOfRange),
              max: MAX_UNIVERSE,
            })}
          </InlineAlert>
        )}
        {!recording && plan.rejectedOverCapacity.length > 0 && (
          <InlineAlert>
            {t("recording.rejectedOverCapacity", {
              list: summarize(plan.rejectedOverCapacity),
              max: MAX_UNIVERSES_PER_FILE,
            })}
          </InlineAlert>
        )}
        {recording && status.stats.ignoredUniverses > 0 && (
          <InlineAlert>{t("recording.ignoredWarn", { n: status.stats.ignoredUniverses })}</InlineAlert>
        )}
        {!recording && (
          <p className="text-xs text-muted-foreground">{t("recording.fixedSetNote")}</p>
        )}
      </div>
    </SurfacePanel>
  );
}

interface UniverseActivityProps {
  universes: number[];
  snapshots: UniverseSnapshot[];
}

/**
 * Universe 活动块：每路一个小块，条的长度按“有输出的通道数 / 512”缩放（只用 transform）。
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
                className="h-full origin-left rounded-full bg-success transition-transform duration-200 motion-reduce:transition-none"
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
