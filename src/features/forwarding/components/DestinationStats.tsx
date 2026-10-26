import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { OutputPayload } from "@/shared/domain/engine";
import { formatCount, formatDuration, formatPacketRate } from "@/shared/lib/format";
import { ageNow, isOutputStale } from "@/shared/lib/outputFreshness";
import type { ForwardDestination } from "../lib/types";

interface DestinationStatsProps {
  dest: ForwardDestination;
  /** 最近一次输出统计；`null` 表示还没收到。 */
  output: OutputPayload | null;
  /** 收到该统计的时间戳。 */
  receivedAt: number | null;
  /** 当前时间戳。 */
  now: number;
}

/**
 * 目的地的运行时统计行：已发送 / 丢帧 / 错误 / 最近发送。
 *
 * 已停用的目的地显示“已停用”，启用但还没有任何发送记录的显示“尚未发送数据”，
 * 都不会显示成 0，避免把“没有数据”误读成“发了 0 个包”。
 */
export function DestinationStats({ dest, output, receivedAt, now }: DestinationStatsProps) {
  const { t } = useTranslation();
  const muted = "mt-1 text-xs text-muted-foreground";

  if (!dest.enabled) return <p className={muted}>{t("forwarding.stats.disabled")}</p>;
  if (!output) return <p className={muted}>{t("forwarding.stats.waiting")}</p>;
  const s = output.destinations.find((d) => d.id === dest.id);
  if (!s) return <p className={muted}>{t("forwarding.stats.noTraffic")}</p>;

  const stale = isOutputStale(receivedAt, now);
  const last = ageNow(s.lastSendAgoMs, receivedAt, now);
  const rate = s.sentRate > 0 ? ` · ${formatPacketRate(s.sentRate).value} pps` : "";

  return (
    <dl className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
      <Item label={t("forwarding.stats.sent")} value={`${formatCount(s.sent)}${rate}`} />
      <Item label={t("forwarding.stats.dropped")} value={formatCount(s.dropped)} />
      <Item label={t("forwarding.stats.errors")} value={formatCount(s.errors)} alert={s.errors > 0} />
      <Item
        label={t("forwarding.stats.lastSend")}
        value={last === null ? "—" : t("forwarding.stats.ago", { time: formatDuration(last) })}
      />
      {stale && <span className="text-warning">{t("forwarding.stats.stale")}</span>}
    </dl>
  );
}

function Item({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular font-medium", alert && "text-destructive")}>{value}</dd>
    </div>
  );
}