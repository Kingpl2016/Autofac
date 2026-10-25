import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Film, LogOut, CirclePause } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useModeActions } from "../hooks/useModeActions";
import { useAppModeStore } from "../stores/useAppModeStore";

interface ModeGuardNoticeProps {
  /** 说明为什么此处不可用；省略则用通用文案 */
  description?: string;
}

/**
 * 播放器模式下，依赖实时信号的页面（Universe 视图、设备发现、录制）显示的说明面板。
 *
 * 不是把入口藏起来，而是解释原因并给出出路：主按钮“退出播放器模式”，次要入口“前往播放器”。
 */
export function ModeGuardNotice({ description }: ModeGuardNoticeProps) {
  const { t } = useTranslation();
  const transitioning = useAppModeStore((s) => s.transitioning);
  const { requestMode } = useModeActions();

  return (
    <div className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-surface-1 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary">
        <CirclePause className="size-7" aria-hidden />
      </span>
      <div className="grid max-w-md gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{t("mode.guardTitle")}</h2>
        <p className="text-sm text-muted-foreground">{description ?? t("mode.guardDesc")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button disabled={transitioning} onClick={() => requestMode("live")}>
          <LogOut aria-hidden />
          {t("mode.exit")}
        </Button>
        <Button variant="outline" asChild>
          <Link to="/player">
            <Film aria-hidden />
            {t("mode.goPlayer")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
