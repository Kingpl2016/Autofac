import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Copy, Pause, Pencil, Play, FilePenLine, Trash2, Upload, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  formatDurationUs,
  ProgramHeaderTags,
  ProgramRenameInput,
  ProgramStatusBadges,
  ProgramThumb,
  type LibraryEntry,
  type ProgramActions,
} from "@/features/recording";
import { ProgramNotesEditor } from "./ProgramNotesEditor";

interface ProgramDetailPanelProps {
  entry: LibraryEntry;
  actions: ProgramActions;
  /** 改名成功（路径随之改变） */
  onRenamed: (from: string, to: string) => void;
  onDuplicated: (path: string) => void;
  onRequestDelete: (entry: LibraryEntry) => void;
  onClose: () => void;
  /** 作为抽屉内容时不画外框、不显示关闭按钮（抽屉自带） */
  embedded?: boolean;
}

/** 详情里的一行：标签 + 值。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="py-1 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 py-1 text-sm break-words">{children}</dd>
    </>
  );
}

/**
 * 节目详情（与表格并排、非模态；窄屏时放在抽屉里）：大热力图、名称（可改）、状态、
 * 完整元数据、可编辑的备注，以及回放 / 编辑导出 / 编辑器 / 复制 / 上传操作；删除单独放在底部，用危险色。
 */
export function ProgramDetailPanel({
  entry: e,
  actions,
  onRenamed,
  onDuplicated,
  onRequestDelete,
  onClose,
  embedded = false,
}: ProgramDetailPanelProps) {
  const { t, i18n } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const isLoaded = e.path === actions.loadedPath;
  const isPlaying = isLoaded && actions.loadedState === "playing";
  const canEditExport = e.valid && e.exported;

  const commitRename = (name: string) => {
    setRenaming(false);
    void actions.rename(e, name).then((path) => {
      if (path) onRenamed(e.path, path);
    });
  };

  const handleKey = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key === "Escape" && !renaming) onClose();
    else if (ev.key === "F2" && !renaming) {
      ev.preventDefault();
      setRenaming(true);
    }
  };

  return (
    <aside
      aria-label={t("library.detailTitle")}
      onKeyDown={handleKey}
      data-surface=""
      className={cn(
        "flex min-h-0 flex-col overflow-hidden",
        embedded ? "flex-1" : "w-[22rem] shrink-0 rounded-lg border border-border bg-card",
      )}
    >
      <header className={cn("flex items-start gap-2 border-b border-border", embedded ? "pb-4" : "p-4")}>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <ProgramRenameInput initial={e.name} onCommit={commitRename} onCancel={() => setRenaming(false)} />
          ) : (
            <div className="flex items-center gap-1">
              <h2 className="min-w-0 truncate text-base font-semibold" title={e.name}>
                {e.name}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-muted-foreground"
                aria-label={t("recording.libRename")}
                aria-keyshortcuts="F2"
                title={`${t("recording.libRename")} (F2)`}
                onClick={() => setRenaming(true)}
              >
                <Pencil className="size-3.5" />
              </Button>
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {isPlaying && <Badge variant="success">{t("player.live")}</Badge>}
            {isLoaded && actions.loadedState === "paused" && <Badge variant="warning">{t("player.statePaused")}</Badge>}
            {isLoaded && actions.loadedState === "stopped" && <Badge variant="outline">{t("recording.libOpened")}</Badge>}
            <ProgramStatusBadges entry={e} />
          </div>
        </div>
        {!embedded && (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-muted-foreground"
            aria-label={t("library.closeDetail")}
            title={t("library.closeDetail")}
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </header>

      <div className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto", embedded ? "pt-4" : "p-4")}>
        <ProgramThumb path={e.path} valid={e.valid} className="h-24 w-full rounded-md" />

        <div className="grid grid-cols-2 gap-2">
          <Button
            className="col-span-2"
            disabled={(!e.valid && !isLoaded) || actions.transitioning}
            onClick={() => (isLoaded ? void actions.toggleLoaded() : actions.requestPlay(e))}
          >
            {isPlaying ? <Pause className="fill-current" /> : <Play className="fill-current" />}
            {isPlaying ? t("player.pause") : isLoaded ? t("player.play") : t("player.playProgram")}
          </Button>
          {canEditExport && (
            <Button variant="outline" size="sm" className={cn(!e.editable && "col-span-2")} onClick={() => actions.openEditExport(e)}>
              <FilePenLine />
              {e.editable ? t("library.actionTrimPlain") : t("library.actionEditExport")}
            </Button>
          )}
          {e.editable && (
            <Button variant="outline" size="sm" className={cn(!canEditExport && "col-span-2")} onClick={() => actions.openInEditor(e)}>
              <Clapperboard />
              {t("library.actionOpenEditor")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void actions.duplicate(e).then((path) => {
                if (path) onDuplicated(path);
              })
            }
          >
            <Copy />
            {t("library.actionDuplicate")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!actions.canUpload || !e.valid || actions.uploading === e.path}
            loading={actions.uploading === e.path}
            title={actions.canUpload ? undefined : t("recording.libUploadNeedsDevice")}
            onClick={() => void actions.upload(e)}
          >
            <Upload />
            {t("library.actionUpload")}
          </Button>
        </div>
        {!actions.canUpload && (
          <p className="-mt-2 text-xs text-muted-foreground">{t("recording.libUploadNeedsDevice")}</p>
        )}
        {e.editable && canEditExport && (
          <p className="-mt-2 text-xs text-muted-foreground">{t("library.trimPlainHint")}</p>
        )}

        <ProgramNotesEditor key={`${e.path}\n${e.notes}`} notes={e.notes} onSave={(notes) => actions.setNotes(e, notes)} />

        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3">
          <Field label={t("library.fieldFile")}>{e.fileName}</Field>
          <Field label={t("library.colDuration")}>
            <span className="num">{formatDurationUs(e.durationUs)}</span>
          </Field>
          <Field label={t("library.fieldFrames")}>
            <span className="num">{e.frames.toLocaleString(i18n.language)}</span>
          </Field>
          <Field label={t("library.colSize")}>
            <span className="num">{formatBytes(e.bytes)}</span>
          </Field>
          <Field label={t("library.colUniverses")}>
            {e.universes.length === 0 ? "—" : <span className="num">{e.universes.join(", ")}</span>}
          </Field>
          <Field label={t("library.colModified")}>{new Date(e.modifiedUnixMs).toLocaleString(i18n.language)}</Field>
          <Field label={t("library.fieldSources")}>{e.sources.length > 0 ? e.sources.join(", ") : "—"}</Field>
          {e.valid && e.header && (
            <Field label={t("library.fieldFormat")}>
              <ProgramHeaderTags header={e.header} />
            </Field>
          )}
        </dl>

        <div className="mt-auto grid gap-3">
          <Separator />
          <Button variant="outline" size="sm" className="justify-self-start text-destructive hover:text-destructive" onClick={() => onRequestDelete(e)}>
            <Trash2 />
            {t("library.actionDelete")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
