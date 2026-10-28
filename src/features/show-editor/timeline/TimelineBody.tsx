import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { compileCached } from "../engine/compiledCache";
import { useEngine } from "../engine/useEngine";
import { sampleLanes, stripGradient } from "../lib/colorLanes";
import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { placeCues } from "../lib/cueOps";
import { duplicateCuesTo } from "../lib/editOps";
import { layerSupport, lookBadges, unsupportedLayers, type LayerBadge, type LayerSupport } from "../lib/fixtureProfile";
import { trackFixtureIds } from "../lib/ops";
import type { Cue, ShowProject, Track } from "../lib/project";
import { collectSnapTargets, pxToMs, SNAP_THRESHOLD_PX } from "../lib/snap";
import { snapToFrame } from "../lib/time";
import { zoomPxPerSec } from "../lib/zoom";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ClipView } from "./ClipView";
import { computeDrag, marqueeHits, type DragKind, type DragResult } from "./dragModel";
import { anchoredScrollLeft } from "./geometry";
import { contentWidth, START_LEFT } from "./timelineData";
import {
  BODY_BOTTOM_PAD,
  rowAt,
  rowLayout,
  visibleRows,
  visibleTimeRange,
  type RowLayout,
} from "./timelineLayout";
import { useTimelineScrollStore } from "./timelineScrollStore";
import { registerTimelineViewport } from "./timelineView";

/** 指针移动超过这个距离才算拖动 / 框选。 */
const DRAG_THRESHOLD_PX = 4;
/** 播放时播放头离右边缘不足这么多像素就翻页跟随。 */
const FOLLOW_MARGIN_PX = 80;
/** 拖到视口边缘时自动滚动的触发距离与步长（像素）。 */
const EDGE_SCROLL_ZONE = 28;
const EDGE_SCROLL_STEP = 16;
/** 色带一列的宽度（像素）。 */
const STRIP_COLUMN_PX = 6;
/** 一帧的毫秒数。 */
const FRAME_MS = 1000 / 30;

/** 时间线轨道区的命令式句柄。 */
export interface TimelineBodyHandle {
  /** 纵向滚动到 `top`（轨道头滚轮转交过来） */
  setScrollTop: (top: number) => void;
  /** 横向滚动到 `left` */
  setScrollLeft: (left: number) => void;
  /** 当前纵向滚动距离 */
  scrollTop: () => number;
}

interface TimelineBodyProps {
  tracks: readonly Track[];
  /** 轨道显示名，与 `tracks` 一一对应 */
  names: readonly string[];
  /** 纵向滚动变化（同步轨道头） */
  onScrollTop: (top: number) => void;
  /** 双击轨道空白处新建片段 */
  onCreate: (trackId: string, timeMs: number) => void;
  /** 选中片段后切到属性页 */
  onPickCue: () => void;
}

/** 进行中的拖动。 */
interface DragState {
  kind: DragKind;
  ids: string[];
  startX: number;
  startRow: number;
  /** 拖动开始时的工程快照 */
  project: ShowProject;
  targets: number[];
  active: boolean;
  /** 最近一次的预览结果 */
  result: DragResult | null;
}

/** 进行中的框选（内容坐标）。 */
interface MarqueeState {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  additive: boolean;
  base: string[];
  active: boolean;
  row: number;
}

/**
 * 自研时间线的轨道区（替代 `@xzdarcy/react-timeline-editor`）：
 *
 * - 纵向按行虚拟化、横向只渲染可见时间范围内的片段，长节目 / 大量灯具也流畅；
 * - 拖动片段：多选整体移动、上下换轨（目标轨道锁定或类型不符时不换轨），左右边缘裁剪；松手时按住 Ctrl 复制；
 *   拖动中实时吸附（播放头、标记点、其它片段边缘、节拍）并画黄色吸附线，按住 Alt 临时关闭；
 * - 空白处拖动框选（Ctrl / Shift 追加），单击空白选中轨道并清空选择，双击新建片段；
 * - Ctrl+滚轮以指针为中心缩放；播放时播放头出界自动翻页；拖动中按 Esc 取消。
 */
