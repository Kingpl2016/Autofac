import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SIGNAL_CHECKER_HOTKEY } from "../hooks/useSignalCheckerHotkey";
import { openSignalChecker } from "../lib/api";

/**
 * 顶栏的“信号检测器”入口：打开独立的检测器窗口（不是页面，所以是按钮而不是链接）。
 * 必须放在 `TooltipProvider` 内。
 */
export function SignalCheckerButton() {
  const { t } = useTranslation();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("nav.signalChecker")}
          aria-keyshortcuts="Control+Shift+T"
          onClick={() => void openSignalChecker()}
        >
          <Activity />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t("nav.signalCheckerHint", { key: SIGNAL_CHECKER_HOTKEY })}
      </TooltipContent>
    </Tooltip>
  );
}
