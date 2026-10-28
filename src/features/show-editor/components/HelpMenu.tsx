import { useTranslation } from "react-i18next";
import { CircleHelp, Keyboard, Lightbulb, LightbulbOff, PlayCircle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { announce } from "@/shared/stores/announcerStore";
import { runTour } from "../onboarding/runTour";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useOnboardingStore } from "../stores/useOnboardingStore";

/** 菜单关闭的动画结束后再开始导览，避免导览落在菜单下面。 */
const AFTER_CLOSE_MS = 150;

/**
 * 工具条右侧的帮助菜单（“?” 按钮，F1 打开）：播放上手引导、显示 / 隐藏本页的全部局部提示、
 * 快捷键一览、重置引导与提示。
 */
export function HelpMenu() {
  const { t } = useTranslation();
  const open = useEditorUiStore((s) => s.helpOpen);
  const setOpen = useEditorUiStore((s) => s.setHelpOpen);
  const showAll = useEditorUiStore((s) => s.hintsShowAll);
  const setShowAll = useEditorUiStore((s) => s.setHintsShowAll);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          data-tour="help"
          aria-label={t("editor.guide.help")}
          aria-keyshortcuts="F1"
          title={`${t("editor.guide.help")} (F1)`}
        >
          <CircleHelp aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" aria-label={t("editor.guide.help")}>
        <DropdownMenuItem onSelect={() => void window.setTimeout(() => void runTour(t), AFTER_CLOSE_MS)}>
          <PlayCircle aria-hidden />
          {t("editor.guide.replay")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            setShowAll(!showAll);
            announce(t(showAll ? "editor.guide.hintsHidden" : "editor.guide.hintsShown"));
          }}
        >
          {showAll ? <LightbulbOff aria-hidden /> : <Lightbulb aria-hidden />}
          {t(showAll ? "editor.guide.hideHints" : "editor.guide.showHints")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => useEditorUiStore.getState().setKeymapOpen(true)}>
          <Keyboard aria-hidden />
          {t("editor.guide.shortcuts")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            useOnboardingStore.getState().reset();
            setShowAll(false);
            announce(t("editor.guide.resetDone"));
          }}
        >
          <RotateCcw aria-hidden />
          {t("editor.guide.reset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
