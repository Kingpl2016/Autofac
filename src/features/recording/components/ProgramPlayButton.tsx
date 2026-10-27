import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProgramActions } from "../hooks/useProgramActions";
import type { LibraryEntry } from "../lib/types";

interface ProgramPlayButtonProps {
  entry: LibraryEntry;
  actions: ProgramActions;
  /** 未打开节目时按钮的额外样式（如随行悬停高亮） */
  idleClassName?: string;
  /** 漫游 tabindex：表格里只让当前行可被 Tab 聚焦 */
  tabIndex?: number;
}

/**
 * 节目的主按钮：已打开的节目是暂停 / 继续（不重新打开、不回到开头），其余节目是“回放此节目”。
 * 损坏或还没导出的节目不能回放。
 */
export function ProgramPlayButton({ entry, actions, idleClassName, tabIndex }: ProgramPlayButtonProps) {
  const { t } = useTranslation();
  const isLoaded = entry.path === actions.loadedPath;
  const isPlaying = isLoaded && actions.loadedState === "playing";

  if (isLoaded) {
    return (
      <Button
        size="icon"
        variant={isPlaying ? "outline" : "default"}
        className="size-9 rounded-full"
        tabIndex={tabIndex}
        aria-label={`${isPlaying ? t("player.pause") : t("player.play")}: ${entry.name}`}
        title={isPlaying ? t("player.pause") : t("player.play")}
        disabled={actions.transitioning}
        onClick={(e) => {
          e.stopPropagation();
          void actions.toggleLoaded();
        }}
      >
        {isPlaying ? <Pause className="fill-current" /> : <Play className="fill-current" />}
      </Button>
    );
  }
  return (
    <Button
      size="icon"
      variant="ghost"
      className={cn("size-9 rounded-full text-muted-foreground", idleClassName)}
      tabIndex={tabIndex}
      aria-label={t("player.playProgram")}
      title={t("player.playProgram")}
      disabled={!entry.valid || actions.transitioning}
      onClick={(e) => {
        e.stopPropagation();
        actions.requestPlay(entry);
      }}
    >
      <Play className="fill-current" />
    </Button>
  );
}