export const TimelineBody = forwardRef<TimelineBodyHandle, TimelineBodyProps>(function TimelineBody(
  { tracks, names, onScrollTop, onCreate, onPickCue },
  ref,
) {
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const selectedCueIds = useEditorUiStore((s) => s.selectedCueIds);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const scrollTop = useTimelineScrollStore((s) => s.top);
  const setScroll = useTimelineScrollStore((s) => s.set);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const drag = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<DragResult | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  /** Ctrl 按下时推迟的取消选择（松手且没有拖动时才执行） */
  const pendingToggle = useRef<string | null>(null);

  const layout: RowLayout = useMemo(() => rowLayout(tracks), [tracks]);
  const selected = useMemo(() => new Set(selectedCueIds), [selectedCueIds]);
  const cuesByTrack = useMemo(() => {
    const map = new Map<string, Cue[]>();
    for (const c of project.cues) {
      const list = map.get(c.trackId) ?? [];
      list.push(c);
      map.set(c.trackId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.startMs - b.startMs);
    return map;
  }, [project.cues]);
  const trackIndex = useMemo(() => new Map(tracks.map((t, i) => [t.id, i])), [tracks]);

  useImperativeHandle(
    ref,
    () => ({
      setScrollTop: (top) => {
        if (scrollRef.current) scrollRef.current.scrollTop = top;
      },
      setScrollLeft: (left) => {
        if (scrollRef.current) scrollRef.current.scrollLeft = left;
      },
      scrollTop: () => scrollRef.current?.scrollTop ?? 0,
    }),
    [],
  );

  // 视口尺寸（虚拟化与跟随用）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
      useTimelineScrollStore.getState().setViewWidth(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 素材库拖放需要的视口信息
  useEffect(
    () =>
      registerTimelineViewport(() => {
        const el = scrollRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          scrollLeft: el.scrollLeft,
          scrollTop: el.scrollTop,
          pxPerSec: useEditorUiStore.getState().pxPerSec,
          rows: layout,
        };
      }),
    [layout],
  );

  // 播放时播放头出界：翻页跟随
  useEffect(
    () =>
      useEditorUiStore.subscribe((s, prev) => {
        if (s.playheadMs === prev.playheadMs) return;
        if (usePlaybackStore.getState().state?.transport !== "playing") return;
        const el = scrollRef.current;
        if (!el) return;
        const x = START_LEFT + (s.playheadMs / 1000) * s.pxPerSec;
        if (x < el.scrollLeft || x - el.scrollLeft > el.clientWidth - FOLLOW_MARGIN_PX) {
          el.scrollLeft = Math.max(0, x - FOLLOW_MARGIN_PX);
        }
      }),
    [],
  );

  // Ctrl+滚轮缩放：需要非被动监听才能阻止页面缩放
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const oldPx = useEditorUiStore.getState().pxPerSec;
      const newPx = zoomPxPerSec(oldPx, e.deltaY < 0 ? 1 : -1);
      if (newPx === oldPx) return;
      const pointerX = e.clientX - el.getBoundingClientRect().left;
      const next = anchoredScrollLeft(el.scrollLeft, pointerX, oldPx, newPx);
      useEditorUiStore.getState().setPxPerSec(newPx);
      requestAnimationFrame(() => {
        el.scrollLeft = next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 拖动 / 框选中按 Esc 取消（捕获阶段，先于全局快捷键的“取消选择”）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (!drag.current?.active && !marqueeRef.current?.active)) return;
      e.preventDefault();
      e.stopPropagation();
      if (marqueeRef.current) useEditorUiStore.getState().selectCues(marqueeRef.current.base);
      drag.current = null;
      marqueeRef.current = null;
      setPreview(null);
      setMarquee(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /** 指针位置（内容坐标：含滚动，原点在轨道区左上角）。 */
  const contentPoint = (e: { clientX: number; clientY: number }) => {
    const el = scrollRef.current;
    const r = el?.getBoundingClientRect();
    return {
      x: e.clientX - (r?.left ?? 0) + (el?.scrollLeft ?? 0),
      y: e.clientY - (r?.top ?? 0) + (el?.scrollTop ?? 0),
    };
  };
  const timeAt = (x: number) => Math.max(0, ((x - START_LEFT) / useEditorUiStore.getState().pxPerSec) * 1000);

  // ---- 可见范围 ----
  const [rowFrom, rowTo] = visibleRows(layout, scrollTop, size.height || 600);
  const [timeFrom, timeTo] = visibleTimeRange(scrollLeft, size.width || 1200, pxPerSec);
  const xOf = (ms: number) => START_LEFT + (ms / 1000) * pxPerSec;
  const previewMap = useMemo(
    () => new Map((preview?.placements ?? []).map((p) => [p.id, p])),
    [preview],
  );

  // ---- 实际输出色带：按可见范围对引擎采样（范围量化，滚动一点点不重新采样） ----
  const engine = useEngine();
  const compiled = useMemo(() => compileCached(engine, project), [engine, project]);
  const laneStep = Math.max(FRAME_MS, pxToMs(STRIP_COLUMN_PX, pxPerSec));
  const laneChunk = laneStep * 128;
  const laneFrom = Math.floor(timeFrom / laneChunk) * laneChunk;
  const laneTo = Math.min(project.durationMs, Math.ceil(timeTo / laneChunk) * laneChunk);
  const lanes = useMemo(
    () => sampleLanes(compiled, laneFrom, laneTo, laneStep),
    [compiled, laneFrom, laneTo, laneStep],
  );
  const trackFixtures = useMemo(
    () => new Map(tracks.map((t) => [t.id, trackFixtureIds(project, t)])),
    [tracks, project],
  );
  // 每个外观片段的属性徽标与“没有灯支持的层”（按所在轨道的灯具）
  const { fixtures: projectFixtures, fixtureModels } = project;
  const clipLayers = useMemo(() => {
    const support = new Map<string, LayerSupport>();
    const out = new Map<string, { badges: LayerBadge[]; unsupported: string[] }>();
    for (const c of project.cues) {
      if (c.kind !== "look") continue;
      let s = support.get(c.trackId);
      if (!s) {
        s = layerSupport({ fixtures: projectFixtures, fixtureModels }, trackFixtures.get(c.trackId) ?? []);
        support.set(c.trackId, s);
      }
      out.set(c.id, { badges: lookBadges(c.look), unsupported: unsupportedLayers(c.look, s) });
    }
    return out;
  }, [project.cues, projectFixtures, fixtureModels, trackFixtures]);

  /** 可见片段的矩形（框选用，也用于渲染）。 */
  const clips: {
    cue: Cue;
    row: number;
    left: number;
    top: number;
    width: number;
    height: number;
    dragging: boolean;
  }[] = [];
  const cueById = new Map(project.cues.map((c) => [c.id, c]));
  for (let i = rowFrom; i < rowTo; i += 1) {
    const track = tracks[i];
    for (const cue of cuesByTrack.get(track.id) ?? []) {
      if (previewMap.has(cue.id)) continue;
      if (cue.endMs < timeFrom || cue.startMs > timeTo) continue;
      clips.push({
        cue,
        row: i,
        left: xOf(cue.startMs),
        top: layout.tops[i] + 2,
        width: xOf(cue.endMs) - xOf(cue.startMs),
        height: layout.heights[i] - 4,
        dragging: false,
      });
    }
  }
  // 被拖动的片段画在预览位置（可能在别的轨道上，不受纵向虚拟化影响）
  for (const p of previewMap.values()) {
    const cue = cueById.get(p.id);
    const row = trackIndex.get(p.trackId);
    if (!cue || row === undefined) continue;
    clips.push({
      cue,
      row,
      left: xOf(p.startMs),
      top: layout.tops[row] + 2,
      width: xOf(p.endMs) - xOf(p.startMs),
      height: layout.heights[row] - 4,
      dragging: true,
    });
  }

  // ---- 指针交互 ----
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const clipEl = target.closest<HTMLElement>("[data-cue-id]");
    const p = contentPoint(e);
    const ui = useEditorUiStore.getState();
    const current = useProjectStore.getState().project;
    e.currentTarget.setPointerCapture?.(e.pointerId);

    if (clipEl) {
      const id = clipEl.dataset.cueId ?? "";
      const cue = current.cues.find((c) => c.id === id);
      if (!cue) return;
      ui.selectTrack(cue.trackId);
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      // Ctrl 按在已选中的片段上：可能是要 Ctrl 拖动复制，取消选择推迟到松手（没拖动时）再做
      const deferToggle = (e.ctrlKey || e.metaKey) && ui.selectedCueIds.includes(id);
      if (additive && !deferToggle) ui.toggleCue(id);
      else if (!additive && !ui.selectedCueIds.includes(id)) ui.selectCues([id]);
      pendingToggle.current = deferToggle ? id : null;
      onPickCue();
      const track = current.tracks.find((t) => t.id === cue.trackId);
      if (!track || track.lock) return;
      const edge = target.closest<HTMLElement>("[data-edge]")?.dataset.edge;
      const kind: DragKind = edge === "start" ? "trimStart" : edge === "end" ? "trimEnd" : "move";
      const selection = useEditorUiStore.getState().selectedCueIds;
      if (kind === "move" && !selection.includes(id)) return;
      const ids = kind === "move" ? selection : [id];
      drag.current = {
        kind,
        ids,
        startX: p.x,
        startRow: rowAt(layout, p.y),
        project: current,
        targets: collectSnapTargets(current, ui.playheadMs, new Set(ids)),
        active: false,
        result: null,
      };
      return;
    }

    const row = rowAt(layout, p.y);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    marqueeRef.current = {
      x0: p.x,
      y0: p.y,
      x1: p.x,
      y1: p.y,
      additive,
      base: additive ? ui.selectedCueIds : [],
      active: false,
      row,
    };
  };

  const edgeScroll = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left + EDGE_SCROLL_ZONE) el.scrollLeft -= EDGE_SCROLL_STEP;
    else if (e.clientX > r.right - EDGE_SCROLL_ZONE) el.scrollLeft += EDGE_SCROLL_STEP;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const m = marqueeRef.current;
    if (!d && !m) return;
    const p = contentPoint(e);
    if (d) {
      if (!d.active && Math.abs(p.x - d.startX) < DRAG_THRESHOLD_PX && rowAt(layout, p.y) === d.startRow) return;
      d.active = true;
      edgeScroll(e);
      const ui = useEditorUiStore.getState();
      const snapOn = ui.snapEnabled && !e.altKey;
      const row = rowAt(layout, Math.max(0, Math.min(layout.total - 1, p.y)));
      d.result = computeDrag(d.project, {
        kind: d.kind,
        ids: d.ids,
        deltaMs: pxToMs(p.x - d.startX, ui.pxPerSec),
        rowDelta: d.kind === "move" && row >= 0 && d.startRow >= 0 ? row - d.startRow : 0,
        snapTargets: snapOn ? d.targets : null,
        thresholdMs: pxToMs(SNAP_THRESHOLD_PX, ui.pxPerSec),
      });
      setPreview(d.result);
      return;
    }
    if (m) {
      if (!m.active && Math.hypot(p.x - m.x0, p.y - m.y0) < DRAG_THRESHOLD_PX) return;
      edgeScroll(e);
      const next = { ...m, x1: p.x, y1: p.y, active: true };
      marqueeRef.current = next;
      setMarquee(next);
      const rect = {
        left: Math.min(next.x0, next.x1),
        top: Math.min(next.y0, next.y1),
        width: Math.abs(next.x1 - next.x0),
        height: Math.abs(next.y1 - next.y0),
      };
      const hits = marqueeHits(
        clips.map((c) => ({ id: c.cue.id, left: c.left, top: c.top, width: c.width, height: c.height })),
        rect,
      );
      useEditorUiStore.getState().selectCues(next.additive ? [...new Set([...next.base, ...hits])] : hits);
    }
  };

  const onPointerUp = (e?: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const m = marqueeRef.current;
    drag.current = null;
    marqueeRef.current = null;
    const toggle = pendingToggle.current;
    pendingToggle.current = null;
    if (toggle && !d?.active) useEditorUiStore.getState().toggleCue(toggle);
    if (d?.active) {
      const result = d.result;
      setPreview(null);
      // 松手时按住 Ctrl / ⌘：复制到新位置（原片段不动）
      if (d.kind === "move" && (e?.ctrlKey || e?.metaKey) && result && result.placements.length > 0) {
        let created: string[] = [];
        update((draft) => {
          created = duplicateCuesTo(draft, result.placements);
        });
        if (created.length > 0) useEditorUiStore.getState().selectCues(created);
        else announce(i18n.t("editor.templates.noRoom"));
        return;
      }
      if (result?.valid && result.placements.length > 0) {
        const changed = result.placements.some((pl) => {
          const before = d.project.cues.find((c) => c.id === pl.id);
          return !before || before.startMs !== pl.startMs || before.endMs !== pl.endMs || before.trackId !== pl.trackId;
        });
        if (changed) update((draft) => void placeCues(draft, result.placements));
      }
      return;
    }
    if (m) {
      setMarquee(null);
      if (!m.active) {
        const ui = useEditorUiStore.getState();
        const rowTrack = m.row >= 0 ? tracks[m.row] : undefined;
        // 点在多选轨道中的一条上：保留多选（双击可在全部选中的轨道上新建）
        const inMulti = rowTrack && ui.selectedTrackIds.length > 1 && ui.selectedTrackIds.includes(rowTrack.id);
        if (rowTrack && !inMulti) ui.selectTrack(rowTrack.id);
        if (!m.additive) ui.selectCues([]);
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-cue-id]")) return;
    const p = contentPoint(e);
    const row = rowAt(layout, p.y);
    const track = tracks[row];
    if (!track) return;
    onCreate(track.id, snapToFrame(timeAt(p.x)));
  };

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScroll(el.scrollLeft, el.scrollTop);
    onScrollTop(el.scrollTop);
  }, [onScrollTop, setScroll]);

  const width = Math.max(contentWidth(project.durationMs, pxPerSec), size.width);
  const height = layout.total + BODY_BOTTOM_PAD;
  const presets = project.presets;

  return (
    <div
      ref={scrollRef}
      id="timeline-body"
      data-testid="timeline-body"
      className="absolute inset-0 overflow-auto"
      onScroll={onScroll}
    >
      <div
        className="relative select-none"
        style={{ width, height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        {/* 轨道底纹（只画可见行） */}
        {tracks.slice(rowFrom, rowTo).map((track, k) => {
          const i = rowFrom + k;
          return (
            <div
              key={track.id}
              aria-hidden
              className={i % 2 === 0 ? "absolute inset-x-0 border-b border-border/60" : "absolute inset-x-0 border-b border-border/60 bg-surface-1/40"}
              style={{ top: layout.tops[i], height: layout.heights[i] }}
            />
          );
        })}
        {/* 节目末尾之后：斜纹表示超出节目范围 */}
        <div
          aria-hidden
          className="hatch-removed pointer-events-none absolute inset-y-0 opacity-40"
          style={{ left: xOf(project.durationMs), right: 0 }}
        />
        {clips.map((c) => {
          const track = tracks[c.row];
          return (
            <ClipView
              key={c.cue.id}
              cue={c.cue}
              trackName={names[c.row] ?? ""}
              left={c.left}
              top={c.top}
              width={c.width}
              height={c.height}
              selected={selected.has(c.cue.id)}
              locked={track?.lock ?? false}
              dimmed={track?.mute ?? false}
              collapsed={track?.collapsed ?? false}
              dragging={c.dragging}
              invalid={c.dragging && preview !== null && !preview.valid}
              presets={presets}
              badges={clipLayers.get(c.cue.id)?.badges}
              unsupported={clipLayers.get(c.cue.id)?.unsupported}
              strip={
                c.dragging || !track
                  ? null
                  : stripGradient(lanes, trackFixtures.get(track.id) ?? [], c.cue.startMs, c.cue.endMs)
              }
            />
          );
        })}
        {preview?.guideMs !== null && preview?.guideMs !== undefined && (
          <div
            aria-hidden
            data-testid="snap-line"
            className="pointer-events-none absolute inset-y-0 z-30 w-px bg-snap-line"
            style={{ left: xOf(preview.guideMs) }}
          />
        )}
        {marquee?.active && (
          <div
            aria-hidden
            data-testid="marquee"
            className="pointer-events-none absolute z-30 rounded-sm border border-primary bg-primary/10"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        )}
      </div>
    </div>
  );
});
