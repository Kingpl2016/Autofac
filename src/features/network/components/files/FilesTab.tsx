import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { HardDrive, RefreshCw, Search, Upload, UploadCloud } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { listenFileDrop } from "@/shared/tauri/dragDrop";
import { pickArtrecFiles } from "@/shared/tauri/pickers";
import { cn } from "@/lib/utils";
import { useDeviceFiles } from "../../hooks/useDeviceFiles";
import { useFileActions } from "../../hooks/useFileActions";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { errorText } from "../../lib/errors";
import { activeProgramNo, filePlayState, planReorder, sortFiles } from "../../lib/files";
import { formatBytes } from "../../lib/format";
import type { NetDevice, NetFile } from "../../lib/types";
import { FileRow } from "./FileRow";
import { SortableFileRow } from "./SortableFileRow";

/** 只允许纵向拖动。 */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

interface FilesTabProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 文件：设备 SD 卡上的节目文件表。
 *
 * - 工具条：筛选（Ctrl+F）、文件数与容量、刷新、上传。
 * - 上传：点“上传文件”选择，或把 .artrec 拖到窗口里（拖入时整张表出现投放遮罩）；空表时显示大块拖放区。
 * - 每行：拖动手柄改顺序（即重排节目号）、点节目号改号、主按钮播放 / 停止、“⋯”菜单里是循环播放 / 下载 / 重命名 / 删除。
 */
