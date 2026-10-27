import { useTranslation } from "react-i18next";
import { Clapperboard, Copy, Library, MoreHorizontal, Pencil, FilePenLine, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProgramHeaderTags } from "./ProgramHeaderTags";
import type { ProgramActions } from "../hooks/useProgramActions";
import { formatBytes } from "../lib/filter";
import type { LibraryEntry } from "../lib/types";

interface ProgramActionsMenuProps {
  entry: LibraryEntry;
  actions: ProgramActions;
  /** 进入行内重命名 */
  onRename: () => void;
  /** 请求删除（调用方负责二次确认） */
  onDelete: () => void;
  /** 复制成功后（如选中副本） */
  onDuplicated?: (path: string) => void;
  /** 提供时显示“在节目库中查看”（录制页侧栏用） */
  onShowInLibrary?: () => void;
  /** 菜单顶部是否显示完整信息（节目库页面有详情面板时可关闭） */
  showDetails?: boolean;
  /** 漫游 tabindex */
  tabIndex?: number;
}

/**
 * 节目的“⋯”菜单：顶部是完整信息（键盘用户也能读到，不依赖悬停提示），
 * 下面是编辑 / 编辑导出 / 上传 / 重命名 / 复制，删除用危险色并与其余操作分开。
 */
export function ProgramActionsMenu({
  entry,
  actions,
  onRename,
  onDelete,
  onDuplicated,
  onShowInLibrary,
  showDetails = true,
  tabIndex,
}: ProgramActionsMenuProps) {
  const { t } = useTranslation();
  const when = new Date(entry.modifiedUnixMs).toLocaleString();
  const meta = t("recording.libMeta", {
    frames: entry.frames,
    size: formatBytes(entry.bytes),
    n: entry.universes.length,
  });
  const canEditExport = entry.valid && entry.exported;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          tabIndex={tabIndex}
          className="size-9 text-muted-foreground data-[state=open]:bg-accent"
          aria-label={`${t("recording.libMore")}: ${entry.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" onClick={(e) => e.stopPropagation()}>
        {showDetails && (
          <>
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              <p className="truncate font-medium text-foreground" title={entry.fileName}>
                {entry.fileName}
              </p>
              <p className="truncate">{when}</p>
              {entry.sources.length > 0 && <p className="truncate">{entry.sources.join(", ")}</p>}
              {entry.notes && <p className="line-clamp-2">{entry.notes}</p>}
              <p className="num">{meta}</p>
              {entry.valid && (
                <div className="mt-1.5">
                  <ProgramHeaderTags header={entry.header} />
                </div>
              )}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {entry.editable && (
          <DropdownMenuItem onSelect={() => actions.openInEditor(entry)}>
            <Clapperboard aria-hidden />
            {t("recording.libEdit")}
          </DropdownMenuItem>
        )}
        {canEditExport && (
          <DropdownMenuItem onSelect={() => actions.openEditExport(entry)}>
            <FilePenLine aria-hidden />
            {entry.editable ? t("library.actionTrimPlain") : t("library.actionEditExport")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={!actions.canUpload || !entry.valid || actions.uploading === entry.path}
          onSelect={() => void actions.upload(entry)}
        >
          <Upload aria-hidden />
          <span className="grid">
            {t("recording.libUpload")}
            {!actions.canUpload && (
              <span className="text-xs text-muted-foreground">{t("recording.libUploadNeedsDevice")}</span>
            )}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename}>
          <Pencil aria-hidden />
          {t("recording.libRename")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            void actions.duplicate(entry).then((path) => {
              if (path) onDuplicated?.(path);
            })
          }
        >
          <Copy aria-hidden />
          {t("library.actionDuplicate")}
        </DropdownMenuItem>
        {onShowInLibrary && (
          <DropdownMenuItem onSelect={onShowInLibrary}>
            <Library aria-hidden />
            {t("library.actionShowInLibrary")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 aria-hidden />
          {t("common.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
