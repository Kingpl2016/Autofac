import { Circle, Network } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { UptimeBadge } from "./UptimeBadge";

/** 顶栏左侧的引擎状态：网络接口、连接状态与运行时长。 */
export function EngineStatus() {
  const { t } = useTranslation();
  const interfaceLabel = useEngineStatusStore((s) => s.interfaceLabel);
  const connected = useEngineStatusStore((s) => s.connected);

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Network className="size-4" aria-hidden />
        <span className="tabular">{interfaceLabel}</span>
      </div>
      <span
        className={cn(
          "flex items-center gap-2 text-sm",
          connected ? "text-success" : "text-muted-foreground",
        )}
      >
        <Circle className={cn("size-2 fill-current", connected && "animate-pulse")} aria-hidden />
        {connected ? t("header.connected") : t("header.disconnected")}
      </span>
      <UptimeBadge />
    </div>
  );
}
