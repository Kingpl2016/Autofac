import { useTranslation } from "react-i18next";
import { Network, ShieldCheck, Circle, Server, Film } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModeSwitch } from "@/features/app-mode";
import { HeaderRecordButton } from "@/features/recording";
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
    playing,
    appMode,
  } = useEngineStatusStore();
  const playerMode = appMode === "player";

  return (
    <TooltipProvider delayDuration={200}>
    <header
      // 播放器模式：底边换成强调色 + 极淡底色，任何页面都能一眼看出当前模式（只改颜色，不引起布局位移）
      className={cn(
        "flex h-14 shrink-0 items-center justify-between border-b bg-card px-6",
        playerMode ? "border-b-2 border-primary/60 bg-primary/5" : "border-border",
      )}
    >
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
        {playing && (
          <Badge variant="success">
            <Film className="size-3" aria-hidden />
            {t("header.playback")}
          </Badge>
        )}
        <ModeSwitch />
        <HeaderRecordButton />
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
    </TooltipProvider>
  );
}
