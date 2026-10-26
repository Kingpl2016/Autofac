import { useEffect, useMemo, useRef, useState } from "react";
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
import { useAppModeStore, useModeActions } from "@/features/app-mode";
import {
  errorText as netErrorText,
  netdevUploadRecording,
  useActiveDevice,
  useDeviceStatus,
  useTransferStore,
} from "@/features/network";
import { SurfacePanel } from "../../../shared/components/SurfacePanel";
import { ProgramThumb } from "./ProgramThumb";
import { usePlayerStore } from "../stores/usePlayerStore";
import { useRecordingStore } from "../stores/useRecordingStore";
import {
  playerOpen,
  recordingsDelete,
  recordingsList,
  recordingsRename,
} from "../lib/api";
import { formatBytes, formatDurationUs } from "../lib/filter";
import {
  LIB_ERR_EXISTS,
  LIB_ERR_NOT_FOUND,
  LIB_ERR_OUTSIDE,
  LIB_ERR_TRASH,
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
 * 支持搜索、回放、重命名、删除（二次确认）与上传到当前网络设备。
 *
 * 回放走统一的模式切换（`useModeActions`）：实时模式下点击回放会先弹出“进入播放器模式？”确认，
 * 确认后（必要时先停止录制）由后端 `player_open` 自动进入播放器模式；已在播放器模式则直接切换节目。
 */
export function LibraryPanel({ onPlayed }: LibraryPanelProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { device: netDevice } = useActiveDevice();
  const netStatus = useDeviceStatus(netDevice?.id ?? null);
  const canUpload = netDevice !== null && netStatus.online;
  const lastResult = useRecordingStore((s) => s.last);
  const recording = useRecordingStore((s) => s.status.recording);
  const transitioning = useAppModeStore((s) => s.transitioning);
  const { requestMode } = useModeActions();
  const playingPath = usePlayerStore((s) => (s.status.loaded ? s.status.path : ""));
  const repeat = usePlayerStore((s) => (s.status.loaded ? s.status.repeat : "off"));

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
    // 后端格式为 `trash_failed: <系统给出的原因>`；此时文件原样保留，不会被永久删除
    if (raw.startsWith(LIB_ERR_TRASH)) {
      return t("recording.libErrTrash", { reason: raw.slice(LIB_ERR_TRASH.length).replace(/^:\s*/, "") });
    }
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

  /** 把打开节目失败的原因说得比“切换模式失败”更具体。 */
  const describeOpenError = (e: unknown): string => {
    const raw = messageOf(e);
    if (raw === PLAYER_ERR_RECORDING_ACTIVE) return t("player.errRecordingActive");
    if (raw === PLAYER_ERR_BAD_PATH) return t("recording.libErrOutside");
    return t("player.openFailed", { reason: describeError(e) });
  };

  /** 请求回放：统一走模式切换（实时模式下先确认；已在播放器模式则直接换节目）。 */
  const requestPlay = (entry: LibraryEntry) =>
    requestMode("player", {
      run: async () => {
        await playerOpen(entry.path);
        onPlayed?.();
      },
      describeError: describeOpenError,
    });

  const upload = async (entry: LibraryEntry) => {
    if (!netDevice) return;
    setUploading(entry.path);
    try {
      // 走全局传输队列：有进度、可取消，切换页面也不会中断
      const name = await useTransferStore.getState().run(
        { kind: "upload", deviceId: netDevice.id, label: entry.fileName },
        (onProgress) => netdevUploadRecording(netDevice.id, entry.path, onProgress),
      );
      toast.success(t("recording.libUploaded", { name }));
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== "cancelled") {
        toast.error(t("recording.libUploadFailed", { reason: netErrorText(t, e) }));
      }
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
                  ref={(el) => {
                    if (el) itemRefs.current.set(e.path, el);
                    else itemRefs.current.delete(e.path);
                  }}
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
                          {e.path === nextPath && (
                            <Badge variant="outline">{t("recording.libNext")}</Badge>
                          )}
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
                      disabled={!e.valid || transitioning}
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
                        canUpload
                          ? t("recording.libUpload")
                          : t("recording.libUploadNeedsDevice")
                      }
                      disabled={!canUpload || !e.valid || uploading === e.path}
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
