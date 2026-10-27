import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useDroppable } from "@dnd-kit/core";
import { Magnet, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { handleTimelineKey } from "../hooks/timelineKeys";
import { useCueActions } from "../hooks/useCueActions";
import { setTrackFlag, trackName } from "../lib/ops";
import { primaryMedia } from "../lib/media";
import { collectSnapTargets, pxToMs, SNAP_THRESHOLD_PX } from "../lib/snap";
import { snapToFrame } from "../lib/time";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, zoomPxPerSec } from "../lib/zoom";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useMediaStore } from "../stores/useMediaStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { applyTimeChanges } from "../timeline/applyChanges";
import { BeatGrid } from "../timeline/BeatGrid";
import { CueBlock } from "../timeline/CueBlock";
import { anchoredScrollLeft } from "../timeline/geometry";
import { MarkerStrip } from "../timeline/MarkerStrip";
import { WAVEFORM_HEIGHT, WaveformStrip } from "../timeline/WaveformStrip";
import { TimelineAdapter, type TimelineHandle, type TimelineRow } from "../timeline/TimelineAdapter";
import {
  buildRows,
  diffRows,
  rulerLabel,
  ROW_HEIGHT,
  scaleCountFor,
  secToMs,
  START_LEFT,
} from "../timeline/timelineData";
import { useTimelineScrollStore } from "../timeline/timelineScrollStore";
import { registerTimelineViewport } from "../timeline/timelineView";
import { TrackHeaders, type TrackFlag } from "../timeline/TrackHeaders";
import { EmptyHint } from "./EmptyHint";
import { PanelFrame } from "./PanelFrame";
import { PlayheadTimecode } from "./PlayheadTimecode";

/** 播放时播放头离可视区右缘不足此值（像素）就自动滚动跟随。 */
const FOLLOW_MARGIN_PX = 80;

/** 新建 Cue（双击空白处）时使用的拖拽放置区 id。 */
export const TIMELINE_DROP_ID = "timeline";

/**
 * 底部时间线：轨道头 + 标记点条 + 标尺与轨道 + Cue 块 + 节拍网格。
 *
 * - 双击轨道空白处新建 Cue；拖动 / 拉伸 Cue（同轨不会重叠）。
 * - 吸附：松手时吸附到播放头、标记点、其他 Cue 的边缘和节拍点；按住 Alt 临时关闭，工具条或 `S` 键开关。
 * - 点击选中，Ctrl / Shift 点击多选；`Delete` 删除，`Ctrl+C/V/D` 复制 / 粘贴 / 复制一份，方向键微调。
 * - 点击标尺或拖动播放头定位；`Ctrl+滚轮` 以指针为中心缩放。
 * - 可以把素材库里的 Cue 模板拖到轨道上。
 */
