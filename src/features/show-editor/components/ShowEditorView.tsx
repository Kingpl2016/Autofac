import { useEffect, useRef, useState } from "react";
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
import { toast } from "sonner";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { announce } from "@/shared/stores/announcerStore";
import { useBakeEvents } from "../hooks/useBakeEvents";
import { dropFixtureModel, resolveFixtureDrop } from "../hooks/fixtureDrop";
import { useEditorHotkeys } from "../hooks/useEditorHotkeys";
import { useMediaDrop } from "../hooks/useMediaDrop";
import { useMediaRuntime } from "../hooks/useMediaRuntime";
import { useShowFile } from "../hooks/useShowFile";
import { useShowPlayback } from "../hooks/useShowPlayback";
import { OnboardingRuntime } from "../onboarding/useOnboarding";
import { dropOnTimeline } from "../timeline/dropTemplate";
import { readTimelineViewport } from "../timeline/timelineView";
import { START_LEFT } from "../timeline/timelineData";
import { placeMediaOnTimeline } from "../hooks/mediaActions";
import { templateNeeds, trackSupports } from "../lib/cueDefaults";
import { addLookCue } from "../lib/cueOps";
import { templateName } from "../lib/cueTemplates";
import { addTemplateCue } from "../lib/templateOps";
import { addEffectDefCue, effectDefNeeds, effectName } from "../lib/effectLibrary";
import type { FixtureCapability } from "../lib/fixtureProfile";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { AutoDraftDialog } from "./AutoDraftDialog";
import { CommandPalette } from "./CommandPalette";
import { DurationConfirmDialog } from "./DurationConfirmDialog";
import { EditorColumns } from "./EditorColumns";
import { EditorToolbar } from "./EditorToolbar";
import { ModelUpdatesBanner } from "./ModelUpdatesBanner";
import { EffectDefChip, type EffectDefDragData } from "./EffectLibrarySection";
import { FileDialogs } from "./FileDialogs";
import { IconRail } from "./IconRail";
import { InspectorPanel } from "./InspectorPanel";
import { KeymapDialog } from "./KeymapDialog";
import { FixtureModelChip, type FixtureModelDragData } from "./LibraryFixturesTab";
import { LibraryPanel } from "./LibraryPanel";
import { MediaChip, type MediaDragData } from "./MediaTab";
import { PresetChip, type PresetDragData } from "./PresetsTab";
import { PreviewPanel } from "./PreviewPanel";
import { RadialMenu } from "./RadialMenu";
import { ShortcutSheetDialog } from "./ShortcutSheetDialog";
import { TemplateChip, type TemplateDragData } from "./TemplatesTab";
import type { FixtureInstanceDragData } from "./SwatchView";
import { RepeatDialog } from "./RepeatDialog";
import { EffectEditorDialog } from "./EffectEditorDialog";
import { TemplateEditorDialog } from "./TemplateEditorDialog";
import { ensureRefTracks } from "../lib/ops";
import { TIMELINE_DROP_ID, TimelinePanel } from "./TimelinePanel";

/** 可以从素材库拖到时间线上的东西。 */
type DragData =
  | TemplateDragData
  | EffectDefDragData
  | PresetDragData
  | MediaDragData
  | FixtureModelDragData
  | FixtureInstanceDragData;

