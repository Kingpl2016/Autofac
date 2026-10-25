import { useTranslation } from "react-i18next";
import { Network, ShieldCheck, Circle, Server, Film } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { ThemeToggle } from "./ThemeToggle";
import { PersonalizationPanel } from "./PersonalizationPanel";

/**
 * 顶部状态条：网络接口、连接状态、集群角色、Guardian、录制指示与主题 / 个性化入口。
 * 侧栏折叠把手位于侧栏右边缘（见 `Sidebar`）。
 */
export function HeaderBar() {
  const { t } = useTranslation();
  const {
    interfaceLabel,
    connected,
    clusterRole,
    guardianEnabled,
    recording,
    playback,
  } = useEngineStatusStore();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-6">
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
          <Circle
            className={cn("size-2 fill-current", connected && "animate-pulse")}
            aria-hidden
          />
          {connected ? t("header.connected") : t("header.disconnected")}
        </span>
      </div>

      <div className="flex items-center gap-3">
        {playback && (
          <Badge variant="warning">
            <Film className="size-3" aria-hidden />
            {t("header.playback")}
          </Badge>
        )}
        {recording && (
          <Badge variant="destructive">
            <Circle className="size-2 animate-pulse fill-current" aria-hidden />
            {t("header.recording")}
          </Badge>
        )}
        {clusterRole !== "none" && (
          <Badge variant={clusterRole === "primary" ? "success" : "secondary"}>
            <Server className="size-3" aria-hidden />
            {clusterRole.toUpperCase()}
          </Badge>
        )}
        {guardianEnabled && (
          <Badge variant="warning">
            <ShieldCheck className="size-3" aria-hidden />
            {t("header.guardian")}
          </Badge>
        )}
        <ThemeToggle />
        <PersonalizationPanel />
      </div>
    </header>
  );
}
