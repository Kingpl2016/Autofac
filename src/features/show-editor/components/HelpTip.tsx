import { useTranslation } from "react-i18next";
import { CircleHelp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface HelpTipProps {
  /**
   * 说明文案的 i18n 前缀，例如 `editor.help.programmer.fan`。其下的键：
   * `title`（标题）、`short`（悬停时的一句话）、`body`（说明卡正文，换行分段，`• ` 开头的行是步骤）、
   * `keys`（可选：快捷键）、`term`（可选：对应的 grandMA3 术语）。
   */
  topic: string;
  /** 说明卡的对齐方式 */
  align?: "start" | "center" | "end";
  className?: string;
}

/**
 * “?”说明：悬停显示一句话，点击弹出说明卡（作用、操作步骤、快捷键、对应的调光台术语）。
 *
 * 一句话同时写进按钮的 `aria-description`，读屏软件不必打开说明卡也能听到。
 */
export function HelpTip({ topic, align = "end", className }: HelpTipProps) {
  const { t, i18n } = useTranslation();
  const title = t(`${topic}.title`);
  const short = t(`${topic}.short`);
  const lines = t(`${topic}.body`).split("\n").filter((l) => l.trim() !== "");
  const keys = i18n.exists(`${topic}.keys`) ? t(`${topic}.keys`) : null;
  const term = i18n.exists(`${topic}.term`) ? t(`${topic}.term`) : null;
  const label = t("editor.help.open", { name: title });

  return (
    <Popover>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn("size-6 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-3.5", className)}
                aria-label={label}
                aria-description={short}
              >
                <CircleHelp aria-hidden />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-64">
            {short}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent align={align} className="grid w-80 gap-2 text-xs" aria-label={title}>
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="grid gap-1.5">
          {lines.map((line, i) =>
            line.startsWith("• ") ? (
              <p key={i} className="flex gap-1.5 text-muted-foreground">
                <span aria-hidden className="text-foreground/70">
                  •
                </span>
                <span>{line.slice(2)}</span>
              </p>
            ) : (
              <p key={i}>{line}</p>
            ),
          )}
        </div>
        {(keys || term) && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t border-border pt-2 text-muted-foreground">
            {keys && (
              <>
                <dt>{t("editor.help.keys")}</dt>
                <dd className="num text-foreground">{keys}</dd>
              </>
            )}
            {term && (
              <>
                <dt>{t("editor.help.term")}</dt>
                <dd className="text-foreground">{term}</dd>
              </>
            )}
          </dl>
        )}
      </PopoverContent>
    </Popover>
  );
}