/** 会显示拖拽浮层的素材类型。 */
const DRAG_KINDS: ReadonlySet<string> = new Set<DragData["kind"]>([
  "template",
  "effectDef",
  "preset",
  "media",
  "fixtureModel",
  "fixtureInstance",
]);

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
  const { t, i18n } = useTranslation();
  const file = useShowFile();
  const commands = useEditorHotkeys(file.save);
  useShowPlayback();
  useBakeEvents();
  useMediaRuntime();
  const dropHover = useMediaDrop();

  // 从节目库跳转而来（?open=<节目路径>）：打开那个工程，并把参数从地址栏去掉
  const [params, setParams] = useSearchParams();
  const openParam = params.get("open");
  const { requestOpenPath } = file;
  useEffect(() => {
    if (!openParam) return;
    setParams({}, { replace: true });
    requestOpenPath(openParam);
  }, [openParam, setParams, requestOpenPath]);
  // 从灯具素材库跳转而来（?addFixture=<模型编号>）：打开左侧灯具页并展开该模型的批量添加面板
  const addFixtureParam = params.get("addFixture");
  useEffect(() => {
    if (!addFixtureParam) return;
    setParams({}, { replace: true });
    const ui = useEditorUiStore.getState();
    ui.setLibraryTab("fixtures");
    ui.setFixtureAddModel(addFixtureParam);
  }, [addFixtureParam, setParams]);
  const [dragging, setDragging] = useState<DragData | null>(null);
  // 移动 6px 后才算开始拖拽，避免点击模板被误判为拖拽
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // 放下的位置取指针的真实位置：dnd-kit 的 `delta` 会把拖拽途中滚动容器的滚动量算进去，
  // 从可滚动的素材库拖出来时按 `activatorEvent + delta` 推出的位置会偏（落点算错、放不下）
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", onMove, { capture: true, passive: true });
    return () => window.removeEventListener("pointermove", onMove, { capture: true });
  }, []);

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as DragData | undefined;
    setDragging(data && DRAG_KINDS.has(data.kind) ? data : null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const data = e.active.data.current as DragData | undefined;
    setDragging(null);
    if (!data) return;
    const start = e.activatorEvent as PointerEvent;
    const pointer = pointerRef.current ?? { x: start.clientX + e.delta.x, y: start.clientY + e.delta.y };
    // 预览色块拖到时间线：为这些灯（像素）建轨道（已有轨道的跳过）
    if (data.kind === "fixtureInstance") {
      if (e.over?.id !== TIMELINE_DROP_ID) return;
      let created: string[] = [];
      useProjectStore.getState().update((d) => {
        created = ensureRefTracks(d, data.refs);
      });
      announce(t("editor.swatches.tracksCreated", { count: created.length }));
      return;
    }
    // 灯具模型：可放到 Patch 的 Universe 卡片、舞台监视器或时间线
    if (data.kind === "fixtureModel") {
      const target = resolveFixtureDrop(e.over ? { id: e.over.id, rect: e.over.rect, data: e.over.data } : null, pointer, TIMELINE_DROP_ID);
      if (target) dropFixtureModel(data.modelId, target);
      return;
    }
    if (e.over?.id !== TIMELINE_DROP_ID) return;
    const { tracks } = useProjectStore.getState().project;
    const viewport = readTimelineViewport();
    let result;
    // 素材需要的能力：轨道上没有一台灯支持时拒绝放下并说明原因
    let rejected: FixtureCapability | null = null;
    const guard =
      (needs: FixtureCapability, add: (trackId: string, timeMs: number) => string | null) =>
      (trackId: string, timeMs: number) => {
        if (!trackSupports(useProjectStore.getState().project, trackId, needs)) {
          rejected = needs;
          return null;
        }
        return add(trackId, timeMs);
      };
    if (data.kind === "template") {
      result = dropOnTimeline(
        viewport,
        pointer,
        tracks,
        guard(templateNeeds(data.template), (trackId, timeMs) => {
          let id: string | null = null;
          useProjectStore.getState().update((d) => {
            id = addTemplateCue(d, trackId, timeMs, data.template, templateName(data.template, i18n.language));
          });
          if (id) useEditorUiStore.getState().selectCues([id]);
          return id;
        }),
      );
    } else if (data.kind === "effectDef") {
      // 属性特效：按拖出时参数面板里的参数生成外观片段，分布按落点轨道的成员数展开
      result = dropOnTimeline(
        viewport,
        pointer,
        tracks,
        guard(effectDefNeeds(data.def), (trackId, timeMs) => {
          let id: string | null = null;
          useProjectStore.getState().update((d) => {
            id = addEffectDefCue(d, trackId, timeMs, data.def, data.params, effectName(data.def, i18n.language));
          });
          if (id) {
            useEditorUiStore.getState().selectCues([id]);
            useEditorUiStore.getState().setInspectorTab("cue");
          }
          return id;
        }),
      );
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
    if (result.kind === "miss") {
      // 放在时间线上但不在任何轨道行里（例如最后一条轨道下面）
      const text = t("editor.templates.dropMiss");
      announce(text);
      toast.info(text);
      return;
    }
    if (result.kind !== "noRoom") return;
    // 在闭包里赋值，TS 的控制流分析看不到，需显式标注
    const reason = rejected as FixtureCapability | null;
    // 放不下要看得见：读屏播报之外再弹提示（否则看起来像“拖了没反应”）
    const text = reason ? t("editor.apply.rejected", { reason: t(`editor.apply.needs.${reason}`) }) : t("editor.templates.noRoom");
    announce(text);
    toast.warning(text);
  };

  return (
    <DndContext
      sensors={sensors}
      // 从素材库拖到时间线 / Patch / 舞台时不要让素材库跟着自动滚动（目标都在素材库之外）
      autoScroll={false}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex h-full min-h-0 flex-col bg-background">
        <EditorToolbar file={file} />
        <ModelUpdatesBanner />
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="62%" minSize="30%">
            <div className="flex h-full min-h-0">
              <IconRail />
              <EditorColumns
                library={<LibraryPanel />}
                preview={<PreviewPanel onOpenRecent={file.requestOpenRecent} />}
                inspector={<InspectorPanel />}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle axis="y" />
          <ResizablePanel defaultSize="38%" minSize="18%">
            <TimelinePanel commands={commands} />
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
      <DurationConfirmDialog />
      <RepeatDialog />
      <EffectEditorDialog />
      <TemplateEditorDialog />
      <KeymapDialog commands={commands} />
      <ShortcutSheetDialog commands={commands} />
      <OnboardingRuntime />
      <DragOverlay dropAnimation={null}>
        {dragging?.kind === "template" && <TemplateChip template={dragging.template} overlay />}
        {dragging?.kind === "effectDef" && <EffectDefChip def={dragging.def} />}
        {dragging?.kind === "preset" && <PresetChip name={dragging.name} swatch={dragging.swatch} />}
        {dragging?.kind === "media" && <MediaChip name={dragging.name} mediaKind={dragging.mediaKind} />}
        {dragging?.kind === "fixtureModel" && <FixtureModelChip name={dragging.name} type={dragging.type} />}
        {dragging?.kind === "fixtureInstance" && (
          <div className="pointer-events-none rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
            {dragging.name}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
