import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useDroppable } from "@dnd-kit/core";
import { Film, Music } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCueActions } from "../hooks/useCueActions";
import { nextMediaTrackName } from "../hooks/mediaActions";
import { selectTracksWithFixtures } from "../hooks/selectionActions";
import { addMediaTrack } from "../lib/mediaClips";
import { setTrackFlag, setTrackView, TRACK_HEIGHT_ORDER } from "../lib/ops";
import { displayTracks } from "../ai/ghosts";
import { useAiStagingStore } from "../stores/useAiStagingStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { AnalysisGuides } from "../timeline/AnalysisGuides";
import { BeatGrid } from "../timeline/BeatGrid";
import { MARKER_STRIP_HEIGHT, MarkerStrip } from "../timeline/MarkerStrip";
import { MediaLanes } from "../timeline/MediaLanes";
import { MediaTrackHeaders } from "../timeline/MediaTrackHeaders";
import { OVERVIEW_HEIGHT, OverviewBar } from "../timeline/OverviewBar";
import { Playhead } from "../timeline/Playhead";
import { Ruler } from "../timeline/Ruler";
import { TimelineBody, type TimelineBodyHandle } from "../timeline/TimelineBody";
import { TrackHeaders, type TrackFlag } from "../timeline/TrackHeaders";
import { announce } from "@/shared/stores/announcerStore";
import type { Command } from "../lib/commands";
import { trackCapabilities } from "../lib/fixtureProfile";
import { removeTracks } from "../lib/trackOps";
import { moveTracks } from "../lib/timelineEdit";
import { EmptyHint } from "./EmptyHint";
import { TimelineContextMenu } from "./TimelineContextMenu";
import { PanelFrame } from "./PanelFrame";
import { PlayheadTimecode } from "./PlayheadTimecode";
import { TimelineTools } from "./TimelineTools";

/** 新建 Cue（双击空白处）时使用的拖拽放置区 id。 */
export const TIMELINE_DROP_ID = "timeline";

/**
 * 底部时间线（自研，剪映式）：轨道头 + 标记点条 + 波形 + 标尺（含 A-B 循环区间）+ 轨道区 + 播放头。
 *
 * - 双击轨道空白处新建 Cue；拖动移动（多选整体、可换轨）、拖边缘裁剪；同轨不会重叠。
 * - 拖动中实时吸附到播放头、标记点、其它 Cue 的边缘和节拍，画黄色吸附线；按住 Alt 临时关闭，工具条或 `S` 键开关。
 * - 点击选中，Ctrl / Shift 点击多选，空白处拖动框选；快捷键见命令面板（Ctrl+K）。
 * - 点击 / 拖动标尺定位；`Ctrl+滚轮` 以指针为中心缩放。
 * - 可以把素材库里的 Cue 模板 / 特效拖到轨道上。
 */
