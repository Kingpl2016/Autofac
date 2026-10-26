import { useEffect, useRef, useState } from "react";
import { FilePlus2, HardDrive, RefreshCw, UploadCloud } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { listenFileDrop } from "@/shared/tauri/dragDrop";
import { pickArtrecFiles } from "@/shared/tauri/pickers";
import { cn } from "@/lib/utils";
import { useDeviceFiles } from "../../hooks/useDeviceFiles";
import { useFileActions } from "../../hooks/useFileActions";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { errorText } from "../../lib/errors";
import { filePlayState, sortFiles } from "../../lib/files";
import type { NetDevice, NetFile } from "../../lib/types";
import { FileRow } from "./FileRow";

interface FilesTabProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 文件操作：设备 SD 卡文件列表，上传（选择 / 拖放）、播放、下载、重命名、删除。
 */
export function FilesTab({ device, access }: FilesTabProps) {
  const { t } = useTranslation();
  const { files, isLoading, isFetching, error, refresh } = useDeviceFiles(device.id, access.canRead);
  const sdMounted = access.status.status?.sdMounted ?? true;
  const workMode = access.status.status?.workMode ?? null;
  const player = access.status.status?.player ?? null;
  const actions = useFileActions({ device, workMode, files, refresh });
  const [hovering, setHovering] = useState(false);
  const [deleting, setDeleting] = useState<NetFile | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const sorted = sortFiles(files);
  const canWrite = access.canWrite && sdMounted;

  // 系统文件拖放：Tauri 会拦截原生拖放，只能用 webview 事件拿到本地路径
  const uploadRef = useRef(actions.uploadPaths);
  useEffect(() => {
    uploadRef.current = actions.uploadPaths;
  });
  useEffect(() => {
    if (!canWrite) return;
    let off: (() => void) | undefined;
    let disposed = false;
    listenFileDrop({ onHover: setHovering, onDrop: (paths) => uploadRef.current(paths) })
      .then((fn) => {
        if (disposed) fn();
        else off = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, [canWrite]);

  const pick = async () => {
    const paths = await pickArtrecFiles();
    if (paths.length > 0) actions.uploadPaths(paths);
  };

  return (
    <div className="grid gap-(--density-gutter)">
      <section
        aria-label={t("network.files.uploadTitle")}
        className={cn(
          "flex flex-wrap items-center gap-4 rounded-xl border-2 border-dashed px-5 py-4 transition-colors",
          hovering ? "border-primary bg-primary/10" : "border-border bg-surface-2",
          !canWrite && "opacity-60",
        )}
      >
        <UploadCloud className={cn("size-6 shrink-0", hovering ? "text-primary" : "text-muted-foreground")} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {hovering ? t("network.files.dropRelease") : t("network.files.dropHint")}
          </p>
          <p className="text-xs text-muted-foreground">
            {canWrite ? t("network.files.dropSub") : t(sdMounted ? "network.files.readOnlyHint" : "network.files.sdMissing")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void pick()} disabled={!canWrite}>
          <FilePlus2 />
          {t("network.files.choose")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          disabled={!access.canRead || isFetching}
          aria-label={t("network.files.refresh")}
        >
          <RefreshCw className={cn(isFetching && "animate-spin motion-reduce:animate-none")} />
          {t("network.files.refresh")}
        </Button>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface-2 panel-edge">
        <div
          className="grid grid-cols-[minmax(0,1fr)_4.5rem_6rem_auto] items-center gap-x-4 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground"
          role="row"
        >
          <span>{t("network.files.colName")}</span>
          <span className="text-right">{t("network.files.colProgram")}</span>
          <span className="text-right">{t("network.files.colSize")}</span>
          <span className="w-[13.5rem] text-right">{t("network.files.colActions")}</span>
        </div>

        {isLoading ? (
          <ul aria-busy="true" aria-label={t("common.loading")}>
            {[0, 1, 2].map((i) => (
              <li key={i} className="mx-4 my-3 h-5 animate-pulse rounded bg-surface-1 motion-reduce:animate-none" />
            ))}
          </ul>
        ) : error ? (
          <EmptyState
            title={t("network.files.loadFailed")}
            body={errorText(t, error)}
            action={
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                {t("network.access.retry")}
              </Button>
            }
          />
        ) : !sdMounted ? (
          <EmptyState title={t("network.files.sdMissing")} body={t("network.files.sdMissingBody")} />
        ) : sorted.length === 0 ? (
          <EmptyState
            title={t("network.files.empty")}
            body={t("network.files.emptyBody")}
            action={
              canWrite ? (
                <Button size="sm" onClick={() => void pick()}>
                  <FilePlus2 />
                  {t("network.files.choose")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul>
            {sorted.map((file) => (
              <FileRow
                key={file.name}
                file={file}
                playState={filePlayState(file, player)}
                canWrite={access.canWrite}
                renaming={renaming === file.name}
                onStartRename={() => setRenaming(file.name)}
                onCancelRename={() => setRenaming(null)}
                onRename={async (to) => {
                  const ok = to === file.name || (await actions.rename(file.name, to));
                  if (ok) setRenaming(null);
                }}
                onPlay={(loop) => actions.requestPlay(file, loop)}
                onStop={() => void actions.stop(file)}
                onDownload={() => void actions.download(file)}
                onDelete={() => setDeleting(file)}
              />
            ))}
          </ul>
        )}

        <footer className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <HardDrive className="size-3.5" aria-hidden />
          {t("network.files.count", { count: sorted.length })}
        </footer>
      </section>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t("network.files.deleteTitle", { name: deleting?.name ?? "" })}
        description={t("network.files.deleteDesc")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={() => deleting && void actions.remove(deleting)}
      />

      <ConfirmDialog
        open={actions.pendingOverwrite !== null}
        onOpenChange={(o) => !o && actions.cancelOverwrite()}
        title={t("network.files.overwriteTitle")}
        description={t("network.files.overwriteDesc", {
          names: actions.pendingOverwrite?.conflicts.join("、") ?? "",
        })}
        confirmLabel={t("network.files.overwrite")}
        destructive
        onConfirm={actions.confirmOverwrite}
      />

      <ConfirmDialog
        open={actions.pendingPlay !== null}
        onOpenChange={(o) => !o && actions.cancelPlay()}
        title={t("network.files.switchModeTitle")}
        description={t("network.files.switchModeDesc", {
          mode: actions.pendingPlay ? t(`network.modes.${actions.pendingPlay.mode}`) : "",
        })}
        confirmLabel={t("network.files.switchAndPlay")}
        onConfirm={actions.confirmPlay}
      />
    </div>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
