import { useId, useRef, useState, type CSSProperties, type HTMLAttributes } from "react";
import { Check, Download, GripVertical, MoreHorizontal, Pause, Pencil, Play, Repeat, Square, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FilePlayState, ProgramAssignment } from "../../lib/files";
import { formatBytes } from "../../lib/format";
import type { NetFile } from "../../lib/types";
import { ProgramNumberEditor } from "./ProgramNumberEditor";

/** 拖动排序需要接到行上的东西（由 `SortableFileRow` 提供）。 */
export interface RowDrag {
  style: CSSProperties;
  isDragging: boolean;
  /** 手柄不可用（不可写、正在提交、筛选中） */
  disabled: boolean;
  /** 手柄上的无障碍属性与指针 / 键盘监听 */
  handleProps: HTMLAttributes<HTMLButtonElement>;
}

interface FileRowProps {
  file: NetFile;
  /** 设备上的全部文件，改节目号时判断冲突 */
  files: readonly NetFile[];
  playState: FilePlayState;
  /** 正在播放 / 暂停的节目号 */
  playingNo: number | null;
  canWrite: boolean;
  renaming: boolean;
  /** 有值表示这一行可拖动排序 */
  drag?: RowDrag;
  /** 把行 / 手柄的 DOM 节点交给 dnd-kit（与 `drag` 一起提供） */
  bindRow?: (el: HTMLElement | null) => void;
  bindHandle?: (el: HTMLElement | null) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  /** 提交重命名；返回后由父组件决定是否退出编辑 */
  onRename: (to: string) => Promise<void>;
  onReassign: (assignments: ProgramAssignment[], label: string) => Promise<boolean>;
  onPlay: (loop: boolean) => void;
  onStop: () => void;
  onDownload: () => void;
  onDelete: () => void;
}

/**
 * 一行设备文件（表格行）：拖动手柄 + 节目号 / 文件名 / 大小 / 操作。
 *
 * 操作区只放一个主按钮（播放；播放中时是停止）和“⋯”菜单（循环播放、下载、重命名、删除），
 * 删除在分隔线之后并用危险色，不和重命名挨着。焦点在行内时：F2 重命名、Delete 删除、Ctrl+S 下载。
 */