export function TimelinePanel({ commands = [] }: { commands?: readonly Command[] }) {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedTrackId = useEditorUiStore((s) => s.selectedTrackId);
  const selectedTrackIds = useEditorUiStore((s) => s.selectedTrackIds);
  const selectTrack = useEditorUiStore((s) => s.selectTrack);
  const selectCues = useEditorUiStore((s) => s.selectCues);
  const setInspectorTab = useEditorUiStore((s) => s.setInspectorTab);
  const actions = useCueActions();

  const bodyRef = useRef<TimelineBodyHandle>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const { setNodeRef: setDropRef, isOver, active: dragActive } = useDroppable({ id: TIMELINE_DROP_ID });
  // 灯具模型（新建灯具）与预览色块（为已有灯建轨道）都可以放到时间线上
  const dragKind = (dragActive?.data.current as { kind?: string } | undefined)?.kind;
  const fixtureOver = isOver && (dragKind === "fixtureModel" || dragKind === "fixtureInstance");
  // 待审阅的 AI 改动新建的轨道一起显示（锁定，只用来放虚影）
  const staged = useAiStagingStore((s) => (s.previewing ? s.staged : null));
  const display = useMemo(() => displayTracks(project, staged), [project, staged]);
  const { tracks } = display;

  const trackById = useMemo(() => new Map(tracks.map((tr) => [tr.id, tr])), [tracks]);
  const names = display.names;
  // 灯具轨道按灯具类型显示图标（分组 / 场景轨道用各自的图标）
  const fixtureTypes = useMemo(
    () =>
      tracks.map((tr) =>
        tr.target.kind === "fixture"
          ? (trackCapabilities({ fixtures: project.fixtures, fixtureModels: project.fixtureModels, groups: project.groups, cues: [] }, tr).types[0] ?? null)
          : null,
      ),
    [tracks, project.fixtures, project.fixtureModels, project.groups],
  );
  const hasTracks = tracks.length > 0;
  const hasAnyTrack = hasTracks || project.mediaTracks.length > 0;
  // 播放头从标尺顶边贯穿媒体轨道与灯光轨道
  const rulerTop = MARKER_STRIP_HEIGHT;
  const addMediaTrackOf = (kind: "audio" | "video") => update((d) => void addMediaTrack(d, kind, nextMediaTrackName(kind)));

  const toggleFlag = (trackId: string, flag: TrackFlag) => {
    const current = trackById.get(trackId)?.[flag] ?? false;
    update((d) => setTrackFlag(d, trackId, flag, !current));
  };

  const onScrollTop = useCallback((top: number) => {
    if (headersRef.current) headersRef.current.scrollTop = top;
  }, []);

  const onCreate = useCallback(
    (trackId: string, timeMs: number, lengthMs?: number) => {
      const ui = useEditorUiStore.getState();
      // 绘制模式画出的长度；省略时为默认长度
      const style = lengthMs !== undefined ? { lengthMs } : undefined;
      // 双击多选轨道中的一条：在每条选中的轨道上各建一个（一步撤销）
      if (ui.selectedTrackIds.length > 1 && ui.selectedTrackIds.includes(trackId)) {
        const ids = useProjectStore
          .getState()
          .project.tracks.filter((tr) => ui.selectedTrackIds.includes(tr.id))
          .map((tr) => tr.id);
        if (actions.addAtTracks(ids, timeMs, style).length > 0) setInspectorTab("cue");
        return;
      }
      selectTrack(trackId);
      const id = actions.addAt(trackId, timeMs, style);
      if (id) {
        selectCues([id]);
        setInspectorTab("cue");
      }
    },
    [actions, selectTrack, selectCues, setInspectorTab],
  );

  const onPickCue = useCallback(() => setInspectorTab("cue"), [setInspectorTab]);

  /** 点选轨道头：单选、Ctrl 追加 / 取消、Shift 从上次点选的轨道连选。 */
  // 灯具选择跟着轨道走，右侧切到“灯具与 Patch”并定位
  const onSelectTrack = (trackId: string, mode: "single" | "toggle" | "range" = "single") => {
    const ui = useEditorUiStore.getState();
    const open = { openPatch: true };
    if (mode === "single") {
      selectTracksWithFixtures([trackId], trackId, open);
      return;
    }
    if (mode === "toggle") {
      const has = ui.selectedTrackIds.includes(trackId);
      selectTracksWithFixtures(
        has ? ui.selectedTrackIds.filter((x) => x !== trackId) : [...ui.selectedTrackIds, trackId],
        has ? undefined : trackId,
        open,
      );
      return;
    }
    const ids = tracks.map((tr) => tr.id);
    const from = ids.indexOf(ui.selectedTrackId ?? trackId);
    const to = ids.indexOf(trackId);
    const [a, b] = [Math.min(from, to), Math.max(from, to)];
    selectTracksWithFixtures(ids.slice(Math.max(0, a), b + 1), ui.selectedTrackId ?? trackId, open);
  };

  /** 删除轨道（多选时删除全部选中的）；灯具轨道连同灯具，分组轨道只删分组。一步撤销。 */
  const onDeleteTrack = (trackId: string) => {
    const ui = useEditorUiStore.getState();
    const ids = ui.selectedTrackIds.includes(trackId) && ui.selectedTrackIds.length > 1 ? ui.selectedTrackIds : [trackId];
    let r = { fixtures: 0, groups: 0, tracks: 0, cues: 0 };
    update((d) => {
      r = removeTracks(d, ids);
    });
    ui.selectTracks([], null);
    announce(t("editor.context.deleted", { fixtures: r.fixtures, tracks: r.tracks, cues: r.cues }));
  };

  const iconButton = (
    label: string,
    onClick: () => void,
    icon: React.ReactNode,
    opts: { disabled?: boolean; pressed?: boolean } = {},
  ) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={opts.pressed ? "size-6 bg-primary/20 text-primary" : "size-6"}
      aria-label={label}
      aria-pressed={opts.pressed}
      title={label}
      disabled={opts.disabled}
      onClick={onClick}
    >
      {icon}
    </Button>
  );

  return (
    <PanelFrame
      title={t("editor.timeline.title")}
      tourId="timeline"
      noScroll
      actions={
        <>
          <PlayheadTimecode editable label={t("editor.timeline.playhead")} className="num mr-2 text-xs text-muted-foreground" />
          {iconButton(t("editor.mediaTracks.addAudio"), () => addMediaTrackOf("audio"), <Music aria-hidden />)}
          {iconButton(t("editor.mediaTracks.addVideo"), () => addMediaTrackOf("video"), <Film aria-hidden />)}
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <TimelineTools commands={commands} />
        </>
      }
    >
      {!hasAnyTrack ? (
        // 没有轨道时空提示本身也是放置区：把灯具拖进来就生成轨道
        <div
          ref={setDropRef}
          data-testid="timeline-empty-drop"
          className={cn("h-full rounded-md transition-colors", fixtureOver && "bg-primary/10 ring-2 ring-inset ring-primary")}
        >
          <EmptyHint>{t("editor.timeline.empty")}</EmptyHint>
        </div>
      ) : (
        <TimelineContextMenu commands={commands}>
        <div
          ref={setDropRef}
          tabIndex={0}
          role="group"
          aria-label={t("editor.timeline.tracksLabel")}
          className="flex h-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <TrackHeaders
            ref={headersRef}
            tracks={tracks}
            names={names}
            selectedTrackId={selectedTrackId}
            selectedTrackIds={selectedTrackIds}
            fixtureTypes={fixtureTypes}
            pendingTrackIds={display.pendingIds}
            onSelect={onSelectTrack}
            onDelete={onDeleteTrack}
            onToggle={toggleFlag}
            onCollapse={(trackId, collapsed) => update((d) => setTrackView(d, trackId, { collapsed }))}
            onCycleHeight={(trackId) => {
              const current = trackById.get(trackId)?.height ?? "normal";
              const next = TRACK_HEIGHT_ORDER[(TRACK_HEIGHT_ORDER.indexOf(current) + 1) % TRACK_HEIGHT_ORDER.length];
              update((d) => setTrackView(d, trackId, { height: next }));
            }}
            onWheelScroll={(dy) => bodyRef.current?.setScrollTop((bodyRef.current?.scrollTop() ?? 0) + dy)}
            onReorder={(trackId, toIndex) => {
              const ui = useEditorUiStore.getState();
              // 抓住的轨道在多选里时整组移动
              const ids = ui.selectedTrackIds.includes(trackId) && ui.selectedTrackIds.length > 1 ? ui.selectedTrackIds : [trackId];
              update((d) => void moveTracks(d, ids, toIndex));
            }}
            onResizeHeight={(trackId, heightPx) => update((d) => setTrackView(d, trackId, { heightPx }))}
            topSlot={<MediaTrackHeaders />}
          />
          <div className="relative flex min-w-0 flex-1 flex-col">
            <MarkerStrip />
            <Ruler />
            <MediaLanes />
            <div className="relative min-h-0 flex-1">
              <BeatGrid />
              <AnalysisGuides />
              {!hasTracks && (
                <p className="pointer-events-none absolute inset-x-0 top-4 z-10 px-4 text-center text-xs text-muted-foreground">
                  {t("editor.timeline.empty")}
                </p>
              )}
              <TimelineBody
                ref={bodyRef}
                tracks={tracks}
                names={names}
                onScrollTop={onScrollTop}
                onCreate={onCreate}
                onPickCue={onPickCue}
                commands={commands}
              />
            </div>
            <OverviewBar onScrollTo={(left) => bodyRef.current?.setScrollLeft(left)} />
            <Playhead top={rulerTop} bottom={OVERVIEW_HEIGHT} />
          </div>
        </div>
        </TimelineContextMenu>
      )}
    </PanelFrame>
  );
}
