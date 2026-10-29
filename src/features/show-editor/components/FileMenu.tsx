import { useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Copy,
  FileArchive,
  FileClock,
  FileDown,
  FileInput,
  FileOutput,
  FilePlus2,
  FolderOpen,
  FolderSearch,
  Info,
  Library,
  Pin,
  PinOff,
  RotateCcw,
  Save,
  SaveAll,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatChord } from "@/shared/lib/keyboard";
import type { ShowFileController } from "../hooks/useShowFile";
import { effectiveKeys } from "../lib/commands";
import { FILE_COMMANDS, type FileCommandId } from "../lib/fileCommands";
import { folderOf, relativeTime } from "../lib/relativeTime";
import { showFileInfo } from "../lib/showFile";
import { useDocumentStore } from "../stores/useDocumentStore";
import { useKeymapStore } from "../stores/useKeymapStore";
import { orderRecent, useRecentFilesStore, type RecentFile } from "../stores/useRecentFilesStore";

interface FileMenuProps {
  file: ShowFileController;
}

/** 阻止事件冒泡到菜单项（菜单项里的小按钮不触发“打开”）。 */
const stop = (e: SyntheticEvent) => {
  e.stopPropagation();
  e.preventDefault();
};

/**
 * 清除失效项：逐个查询最近文件是否还在，不在的（或路径已不合法的）从列表移除。
 *
 * @param items 最近文件。
 * @returns 移除的数量。
 */
async function pruneMissing(items: readonly RecentFile[]): Promise<number> {
  const missing = (
    await Promise.all(
      items.map(async (x) => {
        try {
          return (await showFileInfo(x.kind, x.path)).exists ? null : x.path;
        } catch {
          return x.path;
        }
      }),
    )
  ).filter((p): p is string => p !== null);
  if (missing.length > 0) useRecentFilesStore.getState().removeMany(missing);
  return missing.length;
}

/**
 * 工具条上的文件操作：保存按钮（Ctrl+S）和“文件”菜单。
 *
 * 菜单分组：
 * - 新建、从节目库打开、打开工程文件、最近打开（子菜单：置顶的排在最前；每项可置顶 / 移除，
 *   键盘上 P 置顶、Delete 移除；底部“清除失效项”“清空列表”）；
 * - 保存、另存为新节目、另存为工程文件、导出工程副本、导出 ArtRec 回放文件、导入节目；
 * - 重新载入、在文件管理器中显示、复制文件路径、节目信息。
 *
 * 快捷键与命令表一致（用户改键后这里跟着变）；当前工程从未保存过时，和文件位置有关的项不可用。
 */
