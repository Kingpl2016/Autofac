import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { pickSavePath } from "@/shared/tauri/pickers";
import {
  netdevDeleteFile,
  netdevDownloadFile,
  netdevProgramOp,
  netdevRenameFile,
  netdevSetWorkmode,
  netdevUploadFile,
} from "../lib/api";
import { errorText, toNetError } from "../lib/errors";
import { baseName, findOverwrites, isPlayableMode } from "../lib/files";
import { netKeys } from "../lib/queryKeys";
import { ProgramAction, type NetDevice, type NetFile } from "../lib/types";
import { validateProgramFileName } from "../lib/validate";
import { useTransferStore } from "../stores/useTransferStore";

/** 待上传条目。 */
interface UploadItem {
  path: string;
  name: string;
}

/** 等待用户确认覆盖的上传批次。 */
export interface PendingOverwrite {
  items: UploadItem[];
  /** 设备上会被覆盖的文件名 */
  conflicts: string[];
}

/** 等待用户确认切换到节目模式的播放请求。 */
export interface PendingPlay {
  file: NetFile;
  loop: boolean;
  /** 设备当前工作模式 */
  mode: number;
}

interface Params {
  device: NetDevice;
  /** 设备当前工作模式（来自状态轮询）；未知传 `null` */
  workMode: number | null;
  files: readonly NetFile[];
  refresh: () => unknown;
}

/** 这些错误说明后续文件也不会成功，批量上传时直接中止。 */
const FATAL_CODES = new Set(["unauthorized", "network", "timeout", "not_ready", "no_space", "unknown_device"]);

/**
 * 文件页的全部动作：上传队列（含覆盖确认）、下载、删除、重命名、播放 / 停止。
 *
 * 上传与下载走全局传输队列（可取消、可重试）；其余为即时请求，失败用 toast 提示。
 */
export function useFileActions({ device, workMode, files, refresh }: Params) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const run = useTransferStore((s) => s.run);
  const [pendingOverwrite, setPendingOverwrite] = useState<PendingOverwrite | null>(null);
  const [pendingPlay, setPendingPlay] = useState<PendingPlay | null>(null);
  const id = device.id;
  // 重试需要再次调用 runUploads；经 ref 间接引用，避免回调在声明前引用自己
  const runUploadsRef = useRef<(items: UploadItem[]) => Promise<void>>(async () => undefined);

  const refreshPlayback = useCallback(() => {
    void client.invalidateQueries({ queryKey: netKeys.status(id) });
    void client.invalidateQueries({ queryKey: netKeys.player(id) });
  }, [client, id]);

  const runUploads = useCallback(
    async (items: UploadItem[]) => {
      for (const item of items) {
        try {
          await run(
            {
              kind: "upload",
              deviceId: id,
              label: item.name,
              retry: () => void runUploadsRef.current([item]),
            },
            (onProgress) => netdevUploadFile(id, item.name, item.path, onProgress),
          );
          void refresh();
        } catch (e) {
          // 失败详情已在传输队列里；致命错误不再继续后面的文件
          if (FATAL_CODES.has(toNetError(e).code)) {
            toast.error(`${item.name}: ${errorText(t, e)}`);
            break;
          }
        }
      }
      void refresh();
    },
    [id, refresh, run, t],
  );
  useEffect(() => {
    runUploadsRef.current = runUploads;
  });

  /** 入队一批本地文件：先校验文件名，再确认覆盖，最后顺序上传。 */
  const uploadPaths = useCallback(
    (paths: string[]) => {
      const items: UploadItem[] = [];
      for (const path of paths) {
        const name = baseName(path);
        const bad = validateProgramFileName(name);
        if (bad) toast.error(`${name}: ${t(bad)}`);
        else items.push({ path, name });
      }
      if (items.length === 0) return;
      const conflicts = findOverwrites(
        items.map((i) => i.name),
        files,
      );
      if (conflicts.length > 0) setPendingOverwrite({ items, conflicts });
      else void runUploads(items);
    },
    [files, runUploads, t],
  );

  const confirmOverwrite = useCallback(() => {
    if (pendingOverwrite) void runUploads(pendingOverwrite.items);
    setPendingOverwrite(null);
  }, [pendingOverwrite, runUploads]);

  const download = useCallback(
    async (file: NetFile) => {
      const dest = await pickSavePath(file.name, ["artrec"]);
      if (!dest) return;
      const start = () =>
        run(
          { kind: "download", deviceId: id, label: file.name, retry: () => void start().catch(() => undefined) },
          (onProgress) => netdevDownloadFile(id, file.name, dest, onProgress),
        );
      try {
        await start();
        toast.success(t("network.files.downloaded", { name: file.name }));
      } catch {
        // 失败详情在传输队列里
      }
    },
    [id, run, t],
  );

  const remove = useCallback(
    async (file: NetFile) => {
      try {
        await netdevDeleteFile(id, file.name);
        toast.success(t("network.files.deleted", { name: file.name }));
        void refresh();
        refreshPlayback();
      } catch (e) {
        toast.error(errorText(t, e));
      }
    },
    [id, refresh, refreshPlayback, t],
  );

  const rename = useCallback(
    async (from: string, to: string): Promise<boolean> => {
      const bad = validateProgramFileName(to);
      if (bad) {
        toast.error(t(bad));
        return false;
      }
      try {
        await netdevRenameFile(id, from, to);
        void refresh();
        return true;
      } catch (e) {
        toast.error(errorText(t, e));
        return false;
      }
    },
    [id, refresh, t],
  );

  const playNow = useCallback(
    async (file: NetFile, loop: boolean, switchMode: boolean) => {
      if (file.program === null) return;
      try {
        if (switchMode) await netdevSetWorkmode(id, 4);
        await netdevProgramOp(id, file.program, loop ? ProgramAction.PlayLoop : ProgramAction.PlayOnce);
        toast.success(t(loop ? "network.files.playingLoop" : "network.files.playingOnce", { name: file.name }));
      } catch (e) {
        toast.error(errorText(t, e));
      } finally {
        refreshPlayback();
      }
    },
    [id, refreshPlayback, t],
  );

  /** 请求播放：工作模式不允许时先弹确认，确认后切到节目模式再播放。 */
  const requestPlay = useCallback(
    (file: NetFile, loop: boolean) => {
      if (workMode === null || isPlayableMode(workMode)) void playNow(file, loop, false);
      else setPendingPlay({ file, loop, mode: workMode });
    },
    [playNow, workMode],
  );

  const confirmPlay = useCallback(() => {
    if (pendingPlay) void playNow(pendingPlay.file, pendingPlay.loop, true);
    setPendingPlay(null);
  }, [pendingPlay, playNow]);

  const stop = useCallback(
    async (file: NetFile) => {
      if (file.program === null) return;
      try {
        await netdevProgramOp(id, file.program, ProgramAction.Stop);
      } catch (e) {
        toast.error(errorText(t, e));
      } finally {
        refreshPlayback();
      }
    },
    [id, refreshPlayback, t],
  );

  return {
    uploadPaths,
    pendingOverwrite,
    confirmOverwrite,
    cancelOverwrite: () => setPendingOverwrite(null),
    download,
    remove,
    rename,
    requestPlay,
    pendingPlay,
    confirmPlay,
    cancelPlay: () => setPendingPlay(null),
    stop,
  };
}
