import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRightToLine,
  Maximize2,
  Pause,
  Play,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Link, useBlocker, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useStore } from "zustand";

import { useWindowKeydown } from "@/shared/hooks/useWindowKeydown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatDurationUs,
  invalidateProgramCaches,
  LIB_ERR_CANCELLED,
  libraryHref,
  playerClose,
  RECORDINGS_QUERY_KEY,
  recordingsList,
  useOverview,
  usePlayerStore,
  useProgramActions,
} from "@/features/recording";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { PageHeader } from "@/shared/components/PageHeader";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { isTextEntry } from "@/shared/lib/keyboard";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useEditExport } from "../../hooks/useEditExport";
import { useSegmentPreview } from "../../hooks/useSegmentPreview";
import { totalDuration } from "../../lib/segments";
import { formatTimecode } from "../../lib/timecode";
import { beginTrimGesture, endTrimGesture, useEditDraftStore } from "../../stores/useEditDraftStore";
import { EditOutputPanel, type ExportDone, type OutputMode } from "./EditOutputPanel";
import { EditTimeline } from "./EditTimeline";
import { TimecodeField } from "./TimecodeField";
import { UniversePicker } from "./UniversePicker";

/** 时间轴缩放档位。 */
const ZOOM_LEVELS = [1, 2, 4, 8, 16] as const;
/** 方向键移动播放头的步长（微秒）：100ms，Shift 为 1s。 */
const SEEK_STEP_US = 100_000;
const SEEK_STEP_COARSE_US = 1_000_000;

/** 草稿的撤销 / 重做状态。 */
function useDraftHistory() {
  const canUndo = useStore(useEditDraftStore.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useEditDraftStore.temporal, (s) => s.futureStates.length > 0);
  return {
    canUndo,
    canRedo,
    undo: () => useEditDraftStore.temporal.getState().undo(),
    redo: () => useEditDraftStore.temporal.getState().redo(),
  };
}

/**
 * 编辑导出页（`/library/edit?path=…`）：以视频剪辑的方式编辑节目。
 *
 * - 片段轨：整段起步，在播放头处切割（S）、删除选中片段（Delete）、拖动边缘修剪，
 *   设入点 / 出点（I / O）裁掉两端；导出时保留的片段按顺序首尾拼接。
 * - Universe：只保留勾选的 Universe。
 * - 预览（Space）：在播放器里只播放保留的片段并循环。
 * - 输出：另存为新节目（默认）或替换原节目（原文件移入回收站；编辑器节目不能替换）。
 *
 * 片段与 Universe 的修改可撤销（Ctrl+Z / Ctrl+Shift+Z）；有未导出的修改时离开页面会先确认。
 */
