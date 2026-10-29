import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { errorMessage } from "@/shared/lib/errors";
import { useAppModeStore, useModeActions } from "@/features/app-mode";
import {
  errorText as netErrorText,
  netdevUploadRecording,
  useActiveDevice,
  useDeviceStatus,
  useTransferStore,
} from "@/features/network";
import {
  playerOpen,
  playerPause,
  playerPlay,
  recordingsDelete,
  recordingsDuplicate,
  recordingsRename,
  recordingsSetNotes,
} from "../lib/api";
import { editorHref, programEditHref } from "../lib/libraryRoutes";
import { invalidateProgramCaches } from "../lib/programCaches";
import {
  LIB_ERR_CANCELLED,
  LIB_ERR_EDITABLE_REPLACE,
  LIB_ERR_EMPTY_EDIT,
  LIB_ERR_EXISTS,
  LIB_ERR_IN_USE,
  LIB_ERR_NOT_FOUND,
  LIB_ERR_OUTSIDE,
  LIB_ERR_TRASH,
  PLAYER_ERR_BAD_PATH,
  PLAYER_ERR_NO_PLAYER,
  PLAYER_ERR_RECORDING_ACTIVE,
  PLAYER_ERR_SHOW_ACTIVE,
  type LibraryEntry,
} from "../lib/types";
import { usePlayerStore } from "../stores/usePlayerStore";


/**
 * 节目操作（节目库侧栏与节目库页面共用）：回放 / 暂停、重命名、删除、复制、改备注、
 * 上传到网络设备、跳转到编辑器或编辑导出页，以及统一的错误文案。
 *
 * 每个操作自己负责提示（成功 / 失败 toast）与刷新节目库列表，调用方只关心返回值：
 * 成功时给出结果（新路径 / `true`），失败时给出 `null` / `false`。
 *
 * @param onPlayed 节目成功打开进入回放后调用。
 * @param options.stayOnPage 回放时留在当前页面直接播放，不跳转到播放器页（节目库页面使用）。
 */
