import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { UniverseSnapshot } from "@/shared/domain/engine";
import { conflictLevel, type MergeModeName } from "@/shared/lib/conflict";
import { formatCount, formatPacketRate } from "@/shared/lib/format";
import { sourcesOf } from "../lib/universeView";
import { ConflictBadge } from "@/shared/components/ConflictBadge";

interface UniverseTableProps {
  universes: readonly UniverseSnapshot[];
  mergeMode: MergeModeName;
  /** 是否显示协议列。 */
  showProtocol: boolean;
}

/**
 * 活动宇宙表格：适合宇宙很多时一屏看全；列含逐周期稳定的包速率与累计包数。
 */
export function UniverseTable({ universes, mergeMode, showProtocol }: UniverseTableProps) {
  const { t } = useTranslation();
  // Tailwind 需要完整的静态类名
  const cols = showProtocol
    ? "grid-cols-[4rem_1fr_6rem_6rem_5rem_auto]"
    : "grid-cols-[4rem_1fr_6rem_6rem_5rem]";

  return (
    <div role="table" aria-label={t("dashboard.activeUniverseList")}>
      <div
        role="row"
        className={`grid ${cols} gap-x-3 border-b border-border pb-2 text-xs font-medium text-muted-foreground`}
      >
        <span role="columnheader">Universe</span>
        <span role="columnheader">{t("dashboard.sourceIp")}</span>
        <span role="columnheader" className="text-right">
          {t("dashboard.packetRate")}
        </span>
        <span role="columnheader" className="text-right">
          {t("dashboard.totalPackets")}
        </span>
        <span role="columnheader" className="text-right">
          {t("dashboard.activeChannels")}
        </span>
        {showProtocol && (
          <span role="columnheader" className="text-right">
            {t("dashboard.protocol")}
          </span>
        )}
      </div>
      <div role="rowgroup" className="divide-y divide-border">
        {universes.map((u) => (
          <div key={u.universe} role="row" className={`grid ${cols} items-center gap-x-3 py-3 text-sm`}>
            <span role="cell" className="tabular font-medium">
              {u.universe}
            </span>
            <span role="cell" className="truncate text-muted-foreground">
              {sourcesOf(u)
                .map((s) => s.ip)
                .join(", ") || "—"}
              <span className="ml-2 inline-flex">
                <ConflictBadge
                  level={conflictLevel(mergeMode, u.conflictChannels)}
                  channels={u.conflictChannels}
                />
              </span>
            </span>
            <span role="cell" className="tabular text-right">
              {formatPacketRate(u.packetRate).value}{" "}
              <span className="text-xs text-muted-foreground">pps</span>
            </span>
            <span role="cell" className="tabular text-right text-muted-foreground">
              {formatCount(u.totalPackets)}
            </span>
            <span role="cell" className="tabular text-right">
              {u.activeChannels}
            </span>
            {showProtocol && (
              <span role="cell" className="text-right">
                <Badge variant={u.protocol === "sacn" ? "secondary" : "default"}>
                  {u.protocol === "sacn" ? "sACN" : "Art-Net"}
                </Badge>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}