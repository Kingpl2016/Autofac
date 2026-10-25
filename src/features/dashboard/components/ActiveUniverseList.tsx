import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useProtocolFlags } from "@/features/settings";

/**
 * 活跃 Universe 列表：协议、源 IP、包数、活跃通道、合并冲突徽章。
 */
export function ActiveUniverseList() {
  const { t } = useTranslation();
  const universes = useEngineDataStore((s) => s.universes);
  const { sacnEnabled } = useProtocolFlags();
  // 只有 Art-Net 时协议列没有信息量，整列隐藏（Tailwind 需要完整的静态类名）
  const headCols = sacnEnabled
    ? "grid-cols-[4rem_1fr_6rem_5rem_auto]"
    : "grid-cols-[4rem_1fr_6rem_5rem]";

  return (
    <Card>
      <CardHeader className="p-5 pb-3">
        <CardTitle className="text-base">
          {t("dashboard.activeUniverseList")}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className={`grid ${headCols} gap-x-3 border-b border-border pb-2 text-xs font-medium text-muted-foreground`}>
          <span>Universe</span>
          <span>{t("dashboard.sourceIp")}</span>
          <span className="text-right">{t("dashboard.packetRate")}</span>
          <span className="text-right">{t("dashboard.activeChannels")}</span>
          {sacnEnabled && <span className="text-right">{t("dashboard.protocol")}</span>}
        </div>
        {universes.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t("dashboard.noActiveUniverses")}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {universes.map((u) => (
              <div
                key={u.universe}
                className={`grid ${headCols} items-center gap-x-4 py-3 text-sm`}
              >
                <span className="tabular font-medium">{u.universe}</span>
                <span className="truncate text-muted-foreground">
                  {u.sourceIps.join(", ") || "—"}
                  {u.conflictChannels > 0 && (
                    <Badge variant="warning" className="ml-2">
                      <AlertTriangle className="size-3" aria-hidden />
                      {u.conflictChannels} {t("universes.mergeConflictChannels")}
                    </Badge>
                  )}
                </span>
                <span className="tabular text-right">{u.totalPackets}</span>
                <span className="tabular text-right">{u.activeChannels}</span>
                {sacnEnabled && (
                  <span className="text-right">
                    <Badge variant={u.protocol === "sacn" ? "secondary" : "default"}>
                      {u.protocol === "sacn" ? "sACN" : "Art-Net"}
                    </Badge>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
