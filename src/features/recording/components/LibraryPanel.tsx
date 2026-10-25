import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Play, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isTauri } from "@/shared/tauri/invoke";
import { useEspStatus } from "@/features/esp";
import { usePlayerStore } from "../hooks/usePlayerStore";
import { useRecordingStore } from "../hooks/useRecordingStore";
import {
  espUploadRecording,
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

/** 把任意异常规整为字符串。 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface LibraryPanelProps {
  /** 节目成功打开进入回放后调用（父组件据此切换到回放标签页） */
  onPlayed?: () => void;
}

/**
 * 节目库：列出录制目录里的 `.artrec` 节目，支持回放（进入回放模式前确认）、
 * 重命名、删除（二次确认）与上传到核心板。
 */
export function LibraryPanel({ onPlayed }: LibraryPanelProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { status: esp } = useEspStatus();
  const lastResult = useRecordingStore((s) => s.last);
  const recording = useRecordingStore((s) => s.status.recording);
  const playbackLoaded = usePlayerStore((s) => s.status.loaded);
  const [toPlay, setToPlay] = useState<LibraryEntry | null>(null);
  const [opening, setOpening] = useState(false);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [toDelete, setToDelete] = useState<LibraryEntry | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const list = useQuery({
    queryKey: LIBRARY_KEY,
    queryFn: recordingsList,
    enabled: isTauri(),
    initialData: isTauri() ? undefined : ([] as LibraryEntry[]),
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
      const name = await espUploadRecording(entry.path);
      toast.success(t("recording.libUploaded", { name }));
    } catch (e: unknown) {
      toast.error(t("recording.libUploadFailed", { reason: describeError(e) }));
    } finally {
      setUploading(null);
    }
  };

  const entries = list.data ?? [];

  return (
    <>
      <Card>
        <CardContent className="pt-8">
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("recording.libSummary", { n: entries.length })}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              aria-label={t("recording.libRefresh")}
            >
              <RefreshCw />
              {t("recording.libRefresh")}
            </Button>
          </div>

          <div className="grid grid-cols-[1fr_6rem_5rem_6rem_5rem_12rem] gap-x-4 border-b border-border pb-2 text-xs font-medium text-muted-foreground">
            <span>{t("recording.libColName")}</span>
            <span className="text-right">{t("recording.statDuration")}</span>
            <span className="text-right">{t("recording.statFrames")}</span>
            <span className="text-right">{t("recording.statSize")}</span>
            <span className="text-right">{t("recording.statUniverses")}</span>
            <span className="text-right">{t("recording.libColActions")}</span>
          </div>

          {entries.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t("recording.libEmpty")}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {entries.map((e) => (
                <li
                  key={e.path}
                  className="grid grid-cols-[1fr_6rem_5rem_6rem_5rem_12rem] items-center gap-x-5 py-4.5 text-sm"
                >
                  <div className="min-w-0">
                    {renaming === e.path ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          autoFocus
                          className="h-7"
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
                          className="size-7"
                          aria-label={t("common.ok")}
                          onClick={() => void commitRename(e)}
                        >
                          <Check />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={t("common.cancel")}
                          onClick={() => setRenaming(null)}
                        >
                          <X />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium" title={e.fileName}>
                            {e.name}
                          </span>
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
                  <span className="tabular text-right">{formatDurationUs(e.durationUs)}</span>
                  <span className="tabular text-right">{e.frames}</span>
                  <span className="tabular text-right">{formatBytes(e.bytes)}</span>
                  <span className="tabular text-right">{e.universes.length}</span>
                  <span className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("player.playProgram")}
                      title={t("player.playProgram")}
                      disabled={!e.valid || opening}
                      onClick={() => requestPlay(e)}
                    >
                      <Play className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("recording.libUpload")}
                      title={
                        esp.connected
                          ? t("recording.libUpload")
                          : t("recording.libUploadNeedsEsp")
                      }
                      disabled={!esp.connected || !e.valid || uploading === e.path}
                      onClick={() => void upload(e)}
                    >
                      <Upload className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("recording.libRename")}
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
                      onClick={() => setToDelete(e)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {recording && (
            <p className="mt-3 text-xs text-muted-foreground">{t("recording.libRecordingNote")}</p>
          )}
        </CardContent>
      </Card>

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
