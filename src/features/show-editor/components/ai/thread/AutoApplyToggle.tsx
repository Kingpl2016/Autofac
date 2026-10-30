import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAiPrefsStore } from "@/features/ai";
import { cn } from "@/lib/utils";

/**
 * 输入框底部、发送按钮旁的“自动写入”开关（与设置页的开关是同一个偏好）。
 * 打开时 AI 的改动直接写入工程并提示撤销；配接、输出与大批量删除仍然先让用户确认。
 */
export const AutoApplyToggle: FC = () => {
  const { t } = useTranslation();
  const on = useAiPrefsStore((s) => s.autoApply);
  const setOn = useAiPrefsStore((s) => s.setAutoApply);
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={on}
            aria-label={t("editor.ai.autoApply")}
            onClick={() => setOn(!on)}
            className={cn(
              "h-7 gap-1 px-1.5 text-xs font-normal [&_svg]:size-3.5",
              on ? "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary" : "text-muted-foreground",
            )}
          >
            <Zap className={cn(on && "fill-current")} aria-hidden />
            {on && <span>{t("editor.ai.autoApplyOn")}</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-60">
          {t(on ? "editor.ai.autoApplyHintOn" : "editor.ai.autoApplyHintOff")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
