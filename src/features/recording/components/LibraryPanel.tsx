import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Play, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { controllerUploadRecording, useControllerStatus } from "@/features/controller";
import { SurfacePanel } from "./console/SurfacePanel";
import { ProgramThumb } from "./ProgramThumb";
import { usePlayerStore } from "../stores/usePlayerStore";
import { useRecordingStore } from "../stores/useRecordingStore";
import {
  playerOpen,
  recordingStop,
  recordingsDelete,
  recordingsList,
  recordingsRename,
} from "../lib/api";
import { formatBytes, formatDurationUs } from "../lib/filter";
import {
  LIB_ERR_EXISTS,
  LIB_ERR_NOT_FOUND,
  LIB_ERR_OUTSIDE,
  PLAYER_ERR_BAD_PATH,
  PLAYER_ERR_RECORDING_ACTIVE,
  type LibraryEntry,
} from "../lib/types";

const LIBRARY_KEY = ["recordings"] as const;
/** 入场交错的最大档位与步长（毫秒），超过后不再递增以免长列表显得迟钝。 */
const STAGGER_MAX_STEPS = 8;
const STAGGER_STEP_MS = 30;

/** 把任意异常规整为字符串。 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
 * 节目库侧栏：以卡片列出录制目录里的 `.artrec` 节目（含迷你热力图缩略图），
 * 支持搜索、回放（进入回放模式前确认）、重命名、删除（二次确认）与上传到核心板。
 */
