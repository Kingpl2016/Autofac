import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { UniverseSnapshot } from "@/shared/domain/engine";
import { conflictLevel, type MergeModeName } from "@/shared/lib/conflict";
import { formatPacketRate } from "@/shared/lib/format";
import { portAddress, sourcesOf, CARD_SOURCE_LIMIT } from "../lib/universeView";
import { ConflictBadge } from "@/shared/components/ConflictBadge";

interface UniverseCardProps {
  universe: UniverseSnapshot;
  /** 当前合并模式，决定冲突徽标的级别与多源时的合并模式徽标。 */
  mergeMode: MergeModeName;
  /** 是否显示协议徽标（仅 Art-Net 时没有信息量，由调用方关闭）。 */
  showProtocol: boolean;
}

/**
 * 单个活动宇宙的卡片：编号、协议 / 合并 / 冲突徽标、包速率、活跃通道与逐源明细。
 */
export function UniverseCard({ universe: u, mergeMode, showProtocol }: UniverseCardProps) {
  const { t } = useTranslation();
  const rate = formatPacketRate(u.packetRate);
  const sources = sourcesOf(u);
  const shown = sources.slice(0, CARD_SOURCE_LIMIT);
  const more = sources.length - shown.length;
  const multi = u.sourceCount > 1;

  return (
    <li data-surface="" className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="tabular text-base font-semibold">
            {t("dashboard.universeN", { n: u.universe })}
          </div>
          {u.protocol === "artNet" && (
            <div className="tabular text-xs text-muted-foreground">{portAddress(u.universe)}</div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {showProtocol && (
            <Badge variant={u.protocol === "sacn" ? "secondary" : "default"}>
              {u.protocol === "sacn" ? "sACN" : "Art-Net"}
            </Badge>
          )}
          {multi && <Badge variant="outline">{t(`dashboard.merge.${mergeMode}`)}</Badge>}
          <ConflictBadge
            level={conflictLevel(mergeMode, u.conflictChannels)}
            channels={u.conflictChannels}
          />
        </div>
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="tabular text-sm font-medium">
          {rate.value} <span className="text-xs font-normal text-muted-foreground">{rate.unit}</span>
        </span>
        <span className="tabular text-xs text-muted-foreground">
          {t("dashboard.activeChannelsN", { count: u.activeChannels })}
        </span>
      </div>

      <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground" aria-label={t("dashboard.sourceIp")}>
        {shown.map((s) => (
          <li key={s.ip} className="flex justify-between gap-2">
            <span className="tabular truncate">{s.ip}</span>
            {multi && (
              <span className="tabular shrink-0">
                {formatPacketRate(s.packetRate).value} pps
              </span>
            )}
          </li>
        ))}
        {more > 0 && <li>{t("dashboard.sourcesMore", { count: more })}</li>}
        {sources.length === 0 && <li>—</li>}
      </ul>
    </li>
  );
}