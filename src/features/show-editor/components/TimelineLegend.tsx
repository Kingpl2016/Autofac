import { useTranslation } from "react-i18next";
import { CircleHelp, Palette } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CLIP_CATEGORIES, CLIP_CATEGORY_ACCENT, CLIP_CATEGORY_ICONS, CLIP_CATEGORY_TEXT } from "../timeline/clipCategoryStyle";

/**
 * 时间线图例：片段类别（顶部色条 + 左上角图标）、中性斜纹、关键帧 ◆、底部实际输出色带、右上角属性徽标的含义。
 */
export function TimelineLegend() {
  const { t } = useTranslation();
  const row = "flex items-start gap-2 text-xs";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={t("editor.legend.open")}
          title={t("editor.legend.open")}
        >
          <CircleHelp aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-80 gap-3" aria-label={t("editor.legend.title")}>
        <h3 className="text-sm font-medium">{t("editor.legend.title")}</h3>
        <ul aria-label={t("editor.legend.kinds")} className="grid gap-2">
          {CLIP_CATEGORIES.map((c) => {
            const Icon = CLIP_CATEGORY_ICONS[c];
            return (
              <li key={c} className={row}>
                <span aria-hidden className="relative mt-0.5 flex h-4 w-7 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-surface-1">
                  <span className={cn("absolute inset-x-0 top-0 h-0.5", CLIP_CATEGORY_ACCENT[c])} />
                  <Icon className={cn("size-3", CLIP_CATEGORY_TEXT[c])} />
                </span>
                <span>
                  <span className="font-medium">{t(`editor.timeline.clipKinds.${c}`)}</span>
                  <span className="text-muted-foreground"> · {t(`editor.legend.kindHints.${c}`)}</span>
                </span>
              </li>
            );
          })}
        </ul>
        <ul aria-label={t("editor.legend.marks")} className="grid gap-2 border-t border-border pt-2">
          <li className={row}>
            <span aria-hidden className="hatch-neutral mt-0.5 h-4 w-7 shrink-0 rounded-sm border border-border" />
            <span className="text-muted-foreground">{t("editor.legend.neutral")}</span>
          </li>
          <li className={row}>
            <span aria-hidden className="mt-0.5 flex h-4 w-7 shrink-0 items-center justify-center">
              <span className="size-2 rotate-45 border border-background bg-keyframe" />
            </span>
            <span className="text-muted-foreground">{t("editor.legend.keyframe")}</span>
          </li>
          <li className={row}>
            <span aria-hidden className="mt-0.5 flex h-4 w-7 shrink-0 flex-col justify-end overflow-hidden rounded-sm border border-border">
              <span className="h-1.5 w-full bg-[linear-gradient(to_right,red,orange,yellow,lime)]" />
            </span>
            <span className="text-muted-foreground">{t("editor.legend.strip")}</span>
          </li>
          <li className={row}>
            <span aria-hidden className="mt-0.5 flex h-4 w-7 shrink-0 items-center justify-center">
              <Palette className="size-3 text-foreground/70" />
            </span>
            <span className="text-muted-foreground">{t("editor.legend.badges")}</span>
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}
