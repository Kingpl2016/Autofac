import { useTranslation } from "react-i18next";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusPill, type StatusTone } from "@/shared/components/StatusPill";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { useEngineStatusStore, type SenderName } from "@/shared/stores/engineStatusStore";
import { useModeActions } from "../hooks/useModeActions";
import { useAppModeStore } from "../stores/useAppModeStore";

/** 发送器状态 → 状态胶囊色调（文字始终同时显示，不单靠颜色）。 */
const SENDER_TONE: Record<SenderName, StatusTone> = {
  ready: "ready",
  reconnecting: "warning",
  down: "error",
};

/**
 * 播放器模式横幅：常驻、不可关闭的一行，说明当前处在播放器模式。
 *
 * 右侧是输出健康状态（就绪 / 重连中 / 不可用）和**唯一**的“退出播放器模式”入口；
 * 传输台上的按钮叫“关闭节目”，两者动作不同、名字也不同，避免混淆。
 */
export function PlayerModeBanner() {
  const { t } = useTranslation();
  const sender = useEngineStatusStore((s) => s.sender);
  const transitioning = useAppModeStore((s) => s.transitioning);
  const { requestMode } = useModeActions();

  return (
    <SurfacePanel tone="player" className="py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <StatusPill tone="player">{t("mode.bannerTitle")}</StatusPill>
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t("mode.bannerDesc")}</p>
        <StatusPill tone={SENDER_TONE[sender]}>{t(`mode.sender.${sender}`)}</StatusPill>
        <Button
          variant="outline"
          size="sm"
          disabled={transitioning}
          onClick={() => requestMode("live")}
        >
          <LogOut aria-hidden />
          {t("mode.exit")}
        </Button>
      </div>
    </SurfacePanel>
  );
}
