import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useDroppable } from "@dnd-kit/core";
import { Film, Magnet, Music, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCueActions } from "../hooks/useCueActions";
import { nextMediaTrackName } from "../hooks/mediaActions";
import { addMediaTrack } from "../lib/mediaClips";
import { setTrackFlag, setTrackView, TRACK_HEIGHT_ORDER, trackName } from "../lib/ops";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, zoomPxPerSec } from "../lib/zoom";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { BeatGrid } from "../timeline/BeatGrid";
import { MARKER_STRIP_HEIGHT, MarkerStrip } from "../timeline/MarkerStrip";
import { MediaLanes } from "../timeline/MediaLanes";
import { MediaTrackHeaders } from "../timeline/MediaTrackHeaders";
import { OVERVIEW_HEIGHT, OverviewBar } from "../timeline/OverviewBar";
import { Playhead } from "../timeline/Playhead";
import { Ruler } from "../timeline/Ruler";
import { TimelineBody, type TimelineBodyHandle } from "../timeline/TimelineBody";
import { TrackHeaders, type TrackFlag } from "../timeline/TrackHeaders";
import { EmptyHint } from "./EmptyHint";
import { PanelFrame } from "./PanelFrame";
import { PlayheadTimecode } from "./PlayheadTimecode";

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
export function TimelinePanel() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedTrackId = useEditorUiStore((s) => s.selectedTrackId);
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const snapEnabled = useEditorUiStore((s) => s.snapEnabled);
  const setPxPerSec = useEditorUiStore((s) => s.setPxPerSec);
  const toggleSnap = useEditorUiStore((s) => s.toggleSnap);
  const selectTrack = useEditorUiStore((s) => s.selectTrack);
  const selectCues = useEditorUiStore((s) => s.selectCues);
  const setInspectorTab = useEditorUiStore((s) => s.setInspectorTab);
  const actions = useCueActions();

  const bodyRef = useRef<TimelineBodyHandle>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const { setNodeRef: setDropRef } = useDroppable({ id: TIMELINE_DROP_ID });
  const { tracks } = project;

  const trackById = useMemo(() => new Map(tracks.map((tr) => [tr.id, tr])), [tracks]);
  const names = useMemo(
    () => tracks.map((tr) => trackName({ fixtures: project.fixtures, groups: project.groups }, tr)),
    [tracks, project.fixtures, project.groups],
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
    (trackId: string, timeMs: number) => {
      selectTrack(trackId);
      const id = actions.addAt(trackId, timeMs);
      if (id) {
        selectCues([id]);
        setInspectorTab("cue");
      }
    },
    [actions, selectTrack, selectCues, setInspectorTab],
  );

  const onPickCue = useCallback(() => setInspectorTab("cue"), [setInspectorTab]);

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
      noScroll
      actions={
        <>
          <PlayheadTimecode label={t("editor.timeline.playhead")} className="num mr-2 text-xs text-muted-foreground" />
          {iconButton(t("editor.mediaTracks.addAudio"), () => addMediaTrackOf("audio"), <Music aria-hidden />)}
          {iconButton(t("editor.mediaTracks.addVideo"), () => addMediaTrackOf("video"), <Film aria-hidden />)}
          {iconButton(
            snapEnabled ? t("editor.timeline.snapOn") : t("editor.timeline.snapOff"),
            toggleSnap,
            <Magnet aria-hidden />,
            { pressed: snapEnabled },
          )}
          {iconButton(t("editor.timeline.zoomOut"), () => setPxPerSec(zoomPxPerSec(pxPerSec, -1)), <ZoomOut aria-hidden />, {
            disabled: pxPerSec <= MIN_PX_PER_SEC,
          })}
          {iconButton(t("editor.timeline.zoomIn"), () => setPxPerSec(zoomPxPerSec(pxPerSec, 1)), <ZoomIn aria-hidden />, {
            disabled: pxPerSec >= MAX_PX_PER_SEC,
          })}
        </>
      }
    >
      {!hasAnyTrack ? (
        <EmptyHint>{t("editor.timeline.empty")}</EmptyHint>
      ) : (
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
            onSelect={selectTrack}
            onToggle={toggleFlag}
            onCollapse={(trackId, collapsed) => update((d) => setTrackView(d, trackId, { collapsed }))}
            onCycleHeight={(trackId) => {
              const current = trackById.get(trackId)?.height ?? "normal";
              const next = TRACK_HEIGHT_ORDER[(TRACK_HEIGHT_ORDER.indexOf(current) + 1) % TRACK_HEIGHT_ORDER.length];
              update((d) => setTrackView(d, trackId, { height: next }));
            }}
            onWheelScroll={(dy) => bodyRef.current?.setScrollTop((bodyRef.current?.scrollTop() ?? 0) + dy)}
            topSlot={<MediaTrackHeaders />}
          />
          <div className="relative flex min-w-0 flex-1 flex-col">
            <MarkerStrip />
            <Ruler />
            <MediaLanes />
            <div className="relative min-h-0 flex-1">
              <BeatGrid />
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
              />
            </div>
            <OverviewBar onScrollTo={(left) => bodyRef.current?.setScrollLeft(left)} />
            <Playhead top={rulerTop} bottom={OVERVIEW_HEIGHT} />
          </div>
        </div>
      )}
    </PanelFrame>
  );
}
