import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Copy, EyeOff, Tag, Trash2, TrendingUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { announce } from "@/shared/stores/announcerStore";
import type { Command } from "../lib/commands";
import { setCueTag, setSymmetricFades } from "../lib/editOps";
import { CUE_TAG_COLORS, CUE_TAGS, type CueTag } from "../lib/project";
import { useProjectStore } from "../stores/useProjectStore";

/** 淡入淡出预设（毫秒，淡入与淡出相同）。 */
const FADE_PRESETS = [0, 250, 500, 1000, 2000] as const;

interface ClipQuickBarProps {
  commands: readonly Command[];
  /** 作用的片段（当前选择） */
  ids: readonly string[];
  /** 锚定片段所在轨道已锁定：按钮不可用 */
  locked: boolean;
  /** 位置（时间线内容坐标） */
  left: number;
  top: number;
}

/**
 * 选中片段上方的浮动快捷条：淡入淡出预设、颜色标签、复制一份、禁用 / 启用、删除。
 * 复制、禁用与删除直接执行编辑器命令（与快捷键、右键菜单的行为一致，例如波纹编辑开着时删除会合拢）。
 */
export function ClipQuickBar({ commands, ids, locked, left, top }: ClipQuickBarProps) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const run = (id: string) => commands.find((c) => c.id === id)?.run();

  const setFades = (ms: number) => {
    update((d) => void setSymmetricFades(d, ids, ms));
    announce(t("editor.quickBar.fadesSet", { seconds: ms / 1000 }));
  };
  const setTag = (tag: CueTag | null) => update((d) => void setCueTag(d, ids, tag));

  const iconButton = "size-6";

  return (
    <div
      role="toolbar"
      aria-label={t("editor.quickBar.label")}
      data-testid="clip-quick-bar"
      className="absolute z-30 flex items-center gap-0.5 rounded-md border border-border bg-popover/95 p-0.5 text-popover-foreground shadow-md backdrop-blur-sm"
      style={{ left, top }}
      // 快捷条上的操作不触发轨道区的框选 / 新建
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className={iconButton} disabled={locked} aria-label={t("editor.quickBar.fades")} title={t("editor.quickBar.fades")}>
            <TrendingUpDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" aria-label={t("editor.quickBar.fades")}>
          <DropdownMenuLabel>{t("editor.quickBar.fades")}</DropdownMenuLabel>
          {FADE_PRESETS.map((ms) => (
            <DropdownMenuItem key={ms} onSelect={() => setFades(ms)}>
              {ms === 0 ? t("editor.quickBar.noFade") : t("editor.quickBar.fadeSeconds", { seconds: ms / 1000 })}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className={iconButton} disabled={locked} aria-label={t("editor.context.tag")} title={t("editor.context.tag")}>
            <Tag aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" aria-label={t("editor.context.tag")}>
          {CUE_TAGS.map((tag) => (
            <DropdownMenuItem key={tag} onSelect={() => setTag(tag)}>
              <span
                aria-hidden
                className="size-3 rounded-full bg-(--tag)"
                style={{ "--tag": `rgb(${CUE_TAG_COLORS[tag].join(" ")})` } as CSSProperties}
              />
              {t(`editor.tags.${tag}`)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setTag(null)}>{t("editor.context.clearTag")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      <Button type="button" variant="ghost" size="icon" className={iconButton} disabled={locked} aria-label={t("editor.commands.duplicate")} title={t("editor.commands.duplicate")} onClick={() => run("edit.duplicate")}>
        <Copy aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon" className={iconButton} disabled={locked} aria-label={t("editor.quickBar.toggleDisabled")} title={t("editor.quickBar.toggleDisabled")} onClick={() => run("edit.toggleDisabled")}>
        <EyeOff aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={`${iconButton} text-muted-foreground hover:text-destructive`}
        disabled={locked}
        aria-label={t("editor.commands.delete")}
        title={t("editor.commands.delete")}
        onClick={() => run("edit.delete")}
      >
        <Trash2 aria-hidden />
      </Button>
    </div>
  );
}
