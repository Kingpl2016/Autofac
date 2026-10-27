import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { ProgramActionsMenu } from "./ProgramActionsMenu";
import { ProgramDeleteDialog } from "./ProgramDeleteDialog";
import { ProgramPlayButton } from "./ProgramPlayButton";
import { ProgramRenameInput } from "./ProgramRenameInput";
import { ProgramStatusBadges } from "./ProgramStatusBadges";
import { ProgramThumb } from "./ProgramThumb";
import { useProgramActions } from "../hooks/useProgramActions";
import { usePlayerStore } from "../stores/usePlayerStore";
import { useRecordingStore } from "../stores/useRecordingStore";
import { RECORDINGS_QUERY_KEY, recordingsList } from "../lib/api";
import { formatBytes, formatDurationUs } from "../lib/filter";
import { libraryHref } from "../lib/libraryRoutes";
import { hasProgramFlags } from "../lib/programFlags";
import type { LibraryEntry } from "../lib/types";

/** 入场交错的最大档位与步长（毫秒），超过后不再递增以免长列表显得迟钝。 */
const STAGGER_MAX_STEPS = 8;
const STAGGER_STEP_MS = 30;

/** 节目是否匹配搜索词（名称 / 文件名 / 备注 / 来源）。 */
function matchesQuery(e: LibraryEntry, q: string): boolean {
  if (!q) return true;
  const hay = [e.name, e.fileName, e.notes, ...e.sources].join("\n").toLowerCase();
  return hay.includes(q);
}

interface LibraryPanelProps {
  /** 节目成功打开进入回放后调用（父组件据此切换到回放模式） */
  onPlayed?: () => void;
}

/**
 * 节目库侧栏：以紧凑的编号行列出录制目录里的 `.artrec` 节目
 * （序号、迷你热力图、名称 + 状态、时长 · Universe 数 · 大小、回放按钮、“⋯”菜单）。
 * 完整信息（文件名、时间、来源、备注、帧数、格式）在名称的悬停提示和菜单顶部；
 * 编辑、编辑导出、上传、重命名、复制、在节目库中查看、删除（二次确认）收在“⋯”菜单里。
 * 完整的表格视图与批量操作在节目库页面（`/library`）。
 *
 * 回放走统一的模式切换（`useProgramActions` → `useModeActions`）：实时模式下点击回放会先弹出
 * “进入播放器模式？”确认，确认后由后端 `player_open` 自动进入播放器模式；已在播放器模式则直接切换节目。
 */
