import { useTranslation } from "react-i18next";
import { Bot, Clapperboard, Command, Flag, Redo2, Undo2, WandSparkles } from "lucide-react";
import { useStore } from "zustand";

import { Button } from "@/components/ui/button";
import { addMarkerAtPlayhead } from "../hooks/editorActions";
import { togglePanel } from "../hooks/panelControl";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { selectDirty, useProjectStore } from "../stores/useProjectStore";
import type { ShowFileController } from "../hooks/useShowFile";
import { BakeStatus } from "./BakeStatus";
import { FileMenu } from "./FileMenu";
import { TempoPopover } from "./TempoPopover";
import { TransportBar } from "./TransportBar";

/** 工具条上的撤销 / 重做按钮需要的最少信息：历史是否非空。 */
const undoable = (s: { pastStates: unknown[] }) => s.pastStates.length > 0;
const redoable = (s: { futureStates: unknown[] }) => s.futureStates.length > 0;

/** 顶部工具条：工程名与未保存标记、文件操作（保存 / 文件菜单）、标记点与节拍、撤销 / 重做。 */
export function EditorToolbar({ file }: { file: ShowFileController }) {
  const { t } = useTranslation();
  const aiCollapsed = useEditorUiStore((s) => s.aiCollapsed);
  const name = useProjectStore((s) => s.project.name);
  const dirty = useProjectStore(selectDirty);
  const canUndo = useStore(useProjectStore.temporal, undoable);
  const canRedo = useStore(useProjectStore.temporal, redoable);
  const title = name.trim() || t("editor.untitled");

  return (
    <div
      role="toolbar"
      aria-label={t("editor.toolbar")}
      data-tour="toolbar"
      className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface-2 px-3"
    >
      <Clapperboard className="size-4 text-primary" aria-hidden />
      <h1 tabIndex={-1} className="truncate text-sm font-semibold tracking-tight outline-none">
        {title}
        {dirty && (
          <span className="ml-1.5 text-muted-foreground" title={t("editor.unsaved")}>
            <span aria-hidden>•</span>
            <span className="sr-only">{t("editor.unsaved")}</span>
          </span>
        )}
      </h1>
      <FileMenu file={file} />
      {/* 撤销 / 重做紧挨“文件”：与常见编辑软件一致，最常用的两个操作离文件菜单最近 */}
      <div role="group" aria-label={t("editor.history.group")} className="flex items-center gap-0.5 border-l border-border pl-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={!canUndo}
          aria-label={t("editor.toolbarUndo")}
          aria-keyshortcuts="Control+Z"
          title={t("editor.toolbarUndo")}
          onClick={() => useProjectStore.temporal.getState().undo()}
        >
          <Undo2 aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={!canRedo}
          aria-label={t("editor.toolbarRedo")}
          aria-keyshortcuts="Control+Y"
          title={t("editor.toolbarRedo")}
          onClick={() => useProjectStore.temporal.getState().redo()}
        >
          <Redo2 aria-hidden />
        </Button>
      </div>
      <BakeStatus />
      <div className="mx-auto">
        <TransportBar />
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("editor.markers.add")}
          aria-keyshortcuts="M"
          title={t("editor.markers.add")}
          onClick={() => addMarkerAtPlayhead()}
        >
          <Flag aria-hidden />
        </Button>
        <TempoPopover />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("editor.draft.title")}
          title={t("editor.draft.title")}
          onClick={() => useEditorUiStore.getState().setDraftOpen(true)}
        >
          <WandSparkles aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("editor.ai.dockTitle")}
          aria-pressed={!aiCollapsed}
          aria-keyshortcuts="Control+J"
          data-tour="ai-toggle"
          title={`${t("editor.ai.dockTitle")} (Ctrl+J)`}
          onClick={() => togglePanel("ai")}
        >
          <Bot aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("editor.commands.palette")}
          aria-keyshortcuts="Control+K"
          title={`${t("editor.commands.palette")} (Ctrl+K)`}
          onClick={() => useEditorUiStore.getState().setPaletteOpen(true)}
        >
          <Command aria-hidden />
        </Button>
      </div>
    </div>
  );
}
