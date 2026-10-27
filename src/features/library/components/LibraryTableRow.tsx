import { memo, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  formatDurationUs,
  ProgramActionsMenu,
  ProgramPlayButton,
  ProgramRenameInput,
  ProgramStatusBadges,
  ProgramThumb,
  type LibraryEntry,
  type ProgramActions,
} from "@/features/recording";
import { formatRelativeTime } from "../lib/relativeTime";

interface LibraryTableRowProps {
  entry: LibraryEntry;
  /** 节目在整个库里的序号（筛选 / 排序时不变） */
  no: number;
  actions: ProgramActions;
  /** 详情面板当前展示的节目 */
  selected: boolean;
  /** 勾选（批量操作） */
  checked: boolean;
  /** 漫游 tabindex：整张表只有一行是 Tab 停靠点 */
  active: boolean;
  /** 窄布局：隐藏 Universe / 大小列，摘要并入名称下方 */
  compact: boolean;
  /** 刚录制 */
  fresh: boolean;
  renaming: boolean;
  nowMs: number;
  onSelect: (path: string) => void;
  onCheck: (path: string, checked: boolean) => void;
  onActivate: (path: string) => void;
  onStartRename: (path: string) => void;
  onCommitRename: (entry: LibraryEntry, name: string) => void;
  onCancelRename: (path: string) => void;
  onRequestDelete: (entry: LibraryEntry) => void;
  onDuplicated: (path: string) => void;
}

/**
 * 节目库表格的一行（约 56px）：勾选框、序号、迷你热力图、名称与状态、时长、Universe、大小、修改时间、
 * 回放与“⋯”菜单。整行可点击 / 键盘激活以打开详情；双击回放。
 *
 * 行内快捷键：Enter 打开详情、Space 勾选、F2 重命名、Delete 删除。
 */
function LibraryTableRowImpl({
  entry: e,
  no,
  actions,
  selected,
  checked,
  active,
  compact,
  fresh,
  renaming,
  nowMs,
  onSelect,
  onCheck,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
  onDuplicated,
}: LibraryTableRowProps) {
  const { t, i18n } = useTranslation();
  const isLoaded = e.path === actions.loadedPath;
  const state = isLoaded ? actions.loadedState : null;
  const isPlaying = state === "playing";
  const summary = `${formatDurationUs(e.durationUs)} · ${t("recording.libUniverses", { n: e.universes.length })} · ${formatBytes(e.bytes)}`;
  const when = new Date(e.modifiedUnixMs);
  const tab = active ? 0 : -1;

  const handleKeyDown = (ev: KeyboardEvent<HTMLTableRowElement>) => {
    // 只处理行本身的按键；行内按钮 / 输入框自己处理
    if (ev.target !== ev.currentTarget) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      onSelect(e.path);
    } else if (ev.key === " ") {
      ev.preventDefault();
      onCheck(e.path, !checked);
    } else if (ev.key === "F2") {
      ev.preventDefault();
      onStartRename(e.path);
    } else if (ev.key === "Delete") {
      ev.preventDefault();
      onRequestDelete(e);
    }
  };

  return (
    <tr
      data-path={e.path}
      tabIndex={tab}
      aria-current={selected ? "true" : undefined}
      aria-selected={checked}
      aria-keyshortcuts="Enter Space F2 Delete"
      onClick={() => onSelect(e.path)}
      onDoubleClick={() => {
        if (isLoaded) void actions.toggleLoaded();
        else if (e.valid && !actions.transitioning) actions.requestPlay(e);
      }}
      onFocus={(ev) => {
        if (ev.target === ev.currentTarget) onActivate(e.path);
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        "group h-14 cursor-pointer border-b border-border transition-colors duration-150 last:border-b-0 motion-reduce:transition-none",
        "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        checked && "bg-primary/5",
        selected && "bg-primary/10 shadow-[inset_2px_0_0_0_var(--primary)]",
        isPlaying && !selected && "bg-success/5",
      )}
    >
      <td className="px-3" onClick={(ev) => ev.stopPropagation()}>
        <Checkbox
          tabIndex={-1}
          checked={checked}
          onCheckedChange={(v) => onCheck(e.path, v === true)}
          aria-label={t("library.selectRow", { name: e.name })}
        />
      </td>
      <td
        className={cn(
          "num px-2 text-right text-xs font-semibold",
          isLoaded ? (isPlaying ? "text-success" : "text-primary") : "text-muted-foreground",
        )}
      >
        {String(no).padStart(2, "0")}
      </td>
      <td className="px-2">
        <ProgramThumb path={e.path} valid={e.valid} className="h-9 w-16 rounded-md" />
      </td>
      <td className="max-w-0 px-3">
        {renaming ? (
          <ProgramRenameInput
            initial={e.name}
            onCommit={(name) => onCommitRename(e, name)}
            onCancel={() => onCancelRename(e.path)}
          />
        ) : (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium" title={[e.name, e.fileName, e.notes].filter(Boolean).join("\n")}>
                {e.name}
              </span>
              {isPlaying && <Badge variant="success" className="shrink-0">{t("player.live")}</Badge>}
              {state === "paused" && <Badge variant="warning" className="shrink-0">{t("player.statePaused")}</Badge>}
              {state === "stopped" && <Badge variant="outline" className="shrink-0">{t("recording.libOpened")}</Badge>}
              <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
                <ProgramStatusBadges entry={e} isFresh={fresh} />
              </span>
            </div>
            {compact ? (
              <div className="num truncate text-xs text-muted-foreground">{summary}</div>
            ) : (
              e.notes && <div className="truncate text-xs text-muted-foreground">{e.notes}</div>
            )}
          </div>
        )}
      </td>
      <td className="num whitespace-nowrap px-3 text-right">{formatDurationUs(e.durationUs)}</td>
      {!compact && (
        <>
          <td className="num whitespace-nowrap px-3 text-right text-muted-foreground">{e.universes.length}</td>
          <td className="num whitespace-nowrap px-3 text-right text-muted-foreground">{formatBytes(e.bytes)}</td>
        </>
      )}
      <td className="whitespace-nowrap px-3 text-muted-foreground" title={when.toLocaleString(i18n.language)}>
        <time dateTime={when.toISOString()}>{formatRelativeTime(e.modifiedUnixMs, nowMs, i18n.language)}</time>
      </td>
      <td className="px-2" onClick={(ev) => ev.stopPropagation()}>
        {!renaming && (
          <div className="flex items-center justify-end">
            <ProgramPlayButton
              entry={e}
              actions={actions}
              tabIndex={tab}
              idleClassName="opacity-70 group-hover:bg-primary group-hover:text-primary-foreground group-hover:opacity-100 group-focus-within:opacity-100"
            />
            <ProgramActionsMenu
              entry={e}
              actions={actions}
              tabIndex={tab}
              showDetails={false}
              onRename={() => onStartRename(e.path)}
              onDelete={() => onRequestDelete(e)}
              onDuplicated={onDuplicated}
            />
          </div>
        )}
      </td>
    </tr>
  );
}

/** 行级 memo：只有该节目的数据、选中 / 勾选 / 播放状态变化时才重渲。 */
export const LibraryTableRow = memo(LibraryTableRowImpl);
