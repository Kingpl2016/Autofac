import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { announce } from "@/shared/stores/announcerStore";
import { useBakeEvents } from "../hooks/useBakeEvents";
import { useCueActions } from "../hooks/useCueActions";
import { useEditorHotkeys } from "../hooks/useEditorHotkeys";
import { useMediaDrop } from "../hooks/useMediaDrop";
import { useMediaRuntime } from "../hooks/useMediaRuntime";
import { useShowFile } from "../hooks/useShowFile";
import { useShowPlayback } from "../hooks/useShowPlayback";
import { dropOnTimeline, dropTemplate } from "../timeline/dropTemplate";
import { readTimelineViewport } from "../timeline/timelineView";
import { START_LEFT } from "../timeline/timelineData";
import { placeMediaOnTimeline } from "../hooks/mediaActions";
import { addLookCue } from "../lib/cueOps";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { AutoDraftDialog } from "./AutoDraftDialog";
import { CommandPalette } from "./CommandPalette";
import { EditorToolbar } from "./EditorToolbar";
import { EffectChip, type EffectDragData } from "./EffectsTab";
import { FileDialogs } from "./FileDialogs";
import { IconRail } from "./IconRail";
import { InspectorPanel } from "./InspectorPanel";
import { KeymapDialog } from "./KeymapDialog";
import { LibraryPanel } from "./LibraryPanel";
import { MediaChip, type MediaDragData } from "./MediaTab";
import { PresetChip, type PresetDragData } from "./PresetsTab";
import { PreviewPanel } from "./PreviewPanel";
import { RadialMenu } from "./RadialMenu";
import { TemplateChip, type TemplateDragData } from "./TemplatesTab";
import { TIMELINE_DROP_ID, TimelinePanel } from "./TimelinePanel";

/** 可以从素材库拖到时间线上的东西。 */
type DragData = TemplateDragData | EffectDragData | PresetDragData | MediaDragData;

/** 预设拖到轨道上新建的片段长度（毫秒）。 */
const PRESET_CLIP_MS = 4000;

/**
 * 节目编辑器主视图（剪映式布局）：顶部工具条 + 中部（图标栏 | 素材库 | 预览 | 属性）+ 底部时间线。
 * Ctrl+K 打开命令面板。
 * 各区域之间的分隔条可拖动，也可用方向键调整。
 *
 * 素材库到时间线的拖放用 dnd-kit 的指针事件实现（Windows 上 Tauri 开启文件拖放时，
 * webview 内的 HTML5 拖放不可靠）。
 */
export function ShowEditorView() {
  const { t } = useTranslation();
  const file = useShowFile();
  const commands = useEditorHotkeys(file.save);
  useShowPlayback();
  useBakeEvents();
  useMediaRuntime();
  const dropHover = useMediaDrop();
  const actions = useCueActions();

  // 从节目库跳转而来（?open=<节目路径>）：打开那个工程，并把参数从地址栏去掉
  const [params, setParams] = useSearchParams();
  const openParam = params.get("open");
  const { requestOpenPath } = file;
  useEffect(() => {
    if (!openParam) return;
    setParams({}, { replace: true });
    requestOpenPath(openParam);
  }, [openParam, setParams, requestOpenPath]);
  const [dragging, setDragging] = useState<DragData | null>(null);
  // 移动 6px 后才算开始拖拽，避免点击模板被误判为拖拽
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as DragData | undefined;
    setDragging(
      data?.kind === "template" || data?.kind === "effect" || data?.kind === "preset" || data?.kind === "media" ? data : null,
    );
  };

  const onDragEnd = (e: DragEndEvent) => {
    const data = e.active.data.current as DragData | undefined;
    setDragging(null);
    if (!data || e.over?.id !== TIMELINE_DROP_ID) return;
    const start = e.activatorEvent as PointerEvent;
    const pointer = { x: start.clientX + e.delta.x, y: start.clientY + e.delta.y };
    const { tracks } = useProjectStore.getState().project;
    const viewport = readTimelineViewport();
    let result;
    if (data.kind === "template") {
      result = dropTemplate(viewport, pointer, tracks, data.template, actions.addAt);
    } else if (data.kind === "effect") {
      result = dropOnTimeline(viewport, pointer, tracks, (trackId, timeMs) => actions.addEffectAt(trackId, timeMs, data.preset));
    } else if (data.kind === "media") {
      // 素材拖到时间线：放在指针处的时间；指针下是同类媒体轨道时优先放进那条
      if (!viewport) return;
      const x = pointer.x - viewport.rect.left + viewport.scrollLeft;
      const timeMs = Math.max(0, ((x - START_LEFT) / viewport.pxPerSec) * 1000);
      const under = document.elementsFromPoint?.(pointer.x, pointer.y) ?? [];
      const trackEl = under.find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.mediaTrackId !== undefined);
      const id = placeMediaOnTimeline(data.mediaId, timeMs, trackEl?.dataset.mediaTrackId);
      if (id) {
        useEditorUiStore.getState().selectMediaClips([id]);
        useEditorUiStore.getState().setInspectorTab("cue");
      }
      return;
    } else if (data.kind === "preset") {
      // 预设拖到轨道上：新建一个引用该预设的外观片段（之后改预设，片段一起变）
      result = dropOnTimeline(viewport, pointer, tracks, (trackId, timeMs) => {
        let id: string | null = null;
        useProjectStore.getState().update((d) => {
          id = addLookCue(d, trackId, timeMs, { presetId: data.presetId }, PRESET_CLIP_MS);
        });
        if (id) {
          useEditorUiStore.getState().selectCues([id]);
          useEditorUiStore.getState().setInspectorTab("cue");
        }
        return id;
      });
    } else {
      return;
    }
    if (result.kind === "noRoom") announce(t("editor.templates.noRoom"));
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex h-full min-h-0 flex-col bg-background">
        <EditorToolbar file={file} />
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="62%" minSize="30%">
            <div className="flex h-full min-h-0">
              <IconRail />
              <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1">
                <ResizablePanel defaultSize={280} minSize={200} maxSize="40%">
                  <LibraryPanel />
                </ResizablePanel>
                <ResizableHandle axis="x" />
                <ResizablePanel minSize="25%">
                  <PreviewPanel />
                </ResizablePanel>
                <ResizableHandle axis="x" />
                <ResizablePanel defaultSize={340} minSize={260} maxSize="40%">
                  <InspectorPanel />
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          </ResizablePanel>
          <ResizableHandle axis="y" />
          <ResizablePanel defaultSize="38%" minSize="18%">
            <TimelinePanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      {dropHover && (
        <div
          role="status"
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-2 border-dashed border-primary bg-background/70 text-sm font-medium"
        >
          {t("editor.media.dropHint")}
        </div>
      )}
      <FileDialogs file={file} />
      <CommandPalette commands={commands} />
      <RadialMenu commands={commands} />
      <AutoDraftDialog />
      <KeymapDialog commands={commands} />
      <DragOverlay dropAnimation={null}>
        {dragging?.kind === "template" && <TemplateChip template={dragging.template} overlay />}
        {dragging?.kind === "effect" && <EffectChip preset={dragging.preset} overlay />}
        {dragging?.kind === "preset" && <PresetChip name={dragging.name} swatch={dragging.swatch} />}
        {dragging?.kind === "media" && <MediaChip name={dragging.name} mediaKind={dragging.mediaKind} />}
      </DragOverlay>
    </DndContext>
  );
}