export function ProgramEditView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const actions = useProgramActions(undefined, { stayOnPage: true });
  const list = useQuery({ queryKey: RECORDINGS_QUERY_KEY, queryFn: recordingsList });
  const entry = useMemo(() => list.data?.find((e) => e.path === path) ?? null, [list.data, path]);
  const editable = entry !== null && entry.valid && entry.exported;
  const overview = useOverview(editable ? path : "");

  const draft = useEditDraftStore();
  const history = useDraftHistory();
  const [zoom, setZoom] = useState<number>(1);
  const [mode, setMode] = useState<OutputMode>("new");
  // 新节目名称：没改过时随节目给出默认值“原名（剪辑）”
  const [nameDraft, setNameDraft] = useState<{ path: string; value: string } | null>(null);
  const exporter = useEditExport();
  // 最近一次成功导出（输出面板显示完成状态）与“替换原节目？”确认
  // 记下导出时的草稿：之后只要再修改，完成状态就自动换回导出表单
  const [done, setDone] = useState<(ExportDone & { segments: unknown; universes: unknown }) | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const loadedPath = usePlayerStore((s) => (s.status.loaded ? s.status.path : ""));
  const leaving = useRef(false);

  // 打开一个新节目时重置草稿；同一节目来回切换页面时保留草稿
  useEffect(() => {
    if (!entry || !editable) return;
    const s = useEditDraftStore.getState();
    if (s.path !== entry.path || s.durationUs !== entry.durationUs) {
      s.reset(entry.path, entry.durationUs, entry.universes);
    }
  }, [entry, editable]);
  const name =
    nameDraft?.path === path ? nameDraft.value : t("library.editDefaultName", { name: entry?.name ?? "" });
  const setName = (value: string) => setNameDraft({ path, value });

  const ready = editable && draft.path === path;
  const segments = draft.segments;
  const resultUs = totalDuration(segments);
  const selected = segments.find((s) => s.id === draft.selectedId) ?? null;
  const selectedIndex = selected ? segments.indexOf(selected) : -1;

  const preview = useSegmentPreview(path, segments, draft.setPlayhead);
  const playerMode = useEngineStatusStore((s) => s.appMode === "player");

  // 进入编辑页 = 进入播放器模式（停止实时接收与转发，实时模式下先确认），留在本页预览。
  // 每个节目只自动请求一次：用户在确认框里取消后，由页面上的提示按钮再次发起
  const { enter } = preview;
  const entered = useRef("");
  useEffect(() => {
    if (!ready || entered.current === path) return;
    entered.current = path;
    enter();
  }, [ready, path, enter]);

  // 有未导出的修改时离开页面先确认（导出成功后的跳转不拦）
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      draft.dirty && !leaving.current && !exporter.running && currentLocation.pathname !== nextLocation.pathname,
  );

  const blockReason = !ready
    ? ""
    : draft.universes.length === 0
      ? t("library.errNoUniverses")
      : segments.length === 0
        ? t("library.errEmptyEdit")
        : "";

  /** 草稿相对原节目是否有改动（决定“替换原节目”是否有意义）。 */
  const changed =
    ready &&
    (draft.universes.length !== draft.allUniverses.length ||
      segments.length !== 1 ||
      segments[0].startUs !== 0 ||
      segments[0].endUs !== draft.durationUs);

  const doExport = async () => {
    if (!entry || blockReason || exporter.running) return;
    const replace = mode === "replace";
    try {
      // 替换前关闭正在播放的同一节目（Windows 上无法替换被打开的文件）
      if (replace && loadedPath === entry.path) {
        preview.stop();
        await playerClose();
      }
      const universes = draft.universes.length === draft.allUniverses.length ? null : [...draft.universes];
      const result = await exporter.run({
        path: entry.path,
        segments: segments.map(({ startUs, endUs }) => ({ startUs, endUs })),
        universes,
        output: replace ? { kind: "replace" } : { kind: "new", name: name.trim() },
      });
      await invalidateProgramCaches(client, ...(replace ? [entry.path] : []));
      const savedName = replace ? entry.name : name.trim();
      toast.success(
        t(replace ? "library.editReplaced" : "library.editSaved", {
          name: savedName,
          duration: formatDurationUs(result.durationUs),
        }),
      );
      if (replace) {
        // 原节目已是编辑结果：草稿从新内容重新开始
        useEditDraftStore.getState().reset(entry.path, result.durationUs, result.universes);
      } else {
        useEditDraftStore.getState().markExported();
      }
      const after = useEditDraftStore.getState();
      setDone({
        path: result.path,
        name: savedName,
        durationUs: result.durationUs,
        replaced: replace,
        segments: after.segments,
        universes: after.universes,
      });
    } catch (e: unknown) {
      if (e === LIB_ERR_CANCELLED || (e instanceof Error && e.message === LIB_ERR_CANCELLED)) {
        toast.info(t("library.errCancelled"));
      } else {
        toast.error(t("library.editFailed", { reason: actions.describeError(e) }));
      }
    }
  };

  const shownDone = done && done.segments === segments && done.universes === draft.universes ? done : null;

  /** 导出入口（按钮、Enter、Ctrl+S）：替换原节目先确认，另存直接导出。 */
  const requestExport = () => {
    if (!entry || blockReason || exporter.running || shownDone) return;
    if (mode === "new" && !name.trim()) return;
    if (mode === "replace") {
      if (changed) setConfirmReplace(true);
      return;
    }
    void doExport();
  };
  const requestExportRef = useRef(requestExport);
  useEffect(() => {
    requestExportRef.current = requestExport;
  });
  const zoomBy = useCallback((dir: 1 | -1) => {
    setZoom((z) => {
      const i = ZOOM_LEVELS.indexOf(z as (typeof ZOOM_LEVELS)[number]);
      return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, i + dir))];
    });
  }, []);

  // 页面快捷键（不在输入框里时）
  useWindowKeydown(
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        requestExportRef.current();
        return;
      }
      if (isTextEntry(e.target) || e.altKey) return;
      const s = useEditDraftStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        history.redo();
        return;
      }
      if (mod) return;
      // 滑块（播放头 / 片段边缘）自己处理方向键
      const onSlider = e.target instanceof HTMLElement && e.target.getAttribute("role") === "slider";
      if (key === "s") s.splitAtPlayhead();
      else if (key === "i") s.setIn();
      else if (key === "o") s.setOut();
      else if (e.key === "Delete" || e.key === "Backspace") s.removeSelected();
      else if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        if (preview.active) preview.stop();
        else preview.start(s.playheadUs);
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !onSlider) {
        const stepUs = e.shiftKey ? SEEK_STEP_COARSE_US : SEEK_STEP_US;
        s.setPlayhead(s.playheadUs + (e.key === "ArrowLeft" ? -stepUs : stepUs));
      } else return;
      e.preventDefault();
    },
    { enabled: ready },
  );

  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link to={libraryHref(path)}>
        <ArrowLeft />
        {t("library.editBack")}
      </Link>
    </Button>
  );

  if (list.isLoading) {
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!entry || !editable) {
    return (
      <div className="flex flex-col items-start gap-3">
        {back}
        <p role="alert" className="text-sm text-muted-foreground">
          {entry ? t("library.editUnavailable") : t("recording.libErrNotFound")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-(--density-gap)">
      <PageHeader
        className="mb-0"
        title={t("library.editTitle", { name: entry.name })}
        subtitle={t("library.editSubtitle", {
          duration: formatDurationUs(entry.durationUs),
          n: entry.universes.length,
        })}
        actions={
          <>
            {back}
            {playerMode && (
              <span className="rounded-md bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-primary">
                {t("library.editPlayerMode")}
              </span>
            )}
            <span className="num rounded-md border border-border px-3 py-1.5 text-sm" aria-live="polite">
              {t("library.editResult", { duration: formatTimecode(resultUs), n: draft.universes.length })}
            </span>
          </>
        }
      />

      {!playerMode && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">{t("library.editNeedsPlayer")}</span>
          <Button size="sm" className="h-9" disabled={actions.transitioning} onClick={enter}>
            <Play className="fill-current" />
            {t("library.editEnterPlayer")}
          </Button>
        </div>
      )}

      {entry.editable && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          {t("library.editEditableNote")}
        </p>
      )}

      <SurfacePanel
        title={t("library.editTimeline")}
        actions={
          <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={t("library.editToolbar")}>
            <ToolButton label={t("library.editSplit")} keys="S" onClick={draft.splitAtPlayhead} disabled={!ready}>
              <Scissors />
            </ToolButton>
            <ToolButton
              label={t("library.editRemoveSegment")}
              keys="Delete"
              onClick={draft.removeSelected}
              disabled={!ready || !selected || segments.length <= 1}
            >
              <Trash2 />
            </ToolButton>
            <ToolButton label={t("library.editSetIn")} keys="I" onClick={draft.setIn} disabled={!ready}>
              <ArrowLeftToLine />
            </ToolButton>
            <ToolButton label={t("library.editSetOut")} keys="O" onClick={draft.setOut} disabled={!ready}>
              <ArrowRightToLine />
            </ToolButton>
            <span className="mx-1 h-6 w-px bg-border" aria-hidden />
            <ToolButton label={t("library.editUndo")} keys="Control+Z" onClick={history.undo} disabled={!history.canUndo}>
              <Undo2 />
            </ToolButton>
            <ToolButton label={t("library.editRedo")} keys="Control+Shift+Z" onClick={history.redo} disabled={!history.canRedo}>
              <Redo2 />
            </ToolButton>
            <span className="mx-1 h-6 w-px bg-border" aria-hidden />
            <ToolButton label={t("library.editZoomOut")} onClick={() => zoomBy(-1)} disabled={zoom === ZOOM_LEVELS[0]}>
              <ZoomOut />
            </ToolButton>
            <span className="num w-10 text-center text-xs text-muted-foreground" aria-live="polite">
              {zoom}×
            </span>
            <ToolButton
              label={t("library.editZoomIn")}
              onClick={() => zoomBy(1)}
              disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
            >
              <ZoomIn />
            </ToolButton>
            <ToolButton label={t("library.editZoomFit")} onClick={() => setZoom(1)} disabled={zoom === 1}>
              <Maximize2 />
            </ToolButton>
          </div>
        }
      >
        <div className="grid gap-3">
          <EditTimeline
            overview={overview.data}
            durationUs={entry.durationUs}
            segments={segments}
            universes={draft.universes}
            selectedId={draft.selectedId}
            playheadUs={draft.playheadUs}
            zoom={zoom}
            onSeek={draft.setPlayhead}
            onSelect={draft.select}
            onTrim={draft.trim}
            onTrimGestureStart={beginTrimGesture}
            onTrimGestureEnd={endTrimGesture}
            onZoom={zoomBy}
          />
          {overview.isError && <p className="text-xs text-destructive">{t("player.overviewFailed")}</p>}

          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <Button
              variant={preview.active ? "outline" : "default"}
              aria-keyshortcuts="Space"
              disabled={!ready || actions.transitioning}
              onClick={() => (preview.active ? preview.stop() : preview.start(draft.playheadUs))}
            >
              {preview.active ? <Pause className="fill-current" /> : <Play className="fill-current" />}
              {preview.active ? t("library.editPreviewStop") : t("library.editPreview")}
            </Button>
            <span className="num pb-3 text-sm text-muted-foreground">
              {t("library.editPlayheadAt", { time: formatTimecode(draft.playheadUs) })}
            </span>
            {selected ? (
              <div className="flex flex-wrap items-end gap-3" key={selected.id}>
                <span className="pb-3 text-sm font-medium">{t("library.segmentLabel", { n: selectedIndex + 1 })}</span>
                <TimecodeField
                  key={`s${selected.startUs}`}
                  label={t("library.segmentStart")}
                  value={selected.startUs}
                  onCommit={(us) => draft.trim(selected.id, "start", us)}
                />
                <TimecodeField
                  key={`e${selected.endUs}`}
                  label={t("library.segmentEnd")}
                  value={selected.endUs}
                  onCommit={(us) => draft.trim(selected.id, "end", us)}
                />
                <span className="num pb-3 text-sm text-muted-foreground">
                  {t("library.segmentLength", { time: formatTimecode(selected.endUs - selected.startUs) })}
                </span>
              </div>
            ) : (
              <span className="pb-3 text-sm text-muted-foreground">{t("library.editSelectHint")}</span>
            )}
            {draft.dirty && (
              <Button variant="link" className="ml-auto h-auto p-0 pb-3 text-xs" onClick={draft.restoreAll}>
                {t("library.editRestoreAll")}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t("library.editHotkeys")}</p>
        </div>
      </SurfacePanel>

      <div className="grid gap-(--density-gap) lg:grid-cols-2">
        <SurfacePanel>
          <UniversePicker
            all={draft.allUniverses}
            kept={draft.universes}
            overview={overview.data}
            onToggle={draft.toggleUniverse}
            onSet={draft.setUniverses}
          />
        </SurfacePanel>
        <SurfacePanel>
          <EditOutputPanel
            mode={mode}
            onModeChange={setMode}
            name={name}
            onNameChange={setName}
            replaceDisabled={entry.editable}
            summary={{
              durationUs: resultUs,
              sourceUs: entry.durationUs,
              segments: segments.length,
              universes: draft.universes.length,
              totalUniverses: draft.allUniverses.length,
            }}
            dirty={changed}
            blockReason={blockReason}
            running={exporter.running}
            progress={exporter.progress}
            done={shownDone}
            onExport={requestExport}
            onCancelExport={exporter.cancel}
            onViewResult={() => {
              if (shownDone) void navigate(libraryHref(shownDone.path));
            }}
            onContinue={() => setDone(null)}
          />
        </SurfacePanel>
      </div>

      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={setConfirmReplace}
        title={t("library.editReplaceTitle")}
        description={t("library.editReplaceDesc", { name: entry.name })}
        confirmLabel={t("library.editExportReplace")}
        destructive
        onConfirm={() => void doExport()}
      />
      <ConfirmDialog
        open={blocker.state === "blocked"}
        onOpenChange={(open) => {
          // 确认离开时 `onConfirm` 先于这里执行，已放行的跳转不能再被 reset 取消
          if (!open && !leaving.current && blocker.state === "blocked") blocker.reset();
        }}
        title={t("library.editLeaveTitle")}
        description={t("library.editLeaveDesc")}
        confirmLabel={t("library.editLeaveConfirm")}
        destructive
        onConfirm={() => {
          leaving.current = true;
          blocker.proceed?.();
        }}
      />
    </div>
  );
}

interface ToolButtonProps {
  label: string;
  /** 快捷键（`aria-keyshortcuts` 格式） */
  keys?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** 时间轴工具栏的图标按钮：名称给读屏与悬停提示，快捷键写进提示与 `aria-keyshortcuts`。 */
function ToolButton({ label, keys, disabled, onClick, children }: ToolButtonProps) {
  const hint = keys ? `${label} (${keys.replace("Control", "Ctrl")})` : label;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-9"
      aria-label={label}
      aria-keyshortcuts={keys}
      title={hint}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
