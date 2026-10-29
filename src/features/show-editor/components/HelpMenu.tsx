import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInRouterContext, useLocation, useNavigate } from "react-router-dom";
import {
  CircleHelp,
  ClipboardCopy,
  FolderOpen,
  Info,
  Keyboard,
  Lightbulb,
  LightbulbOff,
  MessageSquareWarning,
  PlayCircle,
  RotateCcw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { useWindowKeydown } from "@/shared/hooks/useWindowKeydown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildDiagnostics, getAppInfo, revealLogs } from "@/features/about";
import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { RELEASE_NOTES } from "../lib/releaseNotes";
import { runTour } from "../onboarding/runTour";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useOnboardingStore } from "../stores/useOnboardingStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 菜单关闭的动画结束后再开始导览，避免导览落在菜单下面。 */
const AFTER_CLOSE_MS = 150;

/**
 * 复制诊断信息：应用版本与运行环境（关于页同款），在编辑页再附上当前节目的规模，方便反馈问题时附上。
 *
 * @param withShow 是否附上当前节目的规模（只在编辑页）。
 */
async function copyDiagnostics(withShow: boolean): Promise<void> {
  const t = i18n.t.bind(i18n);
  try {
    const info = await getAppInfo();
    const lines = [buildDiagnostics(info)];
    if (withShow) {
      const p = useProjectStore.getState().project;
      lines.push(
        t("editor.help.diagShow", {
          fixtures: p.fixtures.length,
          tracks: p.tracks.length,
          cues: p.cues.length,
          universes: p.output.universes.length,
        }),
      );
    }
    lines.push(navigator.userAgent);
    await navigator.clipboard.writeText(lines.join("\n"));
    toast.success(t("editor.help.diagCopied"));
    announce(t("editor.help.diagCopied"));
  } catch {
    toast.error(t("editor.help.diagFailed"));
  }
}

/** 打开日志文件夹。 */
async function openLogs(): Promise<void> {
  try {
    await revealLogs();
  } catch {
    toast.error(i18n.t("editor.help.logsFailed"));
  }
}

/** 当前路径是否是节目编辑页。 */
function isEditorPath(pathname: string): boolean {
  return pathname === "/editor" || pathname.startsWith("/editor/");
}

/**
 * 顶栏里的帮助菜单：按当前页面决定是否显示编辑器专属的菜单项。
 * 编辑页的 F1 由编辑器命令表处理（可在快捷键设置里改）；其他页面在这里监听 F1。
 */
export function HeaderHelpMenu() {
  const { pathname } = useLocation();
  const editor = isEditorPath(pathname);
  const setOpen = useEditorUiStore((s) => s.setHelpOpen);

  useWindowKeydown(
    (e) => {
      if (e.key !== "F1" || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      setOpen(true);
    },
    { enabled: !editor },
  );

  // 离开编辑页时关掉菜单，避免带着编辑器的菜单项停在别的页面
  useEffect(() => () => setOpen(false), [editor, setOpen]);

  return <HelpMenu editor={editor} />;
}

/**
 * 帮助菜单（“?” 按钮，F1 打开）。所有页面都有：新功能、关于、问题反馈（复制诊断信息、打开日志文件夹）；
 * 编辑页另有：播放上手引导、显示 / 隐藏本页的全部局部提示、快捷键速查与自定义、重置引导与提示。
 *
 * @param props.editor 是否显示编辑器专属的菜单项（默认显示）。
 */
export function HelpMenu({ editor = true }: { editor?: boolean }) {
  const { t } = useTranslation();
  const open = useEditorUiStore((s) => s.helpOpen);
  const setOpen = useEditorUiStore((s) => s.setHelpOpen);
  const showAll = useEditorUiStore((s) => s.hintsShowAll);
  const setShowAll = useEditorUiStore((s) => s.setHintsShowAll);
  const inRouter = useInRouterContext();
  const [whatsNew, setWhatsNew] = useState(false);

  return (
    <>
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
          {editor && (
            <>
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
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => useEditorUiStore.getState().setShortcutSheetOpen(true)}>
                <Keyboard aria-hidden />
                {t("editor.help.cheatSheet")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => useEditorUiStore.getState().setKeymapOpen(true)}>
                <Settings2 aria-hidden />
                {t("editor.guide.shortcuts")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem onSelect={() => setWhatsNew(true)}>
            <Sparkles aria-hidden />
            {t("editor.help.whatsNew")}
          </DropdownMenuItem>
          {inRouter && <AboutItem />}
          <DropdownMenuSeparator />
          <DropdownMenuGroup aria-labelledby="help-feedback-label">
            <DropdownMenuLabel id="help-feedback-label" className="flex items-center gap-1.5">
              <MessageSquareWarning aria-hidden className="size-3.5" />
              {t("editor.help.feedback")}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => void copyDiagnostics(editor)}>
              <ClipboardCopy aria-hidden />
              {t("editor.help.copyDiagnostics")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openLogs()}>
              <FolderOpen aria-hidden />
              {t("editor.help.openLogs")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {editor && (
            <>
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
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <WhatsNewDialog open={whatsNew} onOpenChange={setWhatsNew} />
    </>
  );
}

/** “关于”：跳到关于页（只在路由里渲染）。 */
function AboutItem() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <DropdownMenuItem onSelect={() => navigate("/about")}>
      <Info aria-hidden />
      {t("editor.help.about")}
    </DropdownMenuItem>
  );
}

/** “新功能”：本版本的更新说明。 */
function WhatsNewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-3 overflow-hidden p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles aria-hidden className="size-4 text-primary" />
            {t("editor.whatsNew.title")}
          </DialogTitle>
          <DialogDescription>{t("editor.whatsNew.description")}</DialogDescription>
        </DialogHeader>
        <ul className="grid min-h-0 gap-3 overflow-auto pr-1">
          {RELEASE_NOTES.map((n) => (
            <li key={n.id} className="grid gap-0.5">
              <span className="flex items-center gap-2 text-sm font-medium">
                {t(`editor.whatsNew.items.${n.id}.title`)}
                <Badge variant="outline" className="text-[10px]">
                  {t(`editor.whatsNew.areas.${n.area}`)}
                </Badge>
              </span>
              <span className="text-xs text-muted-foreground">{t(`editor.whatsNew.items.${n.id}.body`)}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