export function TimelinePanel() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedCueIds = useEditorUiStore((s) => s.selectedCueIds);
  const selectedTrackId = useEditorUiStore((s) => s.selectedTrackId);
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const snapEnabled = useEditorUiStore((s) => s.snapEnabled);
  const setPxPerSec = useEditorUiStore((s) => s.setPxPerSec);
  const toggleSnap = useEditorUiStore((s) => s.toggleSnap);
  const selectCues = useEditorUiStore((s) => s.selectCues);
  const toggleCue = useEditorUiStore((s) => s.toggleCue);
  const selectTrack = useEditorUiStore((s) => s.selectTrack);
  const setPlayhead = useEditorUiStore((s) => s.setPlayhead);
  const setInspectorTab = useEditorUiStore((s) => s.setInspectorTab);
  const setScroll = useTimelineScrollStore((s) => s.set);
  const actions = useCueActions();

  const timelineRef = useRef<TimelineHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const scroll = useRef({ left: 0, top: 0 });
  const altDown = useRef(false);

  const { setNodeRef: setDropRef } = useDroppable({ id: TIMELINE_DROP_ID });
  const { tracks, cues, durationMs } = project;

  const selectedSet = useMemo(() => new Set(selectedCueIds), [selectedCueIds]);
  const rows = useMemo(
    () => buildRows({ tracks, cues, durationMs }, selectedSet),
    [tracks, cues, durationMs, selectedSet],
  );
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
  const trackById = useMemo(() => new Map(tracks.map((tr) => [tr.id, tr])), [tracks]);
  const names = useMemo(
    () => tracks.map((tr) => trackName({ fixtures: project.fixtures, groups: project.groups }, tr)),
    [tracks, project.fixtures, project.groups],
  );
  const hasWaveform = useMediaStore((s) => {
    const media = primaryMedia({ media: project.media });
    return media ? s.items[media.id]?.peaks !== undefined : false;
  });
  const scaleCount = scaleCountFor(durationMs);
  const hasTracks = tracks.length > 0;

  // 向素材库拖拽放置时，需要读到当前滚动 / 缩放 / 屏幕位置
  useEffect(
    () =>
      registerTimelineViewport(() => {
        const area = bodyRef.current?.querySelector(".timeline-editor-edit-area");
        if (!area) return null;
        const r = area.getBoundingClientRect();
        return {
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          scrollLeft: scroll.current.left,
          scrollTop: scroll.current.top,
          pxPerSec: useEditorUiStore.getState().pxPerSec,
          rowCount: tracks.length,
        };
      }),
    [tracks.length],
  );

  // 播放头位置变化（点击标尺、粘贴定位、播放引擎）同步到库的光标。
  // 播放时每秒约 30 次，所以直接订阅 store 并命令式更新，不让整个时间线随之重新渲染。
  useEffect(() => {
    const follow = (ms: number) => {
      if (usePlaybackStore.getState().state?.transport !== "playing") return;
      const area = bodyRef.current?.querySelector(".timeline-editor-edit-area");
      if (!area) return;
      const x = START_LEFT + (ms / 1000) * useEditorUiStore.getState().pxPerSec;
      const { left } = scroll.current;
      if (x < left || x - left > area.getBoundingClientRect().width - FOLLOW_MARGIN_PX) {
        timelineRef.current?.setScrollLeft(Math.max(0, x - FOLLOW_MARGIN_PX));
      }
    };
    timelineRef.current?.setTime(useEditorUiStore.getState().playheadMs / 1000);
    return useEditorUiStore.subscribe((s, prev) => {
      if (s.playheadMs === prev.playheadMs) return;
      timelineRef.current?.setTime(s.playheadMs / 1000);
      follow(s.playheadMs);
    });
  }, [tracks.length]);

  // 按住 Alt 时临时关闭吸附（拖动结束的回调里读不到键盘状态，所以单独记录）
  useEffect(() => {
    const track = (e: KeyboardEvent) => {
      altDown.current = e.altKey;
    };
    const reset = () => {
      altDown.current = false;
    };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", reset);
    };
  }, []);

  // Ctrl+滚轮缩放：需要非被动监听才能阻止页面缩放 / 滚动
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const area = el.querySelector(".timeline-editor-edit-area");
      const left = area ? area.getBoundingClientRect().left : 0;
      const oldPx = useEditorUiStore.getState().pxPerSec;
      const newPx = zoomPxPerSec(oldPx, e.deltaY < 0 ? 1 : -1);
      if (newPx === oldPx) return;
      const next = anchoredScrollLeft(scroll.current.left, e.clientX - left, oldPx, newPx);
      useEditorUiStore.getState().setPxPerSec(newPx);
      requestAnimationFrame(() => timelineRef.current?.setScrollLeft(next));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // 面板在“有轨道 / 没有轨道”之间切换时 bodyRef 会指向新节点
  }, [hasTracks]);

  const onChange = useCallback(
    (next: TimelineRow[]) => {
      const before = useProjectStore.getState().project;
      const changes = diffRows(before, next);
      if (changes.length === 0) return;
      const ui = useEditorUiStore.getState();
      const snapOn = ui.snapEnabled && !altDown.current;
      const targets = snapOn
        ? collectSnapTargets(before, ui.playheadMs, new Set(changes.map((c) => c.id)))
        : [];
      update((d) => {
        applyTimeChanges(d, before, changes, {
          targets,
          thresholdMs: pxToMs(SNAP_THRESHOLD_PX, ui.pxPerSec),
        });
      });
    },
    [update],
  );

  const toggleFlag = (trackId: string, flag: TrackFlag) => {
    const current = trackById.get(trackId)?.[flag] ?? false;
    update((d) => setTrackFlag(d, trackId, flag, !current));
  };

  const iconButton = (label: string, onClick: () => void, icon: React.ReactNode, opts: { disabled?: boolean; pressed?: boolean } = {}) => (
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
          <PlayheadTimecode
            label={t("editor.timeline.playhead")}
            className="num mr-2 text-xs text-muted-foreground"
          />
          {iconButton(
            snapEnabled ? t("editor.timeline.snapOn") : t("editor.timeline.snapOff"),
            toggleSnap,
            <Magnet aria-hidden />,
            { pressed: snapEnabled },
          )}
          {iconButton(
            t("editor.timeline.zoomOut"),
            () => setPxPerSec(zoomPxPerSec(pxPerSec, -1)),
            <ZoomOut aria-hidden />,
            { disabled: pxPerSec <= MIN_PX_PER_SEC },
          )}
          {iconButton(
            t("editor.timeline.zoomIn"),
            () => setPxPerSec(zoomPxPerSec(pxPerSec, 1)),
            <ZoomIn aria-hidden />,
            { disabled: pxPerSec >= MAX_PX_PER_SEC },
          )}
        </>
      }
    >
      {!hasTracks ? (
        <EmptyHint>{t("editor.timeline.empty")}</EmptyHint>
      ) : (
        <div
          ref={(el) => {
            bodyRef.current = el;
            setDropRef(el);
          }}
          tabIndex={0}
          role="group"
          aria-label={t("editor.timeline.tracksLabel")}
          className="flex h-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onKeyDown={(e) => handleTimelineKey(e, actions, () => useEditorUiStore.getState().clearSelection())}
        >
          <TrackHeaders
            ref={headersRef}
            tracks={tracks}
            names={names}
            selectedTrackId={selectedTrackId}
            onSelect={selectTrack}
            onToggle={toggleFlag}
            onWheelScroll={(dy) => timelineRef.current?.setScrollTop(scroll.current.top + dy)}
            extraTop={hasWaveform ? WAVEFORM_HEIGHT : 0}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <MarkerStrip />
            <WaveformStrip />
            <div className="relative min-h-0 flex-1">
              <TimelineAdapter
                ref={timelineRef}
                editorData={rows}
                scale={1}
                scaleSplitCount={10}
                scaleWidth={pxPerSec}
                startLeft={START_LEFT}
                rowHeight={ROW_HEIGHT}
                minScaleCount={scaleCount}
                maxScaleCount={scaleCount}
                gridSnap={snapEnabled}
                dragLine={snapEnabled}
                getScaleRender={rulerLabel}
                getActionRender={(action) => {
                  const cue = cueById.get(action.id);
                  if (!cue) return null;
                  const track = trackById.get(cue.trackId);
                  return (
                    <CueBlock
                      cue={cue}
                      dimmed={track?.mute ?? false}
                      locked={track?.lock ?? false}
                      selected={selectedSet.has(cue.id)}
                    />
                  );
                }}
                onChange={onChange}
                onSeek={(sec) => setPlayhead(secToMs(sec))}
                onScroll={({ scrollLeft, scrollTop }) => {
                  scroll.current = { left: scrollLeft, top: scrollTop };
                  setScroll(scrollLeft, scrollTop);
                  if (headersRef.current) headersRef.current.scrollTop = scrollTop;
                }}
                onClickAction={(e, { action, row }) => {
                  bodyRef.current?.focus();
                  selectTrack(row.id);
                  if (e.ctrlKey || e.metaKey || e.shiftKey) toggleCue(action.id);
                  else selectCues([action.id]);
                  setInspectorTab("cue");
                }}
                onClickRow={(_e, { row }) => {
                  bodyRef.current?.focus();
                  selectTrack(row.id);
                  selectCues([]);
                }}
                onDoubleClickRow={(_e, { row, time }) => {
                  selectTrack(row.id);
                  if (actions.addAt(row.id, snapToFrame(secToMs(time)))) setInspectorTab("cue");
                }}
              />
              <BeatGrid />
            </div>
          </div>
        </div>
      )}
    </PanelFrame>
  );
}
