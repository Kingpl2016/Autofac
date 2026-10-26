import { useState } from "react";
import { Check, Download, Pause, Pencil, Play, Repeat, Square, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FilePlayState } from "../../lib/files";
import { formatBytes } from "../../lib/format";
import type { NetFile } from "../../lib/types";

interface FileRowProps {
  file: NetFile;
  playState: FilePlayState;
  canWrite: boolean;
  renaming: boolean;
  onStartRename: () => void;
  onCancelRename: () => void;
  /** 提交重命名；返回后由父组件决定是否退出编辑 */
  onRename: (to: string) => Promise<void>;
  onPlay: (loop: boolean) => void;
  onStop: () => void;
  onDownload: () => void;
  onDelete: () => void;
}

/**
 * 一行设备文件：文件名 / 节目号 / 大小 / 操作。正在播放的行高亮并提供"停止"。
 */
export function FileRow(props: FileRowProps) {
  const { t } = useTranslation();
  const { file, playState, canWrite, renaming } = props;
  const noProgram = file.program === null;
  const playing = playState !== null;
  const playDisabled = !canWrite || noProgram;
  const playHint = noProgram ? t("network.files.noProgramHint") : undefined;

  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_4.5rem_6rem_auto] items-center gap-x-4 border-b border-border px-4 py-2 last:border-b-0",
        playing ? "bg-success/10" : "hover:bg-surface-3/50",
      )}
    >
      <div className="min-w-0">
        {renaming ? (
          <RenameField name={file.name} onSubmit={props.onRename} onCancel={props.onCancelRename} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              {playing && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                  {playState === "paused" ? <Pause className="size-3 fill-current" aria-hidden /> : <Play className="size-3 fill-current" aria-hidden />}
                  {playState === "paused" ? t("network.files.paused") : t("network.files.playing")}
                </span>
              )}
              <span className="truncate text-sm font-medium" title={file.name}>
                {file.name}
              </span>
            </div>
          </>
        )}
      </div>
      <span className="tabular text-right text-sm text-muted-foreground">{noProgram ? "—" : `#${file.program}`}</span>
      <span className="tabular text-right text-sm text-muted-foreground">{formatBytes(file.size)}</span>
      <div className="flex w-[13.5rem] justify-end gap-0.5">
        {playing ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
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
              className="size-9"
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
              className="size-9"
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
          className="size-9"
          aria-label={`${t("network.files.download")}: ${file.name}`}
          title={t("network.files.download")}
          onClick={props.onDownload}
        >
          <Download />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
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
          className="size-9 text-destructive hover:text-destructive"
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