export function LibraryPanel({ onPlayed }: LibraryPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const actions = useProgramActions(onPlayed);
  const lastResult = useRecordingStore((s) => s.last);
  const recording = useRecordingStore((s) => s.status.recording);
  const repeat = usePlayerStore((s) => (s.status.loaded ? s.status.repeat : "off"));
  const { loadedPath: playingPath, loadedState } = actions;

  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<LibraryEntry | null>(null);

  const list = useQuery({
    queryKey: RECORDINGS_QUERY_KEY,
    queryFn: recordingsList,
  });

  // 一次录制结束后自动刷新列表
  useEffect(() => {
    if (lastResult) void client.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
  }, [lastResult, client]);

  const commitRename = (entry: LibraryEntry, next: string) => {
    setRenaming(null);
    void actions.rename(entry, next);
  };

  // 刚结束的这次录制产生的文件，在列表里标出“刚录制”
  const freshPaths = useMemo(
    () => new Set(lastResult?.files.map((f) => f.path.replaceAll("\\", "/")) ?? []),
    [lastResult],
  );
  const entries = useMemo(() => list.data ?? [], [list.data]);
  // 序号按节目在整个库里的位置（从 1 起），搜索过滤时不重新编号
  const indexOf = useMemo(() => new Map(entries.map((e, i) => [e.path, i + 1])), [entries]);
  // 连播时的“下一个”：与后端 `next_in_library` 同序（列表里紧随其后的有效节目）
  const nextPath = useMemo(() => {
    if (repeat !== "playlist" || !playingPath) return "";
    const i = entries.findIndex((e) => e.path === playingPath);
    if (i < 0) return "";
    return entries.slice(i + 1).find((e) => e.valid)?.path ?? "";
  }, [repeat, playingPath, entries]);

  // 切换到新节目（含连播自动切换）时，把播放中的卡片滚进可视区；不抢焦点，尊重减少动效偏好
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (!playingPath) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    itemRefs.current
      .get(playingPath)
      ?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [playingPath]);
  // 一次录制结束、列表刷新出新节目后，把第一个“刚录制”的节目滚进可视区（每次结果只滚一次）
  const scrolledFor = useRef<typeof lastResult>(null);
  useEffect(() => {
    if (!lastResult || scrolledFor.current === lastResult) return;
    const fresh = entries.find((e) => freshPaths.has(e.path.replaceAll("\\", "/")));
    const el = fresh ? itemRefs.current.get(fresh.path) : undefined;
    if (!el) return;
    scrolledFor.current = lastResult;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [lastResult, entries, freshPaths]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => entries.filter((e) => matchesQuery(e, needle)),
    [entries, needle],
  );

  return (
    <>
      <SurfacePanel
        title={t("recording.tabLibrary")}
        actions={
          <>
            <span className="text-xs text-muted-foreground">
              {t("recording.libSummary", { n: entries.length })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              onClick={actions.refresh}
              aria-label={t("recording.libRefresh")}
              title={t("recording.libRefresh")}
            >
              <RefreshCw />
            </Button>
          </>
        }
      >
        <div className="relative mb-3">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            className="pl-9"
            value={query}
            placeholder={t("recording.libSearch")}
            aria-label={t("recording.libSearch")}
            onChange={(ev) => setQuery(ev.target.value)}
          />
        </div>

        {entries.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t("recording.libEmpty")}
          </div>
        ) : shown.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t("recording.libNoMatch")}
          </div>
        ) : (
          <ol className="grid max-h-[calc(100dvh-16rem)] gap-1 overflow-y-auto pr-1" aria-label={t("recording.tabLibrary")}>
            {shown.map((e, i) => {
              const isLoaded = e.path === playingPath;
              const isPlaying = isLoaded && loadedState === "playing";
              const no = indexOf.get(e.path) ?? i + 1;
              const isNext = e.path === nextPath;
              const isFresh = freshPaths.has(e.path.replaceAll("\\", "/"));
              const meta = t("recording.libMeta", {
                frames: e.frames,
                size: formatBytes(e.bytes),
                n: e.universes.length,
              });
              const when = new Date(e.modifiedUnixMs).toLocaleString();
              // 完整信息收在名称的悬停提示和“⋯”菜单顶部，列表本身只显示一行名称 + 一行摘要
              const details = [e.fileName, [when, ...e.sources].join(" · "), e.notes, meta].filter(Boolean).join("\n");
              const hasFlags = hasProgramFlags(e, isNext, isFresh);
              return (
                <li
                  key={e.path}
                  ref={(el) => {
                    if (el) itemRefs.current.set(e.path, el);
                    else itemRefs.current.delete(e.path);
                  }}
                  aria-current={isLoaded ? "true" : undefined}
                  className={cn(
                    "group animate-fade-up rounded-lg border transition-colors duration-150 motion-reduce:transition-none",
                    isPlaying
                      ? "border-success/45 bg-success/5"
                      : isLoaded
                        ? "border-primary/40 bg-primary/5"
                        : isFresh
                          ? "border-recording/35 bg-recording/5"
                          : "border-transparent hover:bg-surface-3/50",
                  )}
                  style={{ animationDelay: `${Math.min(i, STAGGER_MAX_STEPS) * STAGGER_STEP_MS}ms` }}
                >
                  <div className="flex items-center gap-2.5 px-2 py-1.5">
                    {/* 序号：节目在库里的位置（搜索时保持不变，方便口头沟通“第 3 个”） */}
                    <span
                      className={cn(
                        "num w-6 shrink-0 text-right text-xs font-semibold",
                        isLoaded ? (isPlaying ? "text-success" : "text-primary") : "text-muted-foreground",
                      )}
                    >
                      {String(no).padStart(2, "0")}
                    </span>
                    <ProgramThumb path={e.path} valid={e.valid} className="h-9 w-14 shrink-0 rounded-md" />

                    <div className="min-w-0 flex-1">
                      {renaming === e.path ? (
                        <ProgramRenameInput
                          initial={e.name}
                          onCommit={(next) => commitRename(e, next)}
                          onCancel={() => setRenaming(null)}
                        />
                      ) : (
                        <>
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-medium" title={details}>
                              {e.name}
                            </span>
                            {/* 徽章如实反映播放状态：打开了但没在播时不再显示“回放中” */}
                            {isPlaying && <Badge variant="success" className="shrink-0">{t("player.live")}</Badge>}
                            {isLoaded && loadedState === "paused" && (
                              <Badge variant="warning" className="shrink-0">{t("player.statePaused")}</Badge>
                            )}
                            {isLoaded && loadedState === "stopped" && (
                              <Badge variant="outline" className="shrink-0">{t("recording.libOpened")}</Badge>
                            )}
                          </div>
                          <div className="num truncate text-xs text-muted-foreground">
                            {formatDurationUs(e.durationUs)} · {t("recording.libUniverses", { n: e.universes.length })} ·{" "}
                            {formatBytes(e.bytes)}
                          </div>
                        </>
                      )}
                    </div>

                    {renaming !== e.path && (
                      <div className="flex shrink-0 items-center">
                        <ProgramPlayButton
                          entry={e}
                          actions={actions}
                          idleClassName="group-hover:bg-primary group-hover:text-primary-foreground group-focus-within:bg-primary group-focus-within:text-primary-foreground"
                        />
                        <ProgramActionsMenu
                          entry={e}
                          actions={actions}
                          onRename={() => setRenaming(e.path)}
                          onDelete={() => setToDelete(e)}
                          onShowInLibrary={() => void navigate(libraryHref(e.path))}
                        />
                      </div>
                    )}
                  </div>

                  {hasFlags && renaming !== e.path && (
                    <div className="flex flex-wrap items-center gap-1 pb-2 pl-[6.125rem] pr-2">
                      <ProgramStatusBadges entry={e} isNext={isNext} isFresh={isFresh} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {recording && (
          <p className="mt-3 text-xs text-muted-foreground">{t("recording.libRecordingNote")}</p>
        )}
      </SurfacePanel>

      <ProgramDeleteDialog
        entry={toDelete}
        onCancel={() => setToDelete(null)}
        onConfirm={(entry) => void actions.remove(entry)}
      />
    </>
  );
}
