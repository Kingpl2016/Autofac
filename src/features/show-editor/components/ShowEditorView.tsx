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
import { useProjectStore } from "../stores/useProjectStore";
import { EditorToolbar } from "./EditorToolbar";
import { EffectChip, type EffectDragData } from "./EffectsTab";
import { FileDialogs } from "./FileDialogs";
import { InspectorPanel } from "./InspectorPanel";
import { LibraryPanel } from "./LibraryPanel";
import { PreviewPanel } from "./PreviewPanel";
import { TemplateChip, type TemplateDragData } from "./TemplatesTab";
import { TIMELINE_DROP_ID, TimelinePanel } from "./TimelinePanel";

/**
 * 节目编辑器主视图：顶部工具条 + 中部（素材库 | 预览 | 属性）+ 底部时间线。
 * 各区域之间的分隔条可拖动，也可用方向键调整。
 *
 * 素材库到时间线的拖放用 dnd-kit 的指针事件实现（Windows 上 Tauri 开启文件拖放时，
 * webview 内的 HTML5 拖放不可靠）。
 */
export function ShowEditorView() {
  const { t } = useTranslation();
  const file = useShowFile();
  useEditorHotkeys(file.save);
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
  const [dragging, setDragging] = useState<TemplateDragData | EffectDragData | null>(null);
  // 移动 6px 后才算开始拖拽，避免点击模板被误判为拖拽
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as TemplateDragData | EffectDragData | undefined;
    setDragging(data?.kind === "template" || data?.kind === "effect" ? data : null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const data = e.active.data.current as TemplateDragData | EffectDragData | undefined;
    setDragging(null);
    if ((data?.kind !== "template" && data?.kind !== "effect") || e.over?.id !== TIMELINE_DROP_ID) return;
    const start = e.activatorEvent as PointerEvent;
    const pointer = { x: start.clientX + e.delta.x, y: start.clientY + e.delta.y };
    const { tracks } = useProjectStore.getState().project;
    const result =
      data.kind === "template"
        ? dropTemplate(readTimelineViewport(), pointer, tracks, data.template, actions.addAt)
        : dropOnTimeline(readTimelineViewport(), pointer, tracks, (trackId, timeMs) =>
            actions.addEffectAt(trackId, timeMs, data.preset),
          );
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
            <ResizablePanelGroup orientation="horizontal">
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
      <DragOverlay dropAnimation={null}>
        {dragging?.kind === "template" && <TemplateChip template={dragging.template} overlay />}
        {dragging?.kind === "effect" && <EffectChip preset={dragging.preset} overlay />}
      </DragOverlay>
    </DndContext>
  );
}