export function LibraryPanel({ onPlayed }: LibraryPanelProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { status: controller } = useControllerStatus();
  const lastResult = useRecordingStore((s) => s.last);
  const recording = useRecordingStore((s) => s.status.recording);
  const playbackLoaded = usePlayerStore((s) => s.status.loaded);
  const playingPath = usePlayerStore((s) => (s.status.loaded ? s.status.path : ""));
  const [toPlay, setToPlay] = useState<LibraryEntry | null>(null);
  const [opening, setOpening] = useState(false);

  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [toDelete, setToDelete] = useState<LibraryEntry | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const list = useQuery({
    queryKey: LIBRARY_KEY,
    queryFn: recordingsList,
  });

  // 一次录制结束后自动刷新列表
  useEffect(() => {
    if (lastResult) void client.invalidateQueries({ queryKey: LIBRARY_KEY });
  }, [lastResult, client]);

  const refresh = () => void client.invalidateQueries({ queryKey: LIBRARY_KEY });

  const describeError = (e: unknown): string => {
    const raw = messageOf(e);
    if (raw === LIB_ERR_EXISTS) return t("recording.libErrExists");
    if (raw === LIB_ERR_OUTSIDE) return t("recording.libErrOutside");
    if (raw === LIB_ERR_NOT_FOUND) return t("recording.libErrNotFound");
    return raw;
  };

  const commitRename = async (entry: LibraryEntry) => {
    const next = draft.trim();
    setRenaming(null);
    if (!next || next === entry.name) return;
    try {
      await recordingsRename(entry.path, next);
      refresh();
    } catch (e: unknown) {
      toast.error(describeError(e));
    }
  };

  const confirmDelete = async () => {
    const entry = toDelete;
    setToDelete(null);
    if (!entry) return;
    try {
      await recordingsDelete(entry.path);
      toast.success(t("recording.libDeleted", { name: entry.name }));
      refresh();
    } catch (e: unknown) {
      toast.error(describeError(e));
    }
  };

  /** 请求回放：已在回放模式时直接切换节目，否则先确认（进入回放会暂停实时接收）。 */
  const requestPlay = (entry: LibraryEntry) => {
    if (playbackLoaded && !recording) void doPlay(entry);
    else setToPlay(entry);
  };

  const doPlay = async (entry: LibraryEntry) => {
    setToPlay(null);
    setOpening(true);
    try {
      // 录制进行中：先停止并保存，再进入回放
      if (recording) await recordingStop();
      await playerOpen(entry.path);
      onPlayed?.();
    } catch (e: unknown) {
      const raw = messageOf(e);
      if (raw === PLAYER_ERR_RECORDING_ACTIVE) toast.error(t("player.errRecordingActive"));
      else if (raw === PLAYER_ERR_BAD_PATH) toast.error(t("recording.libErrOutside"));
      else toast.error(t("player.openFailed", { reason: describeError(e) }));
    } finally {
      setOpening(false);
    }
  };

  const upload = async (entry: LibraryEntry) => {
    setUploading(entry.path);
    try {
      const name = await controllerUploadRecording(entry.path);
      toast.success(t("recording.libUploaded", { name }));
    } catch (e: unknown) {
      toast.error(t("recording.libUploadFailed", { reason: describeError(e) }));
    } finally {
      setUploading(null);
    }
  };

  // 刚结束的这次录制产生的文件，在列表里标出“刚录制”
  const freshPaths = useMemo(
    () => new Set(lastResult?.files.map((f) => f.path.replaceAll("\\", "/")) ?? []),
    [lastResult],
  );
  const entries = useMemo(() => list.data ?? [], [list.data]);
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
              onClick={refresh}
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
          <ul className="grid max-h-[calc(100dvh-16rem)] gap-3 overflow-y-auto pr-1">
            {shown.map((e, i) => {
              const isPlaying = e.path === playingPath;
              return (
                <li
                  key={e.path}
                  className={cn(
                    "group animate-fade-up grid gap-2.5 rounded-xl border bg-surface-1/60 p-2.5 transition-colors hover:bg-surface-3/50",
                    isPlaying ? "border-success/50 glow-success" : "border-transparent",
                  )}
                  style={{ animationDelay: `${Math.min(i, STAGGER_MAX_STEPS) * STAGGER_STEP_MS}ms` }}
                >
                  <ProgramThumb path={e.path} valid={e.valid}>
                    <span className="num absolute right-1.5 bottom-1.5 rounded bg-background/80 px-1.5 py-0.5 text-[0.7rem] font-semibold">
                      {formatDurationUs(e.durationUs)}
                    </span>
                  </ProgramThumb>

                  <div className="min-w-0">
                    {renaming === e.path ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          autoFocus
                          className="h-9"
                          aria-label={t("recording.libRename")}
                          value={draft}
                          onChange={(ev) => setDraft(ev.target.value)}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") void commitRename(e);
                            if (ev.key === "Escape") setRenaming(null);
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-9 shrink-0"
                          aria-label={t("common.ok")}
                          onClick={() => void commitRename(e)}
                        >
                          <Check />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-9 shrink-0"
                          aria-label={t("common.cancel")}
                          onClick={() => setRenaming(null)}
                        >
                          <X />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold" title={e.fileName}>
                            {e.name}
                          </span>
                          {isPlaying && <Badge variant="success">{t("player.live")}</Badge>}
                          {freshPaths.has(e.path.replaceAll("\\", "/")) && (
                            <Badge>{t("recording.libNew")}</Badge>
                          )}
                          {!e.valid && (
                            <Badge variant="destructive">{t("recording.libInvalid")}</Badge>
                          )}
                          {e.recovered && (
                            <Badge variant="warning">{t("recording.libRecovered")}</Badge>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {new Date(e.modifiedUnixMs).toLocaleString()}
                          {e.sources.length > 0 && ` · ${e.sources.join(", ")}`}
                          {e.notes && ` · ${e.notes}`}
                        </div>
                      </>
                    )}
                  </div>

                  <p className="num text-xs text-muted-foreground">
                    {t("recording.libMeta", {
                      frames: e.frames,
                      size: formatBytes(e.bytes),
                      n: e.universes.length,
                    })}
                  </p>

                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mr-auto group-hover:bg-primary group-hover:text-primary-foreground group-focus-within:bg-primary group-focus-within:text-primary-foreground"
                      aria-label={t("player.playProgram")}
                      title={t("player.playProgram")}
                      disabled={!e.valid || opening}
                      onClick={() => requestPlay(e)}
                    >
                      <Play className="fill-current" />
                      {t("recording.tabPlayer")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("recording.libUpload")}
                      title={
                        controller.connected
                          ? t("recording.libUpload")
                          : t("recording.libUploadNeedsController")
                      }
                      disabled={!controller.connected || !e.valid || uploading === e.path}
                      onClick={() => void upload(e)}
                    >
                      <Upload className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("recording.libRename")}
                      title={t("recording.libRename")}
                      onClick={() => {
                        setDraft(e.name);
                        setRenaming(e.path);
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("common.delete")}
                      title={t("common.delete")}
                      onClick={() => setToDelete(e)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {recording && (
          <p className="mt-3 text-xs text-muted-foreground">{t("recording.libRecordingNote")}</p>
        )}
      </SurfacePanel>

      <Dialog open={toPlay !== null} onOpenChange={(o) => !o && setToPlay(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("player.enterTitle")}</DialogTitle>
            <DialogDescription>
              {recording ? t("player.enterDescRecording") : t("player.enterDesc")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToPlay(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => toPlay && void doPlay(toPlay)}>
              {recording ? t("player.enterStopAndPlay") : t("player.enterConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("recording.libDeleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("recording.libDeleteDesc", { name: toDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
