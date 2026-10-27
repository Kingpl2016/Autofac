import { useState, type CSSProperties, type HTMLAttributes } from "react";
import { Check, Download, GripVertical, Pause, Pencil, Play, Repeat, Square, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FilePlayState, ProgramAssignment } from "../../lib/files";
import { formatBytes } from "../../lib/format";
import type { NetFile } from "../../lib/types";
import { ProgramNumberEditor } from "./ProgramNumberEditor";

/** 行的列布局（节目号 / 文件名称 / 大小 / 操作），表头共用。节目号列里还放着拖动手柄。 */
export const FILE_GRID = "grid-cols-[9.5rem_minmax(0,1fr)_6.5rem_auto]";

/** 拖动排序需要接到行上的东西（由 `SortableFileRow` 提供）。 */
export interface RowDrag {
  style: CSSProperties;
  isDragging: boolean;
  /** 手柄不可用（不可写、正在提交） */
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
 * 一行设备文件：拖动手柄 / 文件名 / 节目号 / 大小 / 操作。正在播放的行高亮并提供"停止"。
 */
export function FileRow({ bindRow, bindHandle, ...props }: FileRowProps) {
  const { t } = useTranslation();
  const { file, playState, canWrite, renaming, drag } = props;
  const noProgram = file.program === null;
  const playing = playState !== null;
  const playDisabled = !canWrite || noProgram;
  const playHint = noProgram ? t("network.files.noProgramHint") : undefined;

  return (
    <li
      ref={bindRow}
      style={drag?.style}
      className={cn(
        "grid min-h-16 items-center gap-x-4 border-b border-border px-5 py-2.5 last:border-b-0",
        FILE_GRID,
        playing ? "bg-success/10" : "hover:bg-surface-3/50",
        drag?.isDragging && "relative z-10 border-transparent bg-surface-3 shadow-lg ring-1 ring-primary/50",
      )}
    >
      {/* 节目号列：拖动手柄 + 节目号（点击修改） */}
      <div className="flex items-center gap-1">
        {drag ? (
          <button
            type="button"
            ref={bindHandle}
            {...drag.handleProps}
            disabled={drag.disabled}
            aria-label={`${t("network.files.dragHandle")}: ${file.name}`}
            title={t("network.files.dragHandle")}
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
      <div className="min-w-0">
        {renaming ? (
          <RenameField name={file.name} onSubmit={props.onRename} onCancel={props.onCancelRename} />
        ) : (
          <div className="flex items-center gap-2.5">
            {playing && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                {playState === "paused" ? <Pause className="size-3 fill-current" aria-hidden /> : <Play className="size-3 fill-current" aria-hidden />}
                {playState === "paused" ? t("network.files.paused") : t("network.files.playing")}
              </span>
            )}
            <span className="truncate text-base font-medium" title={file.name}>
              {file.name}
            </span>
          </div>
        )}
      </div>
      <span className="tabular text-right text-sm text-muted-foreground">{formatBytes(file.size)}</span>
      <div className="flex w-[14rem] justify-end gap-0.5">
        {playing ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-10 [&_svg]:size-5"
            disabled={!canWrite}
            aria-label={`${t("network.files.stop")}: ${file.name}`}
            title={t("network.files.stop")}
            onClick={props.onStop}
          >
            <Square className="fill-current" />
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-10 [&_svg]:size-5"
              disabled={playDisabled}
              aria-label={`${t("network.files.playOnce")}: ${file.name}`}
              title={playHint ?? t("network.files.playOnce")}
              onClick={() => props.onPlay(false)}
            >
              <Play />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-10 [&_svg]:size-5"
              disabled={playDisabled}
              aria-label={`${t("network.files.playLoop")}: ${file.name}`}
              title={playHint ?? t("network.files.playLoop")}
              onClick={() => props.onPlay(true)}
            >
              <Repeat />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-10 [&_svg]:size-5"
          aria-label={`${t("network.files.download")}: ${file.name}`}
          title={t("network.files.download")}
          onClick={props.onDownload}
        >
          <Download />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10 [&_svg]:size-5"
          disabled={!canWrite}
          aria-label={`${t("network.files.rename")}: ${file.name}`}
          title={t("network.files.rename")}
          onClick={props.onStartRename}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10 text-destructive hover:text-destructive [&_svg]:size-5"
          disabled={!canWrite}
          aria-label={`${t("common.delete")}: ${file.name}`}
          title={t("common.delete")}
          onClick={props.onDelete}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
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
        className="h-10"
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
      <Button variant="ghost" size="icon" className="size-10 [&_svg]:size-5" aria-label={t("common.save")} disabled={busy} onClick={() => void submit()}>
        <Check />
      </Button>
      <Button variant="ghost" size="icon" className="size-10 [&_svg]:size-5" aria-label={t("common.cancel")} disabled={busy} onClick={onCancel}>
        <X />
      </Button>
    </div>
  );
}
