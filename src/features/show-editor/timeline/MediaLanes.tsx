import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  applyMediaPlacements,
  computeMediaDrag,
  type MediaDragKind,
  type MediaDragResult,
} from "../lib/mediaClips";
import type { ShowProject } from "../lib/project";
import { collectSnapTargets, pxToMs, SNAP_THRESHOLD_PX } from "../lib/snap";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useMediaStore } from "../stores/useMediaStore";
import { useProjectStore } from "../stores/useProjectStore";
import { MediaClipView } from "./MediaClipView";
import { mediaLayout, mediaRowAt } from "./mediaLayout";
import { START_LEFT } from "./timelineData";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 指针移动超过这个距离才算拖动。 */
const DRAG_THRESHOLD_PX = 4;

/** 进行中的拖动。 */
interface DragState {
  kind: MediaDragKind;
  ids: string[];
  startX: number;
  startRow: number;
  project: ShowProject;
  targets: number[];
  active: boolean;
  result: MediaDragResult | null;
}

/**
 * 媒体轨道区（时间线上方，剪映式多轨音视频）：每条轨道一行，片段画波形；横向随轨道区滚动。
 *
 * - 点击选中片段（Ctrl / Shift 追加），选中后右侧属性页显示片段的音量 / 淡入淡出；
 * - 拖动移动（可换到同类轨道），拖左右边缘裁剪入点 / 出点；实时吸附（播放头、标记点、Cue 与其它片段边缘、节拍），按住 Alt 关闭；
 * - 同轨片段不能重叠、不能超出素材长度，放不下时预览标红并在松手时还原。
 */
export function MediaLanes() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const selectedIds = useEditorUiStore((s) => s.selectedMediaClipIds);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const viewWidth = useTimelineScrollStore((s) => s.viewWidth);
  const peaksById = useMediaStore((s) => s.items);
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<MediaDragResult | null>(null);

  const { mediaTracks: tracks, mediaClips: clips, media } = project;
  const layout = useMemo(() => mediaLayout(tracks), [tracks]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const mediaById = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const trackIndex = useMemo(() => new Map(tracks.map((tr, i) => [tr.id, i])), [tracks]);
  const anySolo = tracks.some((tr) => tr.solo);
  if (tracks.length === 0) return null;

  const xOf = (ms: number) => START_LEFT + (ms / 1000) * pxPerSec;
  const visibleFrom = scrollLeft;
  const visibleTo = scrollLeft + (viewWidth || 1200);
  const previewMap = new Map((preview?.placements ?? []).map((p) => [p.id, p]));

  const contentPoint = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0) + useTimelineScrollStore.getState().left, y: e.clientY - (r?.top ?? 0) };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const clipEl = target.closest<HTMLElement>("[data-media-clip-id]");
    const ui = useEditorUiStore.getState();
    if (!clipEl) {
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) ui.selectMediaClips([]);
      return;
    }
    const id = clipEl.dataset.mediaClipId ?? "";
    const current = useProjectStore.getState().project;
    const clip = current.mediaClips.find((c) => c.id === id);
    if (!clip) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (additive) {
      const list = ui.selectedMediaClipIds;
      ui.selectMediaClips(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
    } else if (!ui.selectedMediaClipIds.includes(id)) {
      ui.selectMediaClips([id]);
    }
    ui.setInspectorTab("cue");
    const track = current.mediaTracks.find((tr) => tr.id === clip.trackId);
    if (!track || track.lock) return;
    const edge = target.closest<HTMLElement>("[data-edge]")?.dataset.edge;
    const kind: MediaDragKind = edge === "start" ? "trimStart" : edge === "end" ? "trimEnd" : "move";
    const selection = useEditorUiStore.getState().selectedMediaClipIds;
    if (kind === "move" && !selection.includes(id)) return;
    const ids = kind === "move" ? selection : [id];
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = contentPoint(e);
    drag.current = {
      kind,
      ids,
      startX: p.x,
      startRow: mediaRowAt(layout, p.y),
      project: current,
      targets: collectSnapTargets(current, ui.playheadMs, new Set(ids)),
      active: false,
      result: null,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = contentPoint(e);
    const row = mediaRowAt(layout, Math.max(0, Math.min(layout.total - 1, p.y)));
    if (!d.active && Math.abs(p.x - d.startX) < DRAG_THRESHOLD_PX && row === d.startRow) return;
    d.active = true;
    const ui = useEditorUiStore.getState();
    d.result = computeMediaDrag(d.project, {
      kind: d.kind,
      ids: d.ids,
      deltaMs: pxToMs(p.x - d.startX, ui.pxPerSec),
      rowDelta: d.kind === "move" && row >= 0 && d.startRow >= 0 ? row - d.startRow : 0,
      snapTargets: ui.snapEnabled && !e.altKey ? d.targets : null,
      thresholdMs: pxToMs(SNAP_THRESHOLD_PX, ui.pxPerSec),
    });
    setPreview(d.result);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    setPreview(null);
    const result = d.result;
    if (!result?.valid) return;
    const changed = result.placements.some((pl) => {
      const before = d.project.mediaClips.find((c) => c.id === pl.id);
      return !before || before.startMs !== pl.startMs || before.inMs !== pl.inMs || before.durationMs !== pl.durationMs || before.trackId !== pl.trackId;
    });
    if (changed) update((draft) => applyMediaPlacements(draft, result.placements));
  };

  const cancel = () => {
    drag.current = null;
    setPreview(null);
  };

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={t("editor.mediaTracks.lanes")}
      data-testid="media-lanes"
      className="relative shrink-0 select-none overflow-hidden border-b border-border bg-surface-2/60"
      style={{ height: layout.total }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if (e.key === "Escape" && drag.current) {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <div className="absolute inset-y-0 left-0 right-0" style={{ transform: `translateX(${-scrollLeft}px)` }}>
        {tracks.map((track, i) => (
          <div
            key={track.id}
            aria-hidden
            data-media-track-id={track.id}
            className="absolute border-b border-border/60"
            style={{ top: layout.tops[i], height: layout.heights[i], left: scrollLeft, width: viewWidth || 1200 }}
          />
        ))}
        {clips.map((clip) => {
          const ref = mediaById.get(clip.mediaId);
          const p = previewMap.get(clip.id);
          const place = p ?? clip;
          const row = trackIndex.get(place.trackId);
          if (!ref || row === undefined) return null;
          const left = xOf(place.startMs);
          const width = xOf(place.startMs + place.durationMs) - left;
          if (!p && (left + width < visibleFrom || left > visibleTo)) return null;
          const track = tracks[row];
          return (
            <MediaClipView
              key={clip.id}
              clip={{ ...clip, ...place }}
              media={ref}
              peaks={peaksById[clip.mediaId]?.peaks}
              left={left}
              top={layout.tops[row] + 2}
              width={width}
              height={layout.heights[row] - 4}
              visibleFrom={visibleFrom}
              visibleTo={visibleTo}
              pxPerSec={pxPerSec}
              selected={selected.has(clip.id)}
              locked={track.lock}
              dimmed={track.mute || clip.muted === true || (anySolo && !track.solo)}
              dragging={p !== undefined}
              invalid={p !== undefined && preview !== null && !preview.valid}
            />
          );
        })}
        {preview?.guideMs !== null && preview?.guideMs !== undefined && (
          <div
            aria-hidden
            data-testid="media-snap-line"
            className="pointer-events-none absolute inset-y-0 z-30 w-px bg-snap-line"
            style={{ left: xOf(preview.guideMs) }}
          />
        )}
      </div>
    </div>
  );
}
