import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";

import { formatBytes, formatDurationUs } from "../lib/filter";
import type { RecordingResult, RecordingStatus } from "../lib/types";

interface RecordStatsProps {
  /** 实时状态 */
  status: RecordingStatus;
  /** 是否正在录制 */
  active: boolean;
  /** 最近一次录制结果 */
  last: RecordingResult | null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}

/**
 * 录制统计：时长、帧数、文件大小、丢帧与被忽略的 Universe；结束后显示上次结果摘要。
 */
export function RecordStats({ status, active, last }: RecordStatsProps) {
  const { t } = useTranslation();

  if (!active && last) {
    const frames = last.files.reduce((n, f) => n + f.frames, 0);
    const bytes = last.files.reduce((n, f) => n + f.bytes, 0);
    const duration = last.files.reduce((n, f) => n + f.durationUs, 0);
    return (
      <div className="grid gap-3">
        <h3 className="text-sm font-medium">{t("recording.lastResult")}</h3>
        <dl className="grid grid-cols-2 gap-2">
          <Stat label={t("recording.statDuration")} value={formatDurationUs(duration)} />
          <Stat label={t("recording.statFrames")} value={String(frames)} />
          <Stat label={t("recording.statSize")} value={formatBytes(bytes)} />
          <Stat label={t("recording.statFiles")} value={String(last.files.length)} />
        </dl>
        <ul className="grid gap-1 text-xs text-muted-foreground">
          {last.files.map((f) => (
            <li key={f.path} className="break-all" title={f.path}>
              {f.path}
            </li>
          ))}
        </ul>
        {last.dropped > 0 && (
          <p className="flex items-start gap-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("recording.droppedWarn", { n: last.dropped })}
          </p>
        )}
      </div>
    );
  }

  if (!active) {
    return <p className="text-sm text-muted-foreground">{t("recording.idleHint")}</p>;
  }

  const s = status.stats;
  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-2 gap-2">
        <Stat label={t("recording.statDuration")} value={formatDurationUs(status.elapsedUs)} />
        <Stat label={t("recording.statFrames")} value={String(s.frames)} />
        <Stat label={t("recording.statSize")} value={formatBytes(s.bytes)} />
        <Stat label={t("recording.statPart")} value={String(status.part)} />
        <Stat label={t("recording.statUniverses")} value={String(status.universes.length)} />
        <Stat label={t("recording.statFiltered")} value={String(s.filteredPackets)} />
      </dl>
      <p className="break-all text-xs text-muted-foreground" title={status.path}>
        {status.path}
      </p>
      {s.ignoredUniverses > 0 && (
        <p className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("recording.ignoredWarn", { n: s.ignoredUniverses })}
        </p>
      )}
      {status.dropped > 0 && (
        <p className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("recording.droppedWarn", { n: status.dropped })}
        </p>
      )}
    </div>
  );
}
