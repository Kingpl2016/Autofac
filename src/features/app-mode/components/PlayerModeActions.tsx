import { useTranslation } from "react-i18next";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusPill, type StatusTone } from "@/shared/components/StatusPill";
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
 * 播放器模式的操作组：输出健康状态（就绪 / 重连中 / 不可用）+ “退出播放器模式”。
 *
 * 放在播放器页页头（标题与副标题）的右侧，是播放器页上唯一的退出入口。传输台上的“关闭节目”
 * 只卸载节目、不退出模式，两者动作不同、名字也不同。
 */
export function PlayerModeActions() {
  const { t } = useTranslation();
  const sender = useEngineStatusStore((s) => s.sender);
  const transitioning = useAppModeStore((s) => s.transitioning);
  const { requestMode } = useModeActions();

  return (
    <div className="flex items-center gap-2">
      <StatusPill tone={SENDER_TONE[sender]}>{t(`mode.sender.${sender}`)}</StatusPill>
      <Button variant="outline" size="sm" disabled={transitioning} onClick={() => requestMode("live")}>
        <LogOut aria-hidden />
        {t("mode.exit")}
      </Button>
    </div>
  );
}