export function FileMenu({ file }: FileMenuProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const overrides = useKeymapStore((s) => s.overrides);
  const origin = useDocumentStore((s) => s.origin);
  const recent = useRecentFilesStore((s) => s.items);
  const setPinned = useRecentFilesStore((s) => s.setPinned);
  const remove = useRecentFilesStore((s) => s.remove);
  const clear = useRecentFilesStore((s) => s.clear);
  const [now, setNow] = useState(() => Date.now());
  const hasPath = origin.kind !== "none";
  const saveKeys = effectiveKeys({ id: "file.save", keys: FILE_COMMANDS["file.save"].keys }, overrides);

  /** 菜单里的一项：图标 + 文字 + 快捷键。 */
  const item = (icon: ReactNode, label: string, onSelect: () => void, command?: FileCommandId, disabled = false) => {
    const keys = command ? effectiveKeys({ id: command, keys: FILE_COMMANDS[command].keys }, overrides) : [];
    return (
      <DropdownMenuItem disabled={disabled} onSelect={onSelect}>
        {icon}
        {label}
        {keys[0] && <DropdownMenuShortcut>{formatChord(keys[0])}</DropdownMenuShortcut>}
      </DropdownMenuItem>
    );
  };
  const ordered = orderRecent(recent);

  const recentItem = (r: RecentFile) => {
    const where = r.kind === "library" ? t("editor.recent.library") : folderOf(r.path) || r.path;
    const togglePin = () => {
      setPinned(r.path, !r.pinned);
      toast.success(t(r.pinned ? "editor.recent.unpinnedToast" : "editor.recent.pinnedToast", { name: r.name }));
    };
    return (
      <DropdownMenuItem
        key={r.path}
        title={`${r.path}\n${t("editor.recent.keysHint")}`}
        onSelect={() => file.requestOpenRecent(r)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "p" || e.key === "P") {
            stop(e);
            togglePin();
          } else if (e.key === "Delete") {
            stop(e);
            remove(r.path);
          }
        }}
        className="group gap-2 pr-1"
      >
        {r.kind === "library" ? <Library aria-hidden /> : <FileClock aria-hidden />}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 truncate">
            <span className="truncate">{r.name}</span>
            {r.pinned && <Pin aria-label={t("editor.recent.pinned")} className="size-3 shrink-0 text-muted-foreground" />}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {where} · {relativeTime(r.openedAt, now, i18n.language)}
          </span>
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t(r.pinned ? "editor.recent.unpin" : "editor.recent.pin", { name: r.name })}
          title={t(r.pinned ? "editor.recent.unpin" : "editor.recent.pin", { name: r.name })}
          onPointerDown={stop}
          onPointerUp={stop}
          onClick={(e) => {
            stop(e);
            togglePin();
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100 hover:text-foreground"
        >
          {r.pinned ? <PinOff aria-hidden className="size-3.5" /> : <Pin aria-hidden className="size-3.5" />}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("editor.recent.removeOne", { name: r.name })}
          title={t("editor.recent.removeOne", { name: r.name })}
          onPointerDown={stop}
          onPointerUp={stop}
          onClick={(e) => {
            stop(e);
            remove(r.path);
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100 hover:text-foreground"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </DropdownMenuItem>
    );
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2"
        aria-keyshortcuts={saveKeys[0] ? formatChord(saveKeys[0]).replaceAll("Ctrl", "Control") : undefined}
        title={saveKeys[0] ? t("editor.file.saveHintKeys", { keys: formatChord(saveKeys[0]) }) : t("common.save")}
        onClick={file.save}
      >
        <Save aria-hidden />
        {t("common.save")}
      </Button>
      <DropdownMenu
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setNow(Date.now());
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2 data-[state=open]:bg-accent">
            {t("editor.file.menu")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72" aria-label={t("editor.file.menu")}>
          {item(<FilePlus2 aria-hidden />, t("editor.file.new"), file.requestNew, "file.new")}
          {item(<Library aria-hidden />, t("editor.file.openLibrary"), file.requestOpenLibrary, "file.openLibrary")}
          {item(<FolderSearch aria-hidden />, t("editor.file.openFile"), file.requestOpenFile, "file.openFile")}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={ordered.length === 0}>
              <FileClock aria-hidden />
              {t("editor.recent.title")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-80" aria-label={t("editor.recent.title")}>
              {ordered.map(recentItem)}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  void pruneMissing(recent).then((n) =>
                    toast.success(n > 0 ? t("editor.recent.pruned", { count: n }) : t("editor.recent.nothingPruned")),
                  )
                }
              >
                {t("editor.recent.prune")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!recent.some((x) => !x.pinned)} onSelect={clear}>
                {t("editor.recent.clear")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />
          {item(<Save aria-hidden />, t("common.save"), file.save, "file.save")}
          {item(<SaveAll aria-hidden />, t("editor.file.saveAsNew"), () => file.openSaveDialog(true), "file.saveAsNew")}
          {item(<FolderOpen aria-hidden />, t("editor.file.saveAsFile"), file.saveAsFile)}
          {item(<FileDown aria-hidden />, t("editor.file.exportCopy"), file.exportCopy)}
          {item(<FileArchive aria-hidden />, t("editor.file.exportArtrec"), file.exportArtrec, "file.exportArtrec")}
          {item(<FileInput aria-hidden />, t("editor.file.import"), file.requestImport, "file.import")}

          <DropdownMenuSeparator />
          {hasPath && (
            <DropdownMenuLabel className="truncate text-[11px] font-normal text-muted-foreground" title={origin.path}>
              {origin.path}
            </DropdownMenuLabel>
          )}
          {item(<RotateCcw aria-hidden />, t("editor.file.reload"), file.requestReload, "file.reload", !hasPath)}
          {item(<FileOutput aria-hidden />, t("editor.file.reveal"), file.revealInFolder, "file.reveal", !hasPath)}
          {item(<Copy aria-hidden />, t("editor.file.copyPath"), file.copyPath, undefined, !hasPath)}
          {item(<Info aria-hidden />, t("editor.file.info"), file.openInfo, "file.info")}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