export function useProgramActions(onPlayed?: () => void, options: { stayOnPage?: boolean } = {}) {
  const stayOnPage = options.stayOnPage ?? false;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { device: netDevice } = useActiveDevice();
  const netStatus = useDeviceStatus(netDevice?.id ?? null);
  const canUpload = netDevice !== null && netStatus.online;
  const transitioning = useAppModeStore((s) => s.transitioning);
  const { requestMode } = useModeActions();
  // “已打开”的节目（不一定在播放）与它的播放状态
  const loadedPath = usePlayerStore((s) => (s.status.loaded ? s.status.path : ""));
  const loadedState = usePlayerStore((s) => (s.status.loaded ? s.status.state : null));
  const [uploading, setUploading] = useState<string | null>(null);

  const refresh = useCallback(() => void invalidateProgramCaches(client), [client]);

  const describeError = useCallback(
    (e: unknown): string => {
      const raw = errorMessage(e);
      if (raw === LIB_ERR_EXISTS) return t("recording.libErrExists");
      if (raw === LIB_ERR_OUTSIDE) return t("recording.libErrOutside");
      if (raw === LIB_ERR_NOT_FOUND) return t("recording.libErrNotFound");
      if (raw === LIB_ERR_EMPTY_EDIT) return t("library.errEmptyEdit");
      if (raw === LIB_ERR_EDITABLE_REPLACE) return t("library.errEditableReplace");
      if (raw === LIB_ERR_IN_USE) return t("library.errInUse");
      if (raw === LIB_ERR_CANCELLED) return t("library.errCancelled");
      // 后端格式为 `trash_failed: <系统给出的原因>`；此时文件原样保留，不会被永久删除
      if (raw.startsWith(LIB_ERR_TRASH)) {
        return t("recording.libErrTrash", { reason: raw.slice(LIB_ERR_TRASH.length).replace(/^:\s*/, "") });
      }
      return raw;
    },
    [t],
  );

  /** 把打开节目失败的原因说得比“切换模式失败”更具体。 */
  const describeOpenError = useCallback(
    (e: unknown): string => {
      const raw = errorMessage(e);
      if (raw === PLAYER_ERR_RECORDING_ACTIVE) return t("player.errRecordingActive");
      if (raw === PLAYER_ERR_SHOW_ACTIVE) return t("player.errShowActive");
      if (raw === PLAYER_ERR_BAD_PATH) return t("recording.libErrOutside");
      return t("player.openFailed", { reason: describeError(e) });
    },
    [t, describeError],
  );

  /** 重命名；名称为空或未变化时什么也不做。返回新路径，失败或未改名返回 `null`。 */
  const rename = useCallback(
    async (entry: LibraryEntry, nextName: string): Promise<string | null> => {
      const next = nextName.trim();
      if (!next || next === entry.name) return null;
      try {
        const path = await recordingsRename(entry.path, next);
        refresh();
        return path;
      } catch (e: unknown) {
        toast.error(describeError(e));
        return null;
      }
    },
    [describeError, refresh],
  );

  /** 删除（移入回收站）而不提示：成功返回 `null`，失败返回可读的原因（批量删除自己汇总）。 */
  const removeQuiet = useCallback(
    async (entry: LibraryEntry): Promise<string | null> => {
      try {
        await recordingsDelete(entry.path);
        return null;
      } catch (e: unknown) {
        return describeError(e);
      } finally {
        refresh();
      }
    },
    [describeError, refresh],
  );

  /** 删除（移入回收站）并提示结果。 */
  const remove = useCallback(
    async (entry: LibraryEntry): Promise<boolean> => {
      const error = await removeQuiet(entry);
      if (error === null) toast.success(t("recording.libDeleted", { name: entry.name }));
      else toast.error(error);
      return error === null;
    },
    [removeQuiet, t],
  );

  /** 创建副本（名称为“X 副本”，重名时后端自动编号）；返回副本路径。 */
  const duplicate = useCallback(
    async (entry: LibraryEntry): Promise<string | null> => {
      try {
        const path = await recordingsDuplicate(entry.path, t("library.copyName", { name: entry.name }));
        toast.success(t("library.duplicated", { name: entry.name }));
        refresh();
        return path;
      } catch (e: unknown) {
        toast.error(describeError(e));
        return null;
      }
    },
    [describeError, refresh, t],
  );

  /** 保存备注。 */
  const setNotes = useCallback(
    async (entry: LibraryEntry, notes: string): Promise<boolean> => {
      try {
        await recordingsSetNotes(entry.path, notes);
        toast.success(t("library.notesSaved"));
        refresh();
        return true;
      } catch (e: unknown) {
        toast.error(describeError(e));
        return false;
      }
    },
    [describeError, refresh, t],
  );

  /**
   * 请求回放：统一走模式切换（实时模式下先确认；已在播放器模式则直接换节目），打开后立即开始播放。
   */
  const requestPlay = useCallback(
    (entry: LibraryEntry) =>
      requestMode("player", {
        run: async () => {
          await playerOpen(entry.path);
          await playerPlay();
          onPlayed?.();
        },
        describeError: describeOpenError,
        stay: stayOnPage,
      }),
    [requestMode, describeOpenError, onPlayed, stayOnPage],
  );

  /** 已打开节目的主按钮：播放中则暂停，暂停 / 停止则继续播放（不重新打开、不回到开头）。 */
  const toggleLoaded = useCallback(async () => {
    try {
      if (loadedState === "playing") await playerPause();
      else await playerPlay();
    } catch (e: unknown) {
      const raw = errorMessage(e);
      toast.error(raw === PLAYER_ERR_NO_PLAYER ? t("player.errNoPlayer") : raw);
    }
  }, [loadedState, t]);

  /** 上传到当前选中的网络设备（走全局传输队列：有进度、可取消，切换页面也不会中断）。 */
  const upload = useCallback(
    async (entry: LibraryEntry) => {
      if (!netDevice) return;
      setUploading(entry.path);
      try {
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
    },
    [netDevice, t],
  );

  const openInEditor = useCallback((entry: LibraryEntry) => void navigate(editorHref(entry.path)), [navigate]);
  const openEditExport = useCallback(
    (entry: LibraryEntry) => void navigate(programEditHref(entry.path)),
    [navigate],
  );

  // 引用稳定：表格行按引用比较 props，播放状态等真正变化时才整体换新
  return useMemo(
    () => ({
      loadedPath,
      loadedState,
      transitioning,
      canUpload,
      uploading,
      refresh,
      describeError,
      rename,
      remove,
      removeQuiet,
      duplicate,
      setNotes,
      requestPlay,
      toggleLoaded,
      upload,
      openInEditor,
      openEditExport,
    }),
    [
      loadedPath,
      loadedState,
      transitioning,
      canUpload,
      uploading,
      refresh,
      describeError,
      rename,
      remove,
      removeQuiet,
      duplicate,
      setNotes,
      requestPlay,
      toggleLoaded,
      upload,
      openInEditor,
      openEditExport,
    ],
  );
}

/** {@link useProgramActions} 的返回值。 */
export type ProgramActions = ReturnType<typeof useProgramActions>;