export function FilesTab({ device, access }: FilesTabProps) {
  const { t } = useTranslation();
  const { files, isLoading, isFetching, error, refresh } = useDeviceFiles(device.id, access.canRead);
  const status = access.status.status;
  const sdMounted = status?.sdMounted ?? true;
  const workMode = status?.workMode ?? null;
  const player = status?.player ?? null;
  const playingNo = activeProgramNo(player);
  const actions = useFileActions({ device, workMode, files, refresh, playingNo });
  const [hovering, setHovering] = useState(false);
  const [deleting, setDeleting] = useState<NetFile | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(() => sortFiles(files), [files]);
  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => (q ? sorted.filter((f) => f.name.toLowerCase().includes(q)) : sorted), [sorted, q]);
  const numbered = useMemo(() => visible.filter((f) => f.program !== null), [visible]);
  const unnumbered = useMemo(() => visible.filter((f) => f.program === null), [visible]);
  const canWrite = access.canWrite && sdMounted;
  // 筛选时只看到一部分文件，拖动排序会让节目号难以预料，所以先停用
  const sortDisabled = !canWrite || actions.reassigning || q !== "";

  // 6px 后才算开始拖动，避免点击手柄被误判；键盘：空格拿起、方向键移动、空格放下、Esc 取消
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = numbered.findIndex((f) => f.name === active.id);
    const to = numbered.findIndex((f) => f.name === over.id);
    const moved = numbered[from];
    const plan = planReorder(numbered, from, to);
    if (!moved || plan.length === 0) return;
    const no = plan.find((a) => a.file === moved.name)?.no;
    void actions.reassign(plan, no === undefined ? undefined : t("network.files.renumbered", { name: moved.name, no }));
  };

  // 读屏播报：dnd-kit 默认是英文，这里换成本地化文案
  const announcements = useMemo<Announcements>(() => {
    const total = numbered.length;
    const pos = (id: string | number) => numbered.findIndex((f) => f.name === id) + 1;
    return {
      onDragStart: ({ active }) => t("network.files.announceLift", { name: active.id, pos: pos(active.id), total }),
      onDragOver: ({ active, over }) =>
        over ? t("network.files.announceOver", { name: active.id, pos: pos(over.id), total }) : undefined,
      onDragEnd: ({ active, over }) =>
        over ? t("network.files.announceDrop", { name: active.id, pos: pos(over.id) }) : t("network.files.announceCancel", { name: active.id }),
      onDragCancel: ({ active }) => t("network.files.announceCancel", { name: active.id }),
    };
  }, [numbered, t]);

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
      setHovering(false);
    };
  }, [canWrite]);

  // Ctrl+F：聚焦筛选框（文件 Tab 可见时）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 每一行共用的属性（行内按钮的动作都接到 `actions`）。 */
  const rowProps = (file: NetFile) => ({
    file,
    files: sorted,
    playState: filePlayState(file, player),
    playingNo,
    canWrite,
    renaming: renaming === file.name,
    onStartRename: () => setRenaming(file.name),
    onCancelRename: () => setRenaming(null),
    onRename: async (to: string) => {
      const ok = to === file.name || (await actions.rename(file.name, to));
      if (ok) setRenaming(null);
    },
    onReassign: actions.reassign,
    onPlay: (loop: boolean) => actions.requestPlay(file, loop),
    onStop: () => void actions.stop(file),
    onDownload: () => void actions.download(file),
    onDelete: () => setDeleting(file),
  });

  const pick = async () => {
    const paths = await pickArtrecFiles();
    if (paths.length > 0) actions.uploadPaths(paths);
  };

  const total = status?.sdTotal ?? 0;
  const free = status?.sdFree ?? 0;
  const readOnlyReason = canWrite ? null : t(sdMounted ? "network.files.readOnlyHint" : "network.files.sdMissing");

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={filterRef}
            type="search"
            role="searchbox"
            className="h-10 pl-9"
            value={filter}
            placeholder={t("network.files.filter")}
            aria-label={t("network.files.filter")}
            aria-keyshortcuts="Control+F"
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <span className="tabular text-xs text-muted-foreground">
          {t("network.files.count", { count: sorted.length })}
          {status?.sdMounted && total > 0 && ` · ${t("network.files.capacity", { used: formatBytes(total - free), total: formatBytes(total) })}`}
        </span>
        {readOnlyReason && <span className="text-xs font-medium text-warning">{readOnlyReason}</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-10 px-4"
            onClick={() => void refresh()}
            disabled={!access.canRead || isFetching}
          >
            <RefreshCw className={cn(isFetching && "animate-spin motion-reduce:animate-none")} />
            {t("network.files.refresh")}
          </Button>
          <Button size="sm" className="h-10 px-4" onClick={() => void pick()} disabled={!canWrite}>
            <Upload />
            {t("network.files.upload")}
          </Button>
        </div>
      </div>

      <section
        aria-label={t("network.files.listTitle")}
        className="@container relative overflow-hidden rounded-xl border border-border bg-surface-2 panel-edge"
      >
        {hovering && canWrite && sorted.length > 0 && (
          <div
            role="status"
            className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/10 text-primary backdrop-blur-sm"
          >
            <UploadCloud className="size-8" aria-hidden />
            <p className="text-sm font-semibold">{t("network.files.dropRelease")}</p>
            <p className="text-xs">{t("network.files.dropSub")}</p>
          </div>
        )}

        {isLoading ? (
          <ul aria-busy="true" aria-label={t("common.loading")}>
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-4 border-b border-border px-5 py-4 last:border-b-0">
                <Skeleton className="h-4 w-14 rounded bg-surface-1" />
                <Skeleton className="h-4 flex-1 rounded bg-surface-1" />
                <Skeleton className="h-8 w-28 rounded bg-surface-1" />
              </li>
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
          <DropZone hovering={hovering} canWrite={canWrite} onPick={() => void pick()} />
        ) : visible.length === 0 ? (
          <EmptyState title={t("network.files.noMatch")} body={t("network.files.noMatchBody", { q: filter.trim() })} />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDragEnd}
            accessibility={{
              announcements,
              screenReaderInstructions: { draggable: t("network.files.dragInstructions") },
            }}
          >
            <table className="w-full border-collapse text-sm" aria-busy={actions.reassigning || undefined}>
              <caption className="sr-only">{t("network.files.listCaption")}</caption>
              <thead className="bg-surface-1/60 text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  {/* 与行内“手柄 + 节目号”对齐：手柄 2.25rem + 间距 0.25rem + 号码内边距 0.5rem */}
                  <th scope="col" className="py-2.5 pl-15 pr-2 text-left font-medium">
                    {t("network.files.colProgram")}
                  </th>
                  <th scope="col" className="py-2.5 pr-4 text-left font-medium">
                    {t("network.files.colName")}
                  </th>
                  <th scope="col" className="hidden py-2.5 pr-4 text-right font-medium @xl:table-cell">
                    {t("network.files.colSize")}
                  </th>
                  <th scope="col" className="py-2.5 pr-3 text-right font-medium">
                    {t("network.files.colActions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                <SortableContext items={numbered.map((f) => f.name)} strategy={verticalListSortingStrategy} disabled={sortDisabled}>
                  {numbered.map((file) => (
                    <SortableFileRow key={file.name} sortDisabled={sortDisabled} {...rowProps(file)} />
                  ))}
                </SortableContext>
                {/* 没有节目号的文件不参与排序（先在“节目号”里给它分配一个） */}
                {unnumbered.map((file) => (
                  <FileRow key={file.name} {...rowProps(file)} />
                ))}
              </tbody>
            </table>
          </DndContext>
        )}

        {sorted.length > 0 && !isLoading && !error && sdMounted && (
          <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <HardDrive className="size-3.5" aria-hidden />
              {q ? t("network.files.shown", { shown: visible.length, count: sorted.length }) : t("network.files.count", { count: sorted.length })}
            </span>
            {canWrite && numbered.length > 1 && !q && <span>{t("network.files.sortHint")}</span>}
            <span className="ml-auto hidden lg:inline">{t("network.files.keyboardHint")}</span>
          </footer>
        )}
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

/** 空表时的大块拖放区：同时是空状态说明和上传入口。 */
function DropZone({ hovering, canWrite, onPick }: { hovering: boolean; canWrite: boolean; onPick: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "m-4 flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors duration-150 motion-reduce:transition-none",
        hovering && canWrite ? "border-primary bg-primary/10" : "border-border",
      )}
    >
      <UploadCloud className={cn("size-8", hovering && canWrite ? "text-primary" : "text-muted-foreground")} aria-hidden />
      <p className="text-sm font-medium">{hovering && canWrite ? t("network.files.dropRelease") : t("network.files.empty")}</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {canWrite ? `${t("network.files.emptyBody")} ${t("network.files.dropHint")}` : t("network.files.readOnlyHint")}
      </p>
      {canWrite && (
        <Button size="sm" className="mt-2" onClick={onPick}>
          <Upload />
          {t("network.files.choose")}
        </Button>
      )}
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