export function FileRow({ bindRow, bindHandle, ...props }: FileRowProps) {
  const { t } = useTranslation();
  const { file, playState, canWrite, renaming, drag } = props;
  const noProgram = file.program === null;
  const playing = playState !== null;
  const playDisabled = !canWrite || noProgram;
  const hintId = useId();
  // 从菜单进入重命名时，阻止菜单关闭后把焦点还给“⋯”按钮（焦点应留在输入框里）
  const keepFocus = useRef(false);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (renaming || (e.target as HTMLElement).closest("input, [role=menu], [role=dialog]")) return;
    if (e.key === "F2" && canWrite) props.onStartRename();
    else if (e.key === "Delete" && canWrite) props.onDelete();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") props.onDownload();
    else return;
    e.preventDefault();
  };

  return (
    <tr
      ref={bindRow}
      style={drag?.style}
      onKeyDown={onKeyDown}
      className={cn(
        "border-b border-border last:border-b-0 transition-colors duration-150 motion-reduce:transition-none",
        playing ? "bg-success/10" : "hover:bg-surface-3/50 focus-within:bg-surface-3/40",
        drag?.isDragging && "relative z-10 border-transparent bg-surface-3 shadow-lg ring-1 ring-primary/50",
      )}
    >
      {/* 节目号列：拖动手柄 + 节目号（点击修改） */}
      <td className="w-40 py-2 pl-3 pr-2 align-middle">
        <div className="flex items-center gap-1">
          {drag ? (
            <button
              type="button"
              ref={bindHandle}
              {...drag.handleProps}
              disabled={drag.disabled}
              aria-label={`${t("network.files.dragHandle")}: ${file.name}`}
              className={cn(
                "flex size-9 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground transition-colors",
                "hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:pointer-events-none disabled:opacity-30",
                drag.isDragging ? "cursor-grabbing" : "cursor-grab",
              )}
            >
              <GripVertical className="size-5" aria-hidden />
            </button>
          ) : (
            <span className="size-9 shrink-0" aria-hidden />
          )}
          <ProgramNumberEditor
            file={file}
            files={props.files}
            playingNo={props.playingNo}
            disabled={!canWrite}
            onSubmit={props.onReassign}
          />
        </div>
      </td>

      {/* 自动表格布局里，弹性列要 `w-full max-w-0` 才能让长文件名截断而不是撑开表格 */}
      <td className="w-full max-w-0 py-2 pr-4 align-middle">
        {renaming ? (
          <RenameField name={file.name} onSubmit={props.onRename} onCancel={props.onCancelRename} />
        ) : (
          <div className="flex min-w-0 items-center gap-2.5">
            {playing && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                {playState === "paused" ? <Pause className="size-3 fill-current" aria-hidden /> : <Play className="size-3 fill-current" aria-hidden />}
                {playState === "paused" ? t("network.files.paused") : t("network.files.playing")}
              </span>
            )}
            <span className="min-w-0 truncate text-sm font-medium" title={file.name}>
              {file.name}
            </span>
            {noProgram && (
              <span id={hintId} className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                {t("network.files.noProgram")}
              </span>
            )}
          </div>
        )}
      </td>

      <td className="tabular hidden w-28 whitespace-nowrap py-2 pr-4 text-right align-middle text-sm text-muted-foreground @xl:table-cell">
        {formatBytes(file.size)}
      </td>

      <td className="w-px whitespace-nowrap py-2 pr-3 align-middle">
        <div className="flex items-center justify-end gap-1">
          {playing ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-24 px-3"
              disabled={!canWrite}
              aria-label={`${t("network.files.stop")}: ${file.name}`}
              onClick={props.onStop}
            >
              <Square className="fill-current" />
              {t("network.files.stop")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-9 w-24 px-3"
              disabled={playDisabled}
              aria-label={`${t("network.files.playOnce")}: ${file.name}`}
              aria-describedby={noProgram ? hintId : undefined}
              onClick={() => props.onPlay(false)}
            >
              <Play />
              {t("network.files.play")}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-9 text-muted-foreground data-[state=open]:bg-accent"
                aria-label={`${t("network.rail.moreActions")}: ${file.name}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-48"
              onCloseAutoFocus={(e) => {
                if (keepFocus.current) {
                  keepFocus.current = false;
                  e.preventDefault();
                }
              }}
            >
              <DropdownMenuItem disabled={playDisabled || playing} onSelect={() => props.onPlay(true)}>
                <Repeat aria-hidden />
                {t("network.files.playLoop")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={props.onDownload}>
                <Download aria-hidden />
                {t("network.files.download")}
                <DropdownMenuShortcut>Ctrl+S</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canWrite}
                onSelect={() => {
                  keepFocus.current = true;
                  props.onStartRename();
                }}
              >
                <Pencil aria-hidden />
                {t("network.files.rename")}
                <DropdownMenuShortcut>F2</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={!canWrite} onSelect={props.onDelete}>
                <Trash2 aria-hidden />
                {t("common.delete")}
                <DropdownMenuShortcut>Del</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
}

interface RenameFieldProps {
  name: string;
  onSubmit: (to: string) => Promise<void>;
  onCancel: () => void;
}

/** 行内重命名：Enter 提交、Esc 取消，挂载即聚焦并选中主名部分。 */
function RenameField({ name, onSubmit, onCancel }: RenameFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(draft.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        className="h-9"
        value={draft}
        disabled={busy}
        aria-label={t("network.files.rename")}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.setSelectionRange(0, Math.max(0, name.lastIndexOf(".")))}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <Button variant="ghost" size="icon" className="size-9" aria-label={t("common.save")} disabled={busy} onClick={() => void submit()}>
        <Check />
      </Button>
      <Button variant="ghost" size="icon" className="size-9" aria-label={t("common.cancel")} disabled={busy} onClick={onCancel}>
        <X />
      </Button>
    </div>
  );
}
