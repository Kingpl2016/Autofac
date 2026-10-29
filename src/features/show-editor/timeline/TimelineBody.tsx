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
import { cn } from "@/lib/utils";
import i18n from "@/shared/i18n";
import { useElementSize } from "@/shared/hooks/useElementSize";
import { announce } from "@/shared/stores/announcerStore";
import type { Command } from "../lib/commands";
import { gapAround, MIN_CUE_MS, placeCues } from "../lib/cueOps";
import { duplicateCuesTo } from "../lib/editOps";
import { selectTracksWithFixtures } from "../hooks/selectionActions";
import { layerSupport, lookBadges, unsupportedLayers, type LayerBadge, type LayerSupport } from "../lib/fixtureProfile";
import { trackFixtureIds } from "../lib/ops";
import type { Cue, ShowProject, Track } from "../lib/project";
import { collectSnapTargets, pxToMs, SNAP_THRESHOLD_PX, snapValue } from "../lib/snap";
import { formatTimecode, snapToFrame } from "../lib/time";
import { extendCue, keyMoveRange, moveLookKey, shiftTimelineObjects } from "../lib/timelineEdit";
import { zoomPxPerSec } from "../lib/zoom";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ClipQuickBar } from "./ClipQuickBar";
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
/** 片段快捷条占用的高度（含与片段的间距，像素）。 */
const QUICK_BAR_SPACE = 30;

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
  /** 双击轨道空白处（或绘制模式下画出）新建片段；`lengthMs` 省略为默认长度 */
  onCreate: (trackId: string, timeMs: number, lengthMs?: number) => void;
  /** 选中片段后切到属性页 */
  onPickCue: () => void;
  /** 编辑器命令（片段快捷条复用：复制、禁用、删除）；省略时不显示快捷条 */
  commands?: readonly Command[];
}

/** 绘制模式下进行中的“画片段”。 */
interface DrawState {
  trackId: string;
  row: number;
  startX: number;
  /** 按下处的时刻（已吸附） */
  anchorMs: number;
  /** 当前另一端的时刻（已吸附、夹在空隙内） */
  endMs: number;
  /** 按下处所在的空隙：画出的片段不越过相邻片段 */
  lo: number;
  hi: number;
  targets: number[];
  active: boolean;
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
 *   绘制模式下空白处拖动直接画出片段（吸附同上，不越过相邻片段），单击新建默认长度的片段；
 * - 双击片段的左 / 右边缘：延伸到相邻片段或播放头（取较近的）；
 * - 选中片段上方浮出快捷条（淡入淡出、颜色标签、复制、禁用、删除）；
 * - Ctrl+滚轮以指针为中心缩放；播放时播放头出界自动翻页；拖动中按 Esc 取消。
 */
export const TimelineBody = forwardRef<TimelineBodyHandle, TimelineBodyProps>(function TimelineBody(
  { tracks, names, onScrollTop, onCreate, onPickCue, commands },
  ref,
) {
  const drawMode = useEditorUiStore((s) => s.drawMode);
  const drawRef = useRef<DrawState | null>(null);
  const [draw, setDrawState] = useState<DrawState | null>(null);
  const setDraw = (v: DrawState | null) => {
    drawRef.current = v;
    setDrawState(v);
  };
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const selectedCueIds = useEditorUiStore((s) => s.selectedCueIds);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const scrollTop = useTimelineScrollStore((s) => s.top);
  const setScroll = useTimelineScrollStore((s) => s.set);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 视口尺寸（虚拟化与跟随用）
  const size = useElementSize(scrollRef, {
    onResize: ({ width }) => useTimelineScrollStore.getState().setViewWidth(width),
  });
  const drag = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<DragResult | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  /** Ctrl 按下时推迟的取消选择（松手且没有拖动时才执行） */
  const pendingToggle = useRef<string | null>(null);
  /** 进行中的关键帧拖动 */
  const keyDrag = useRef<{
    cueId: string;
    fromMs: number;
    startX: number;
    active: boolean;
    locked: boolean;
    targets: number[];
  } | null>(null);
  /** 关键帧拖动的预览位置（片段内时刻） */
  const [keyPreview, setKeyPreviewState] = useState<{ cueId: string; uMs: number } | null>(null);
  const keyPreviewRef = useRef<{ cueId: string; uMs: number } | null>(null);
  const setKeyPreview = (v: { cueId: string; uMs: number } | null) => {
    keyPreviewRef.current = v;
    setKeyPreviewState(v);
  };
  const timeRange = useEditorUiStore((s) => s.timeRange);
  const tagFilter = useEditorUiStore((s) => s.tagFilter);

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
        if (!useEditorPrefsStore.getState().followPlayhead) return;
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
      if (e.key !== "Escape" || (!drag.current?.active && !marqueeRef.current?.active && !drawRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      if (marqueeRef.current) useEditorUiStore.getState().selectCues(marqueeRef.current.base);
      drag.current = null;
      marqueeRef.current = null;
      drawRef.current = null;
      setPreview(null);
      setMarquee(null);
      setDrawState(null);
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
  /** 吸附到吸附点（吸附开着且没按 Alt 时），再对齐到帧。 */
  const snapTime = (ms: number, targets: readonly number[], alt: boolean) => {
    const ui = useEditorUiStore.getState();
    const v = ui.snapEnabled && !alt ? snapValue(ms, targets, pxToMs(SNAP_THRESHOLD_PX, ui.pxPerSec)) : ms;
    return snapToFrame(v);
  };

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
      // 灯具选择跟着片段所在的轨道（右侧保持 / 切到 Cue 属性）
      selectTracksWithFixtures([cue.trackId], cue.trackId);
      // 点在关键帧 ◆ 上：选中片段；不拖动时把播放头移到这个关键帧，拖动时移动关键帧（Ctrl 复制）
      const keyEl = target.closest<HTMLElement>("[data-key-ms]");
      if (keyEl) {
        if (!ui.selectedCueIds.includes(id)) ui.selectCues([id]);
        onPickCue();
        const locked = current.tracks.find((t) => t.id === cue.trackId)?.lock === true;
        keyDrag.current = {
          cueId: id,
          fromMs: Number(keyEl.dataset.keyMs ?? 0),
          startX: p.x,
          active: false,
          locked,
          targets: collectSnapTargets(current, ui.playheadMs, new Set([id]), useEditorPrefsStore.getState().snapKinds),
        };
        return;
      }
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
        targets: collectSnapTargets(current, ui.playheadMs, new Set(ids), useEditorPrefsStore.getState().snapKinds),
        active: false,
        result: null,
      };
      return;
    }

    const row = rowAt(layout, p.y);
    // 绘制模式：在可编辑的轨道空白处按下开始画片段（场景轨道只放场景片段，不画）
    const drawTrack = ui.drawMode && row >= 0 ? tracks[row] : undefined;
    if (drawTrack && !drawTrack.lock && drawTrack.target.kind !== "scene") {
      const targets = collectSnapTargets(current, ui.playheadMs, new Set(), useEditorPrefsStore.getState().snapKinds);
      const anchor = snapTime(timeAt(p.x), targets, e.altKey);
      const gap = gapAround(current, drawTrack.id, anchor);
      if (gap) {
        setDraw({ trackId: drawTrack.id, row, startX: p.x, anchorMs: anchor, endMs: anchor, lo: gap[0], hi: gap[1], targets, active: false });
        return;
      }
    }
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
    const k = keyDrag.current;
    // 记下指针所在的时刻（“粘贴到鼠标位置”用）
    useEditorUiStore.getState().setPointerTime(timeAt(contentPoint(e).x));
    const dr = drawRef.current;
    if (dr) {
      const p = contentPoint(e);
      if (!dr.active && Math.abs(p.x - dr.startX) < DRAG_THRESHOLD_PX) return;
      edgeScroll(e);
      const end = Math.min(dr.hi, Math.max(dr.lo, snapTime(timeAt(p.x), dr.targets, e.altKey)));
      setDraw({ ...dr, endMs: end, active: true });
      return;
    }
    if (k) {
      const p = contentPoint(e);
      if (!k.active && Math.abs(p.x - k.startX) < DRAG_THRESHOLD_PX) return;
      if (k.locked) return;
      k.active = true;
      const ui = useEditorUiStore.getState();
      const cue = useProjectStore.getState().project.cues.find((c) => c.id === k.cueId);
      if (!cue || cue.kind !== "look") return;
      let abs = cue.startMs + k.fromMs + pxToMs(p.x - k.startX, ui.pxPerSec);
      if (ui.snapEnabled && !e.altKey) {
        const threshold = pxToMs(SNAP_THRESHOLD_PX, ui.pxPerSec);
        const near = k.targets.reduce<number | null>((best, t) => (Math.abs(t - abs) <= threshold && (best === null || Math.abs(t - abs) < Math.abs(best - abs)) ? t : best), null);
        if (near !== null) abs = near;
      }
      const length = cue.endMs - cue.startMs;
      const [lo, hi] = e.ctrlKey || e.metaKey ? [0, length] : keyMoveRange(cue.look, k.fromMs, length);
      setKeyPreview({ cueId: k.cueId, uMs: Math.round(Math.min(hi, Math.max(lo, abs - cue.startMs))) });
      return;
    }
    if (!d && !m) return;
    const p = contentPoint(e);
    if (d) {
      if (!d.active && Math.abs(p.x - d.startX) < DRAG_THRESHOLD_PX && rowAt(layout, p.y) === d.startRow) return;
      d.active = true;
      edgeScroll(e);
      const ui = useEditorUiStore.getState();
      const snapOn = ui.snapEnabled && !e.altKey;
      const row = rowAt(layout, Math.max(0, Math.min(layout.total - 1, p.y)));
      // 波纹编辑：拖动 / 拉右边缘时后面的片段跟着移；按住 Alt 时全部轨道（与标记点等）一起移
      const ripple = useEditorPrefsStore.getState().rippleEdit && d.kind !== "trimStart" ? { allTracks: e.altKey } : null;
      d.result = computeDrag(d.project, {
        kind: d.kind,
        ids: d.ids,
        deltaMs: pxToMs(p.x - d.startX, ui.pxPerSec),
        rowDelta: d.kind === "move" && row >= 0 && d.startRow >= 0 && !ripple ? row - d.startRow : 0,
        snapTargets: snapOn ? d.targets : null,
        thresholdMs: pxToMs(SNAP_THRESHOLD_PX, ui.pxPerSec),
        ripple,
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
    const k = keyDrag.current;
    drag.current = null;
    marqueeRef.current = null;
    keyDrag.current = null;
    const dr = drawRef.current;
    if (dr) {
      setDraw(null);
      if (!dr.active) {
        // 绘制模式下单击：在这里新建默认长度的片段
        onCreate(dr.trackId, dr.anchorMs);
        return;
      }
      const from = Math.min(dr.anchorMs, dr.endMs);
      const to = Math.max(dr.anchorMs, dr.endMs);
      if (to - from >= MIN_CUE_MS) onCreate(dr.trackId, from, to - from);
      return;
    }
    if (k) {
      const preview = keyPreviewRef.current;
      setKeyPreview(null);
      const cue = useProjectStore.getState().project.cues.find((c) => c.id === k.cueId);
      if (!k.active || !preview || !cue) {
        // 只是点了一下：播放头移到这个关键帧
        if (cue) useEditorUiStore.getState().setPlayhead(cue.startMs + k.fromMs);
        return;
      }
      if (preview.uMs === k.fromMs) return;
      const copy = e?.ctrlKey === true || e?.metaKey === true;
      update((draft) => {
        const c = draft.cues.find((x) => x.id === k.cueId);
        if (c?.kind === "look") moveLookKey(c.look, k.fromMs, preview.uMs, c.endMs - c.startMs, copy);
      });
      useEditorUiStore.getState().setPlayhead(cue.startMs + preview.uMs);
      return;
    }
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
        if (changed) {
          update((draft) => {
            // 波纹：往后推时延长节目；全局波纹时标记点、段落、循环区与媒体也一起移
            if (result.ripple) draft.durationMs = Math.max(draft.durationMs, ...result.placements.map((p) => p.endMs));
            placeCues(draft, result.placements);
            if (result.ripple?.allTracks) shiftTimelineObjects(draft, result.ripple.fromMs, result.ripple.deltaMs);
          });
        }
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
        if (rowTrack && !inMulti) selectTracksWithFixtures([rowTrack.id], rowTrack.id);
        if (!m.additive) ui.selectCues([]);
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const clipEl = target.closest<HTMLElement>("[data-cue-id]");
    if (clipEl) {
      // 双击左 / 右边缘：延伸到相邻片段或播放头
      const side = target.closest<HTMLElement>("[data-edge]")?.dataset.edge;
      const id = clipEl.dataset.cueId;
      if (!id || (side !== "start" && side !== "end")) return;
      let ok = false;
      update((d) => {
        ok = extendCue(d, id, side, useEditorUiStore.getState().playheadMs);
      });
      announce(i18n.t(ok ? "editor.timeline.extended" : "editor.timeline.extendNone"));
      return;
    }
    // 绘制模式下单击已经新建了片段，双击不再重复新建
    if (useEditorUiStore.getState().drawMode) return;
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
        className={cn("relative select-none", drawMode && "cursor-crosshair")}
        data-draw-mode={drawMode || undefined}
        style={{ width, height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => useEditorUiStore.getState().setPointerTime(null)}
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
        {/* 时间范围选择（标尺上 Shift + 拖动）：贯穿全部轨道的半透明色带 */}
        {timeRange && (
          <div
            aria-hidden
            data-testid="time-range-band"
            className="pointer-events-none absolute inset-y-0 z-[1] border-x border-primary/60 bg-primary/10"
            style={{ left: xOf(timeRange.startMs), width: Math.max(1, xOf(timeRange.endMs) - xOf(timeRange.startMs)) }}
          />
        )}
        {/* 关键帧拖动的预览：目标位置的竖线与时刻 */}
        {keyPreview &&
          (() => {
            const cue = cueById.get(keyPreview.cueId);
            const row = cue ? trackIndex.get(cue.trackId) : undefined;
            if (!cue || row === undefined) return null;
            const x = xOf(cue.startMs + keyPreview.uMs);
            return (
              <div aria-hidden className="pointer-events-none absolute z-20 w-px bg-keyframe" style={{ left: x, top: layout.tops[row], height: layout.heights[row] }}>
                <span className="num absolute -top-4 left-1 whitespace-nowrap rounded bg-popover/90 px-1 text-[10px] text-foreground shadow-sm">
                  {formatTimecode(cue.startMs + keyPreview.uMs)}
                </span>
              </div>
            );
          })()}
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
              // 静音轨道、或按颜色标签筛选时其它标签的片段变暗
              dimmed={(track?.mute ?? false) || (tagFilter !== null && c.cue.tag !== tagFilter)}
              collapsed={track?.collapsed ?? false}
              dragging={c.dragging}
              invalid={c.dragging && preview !== null && !preview.valid}
              presets={presets}
              gamma={project.output.gamma}
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
        {/* 绘制模式：正在画的片段（虚线框 + 长度） */}
        {draw?.active &&
          (() => {
            const from = Math.min(draw.anchorMs, draw.endMs);
            const to = Math.max(draw.anchorMs, draw.endMs);
            return (
              <div
                aria-hidden
                data-testid="draw-preview"
                className={cn(
                  "pointer-events-none absolute z-20 rounded-sm border-2 border-dashed",
                  to - from >= MIN_CUE_MS ? "border-primary bg-primary/15" : "border-destructive bg-destructive/10",
                )}
                style={{ left: xOf(from), width: Math.max(2, xOf(to) - xOf(from)), top: layout.tops[draw.row] + 2, height: layout.heights[draw.row] - 4 }}
              >
                <span className="num absolute -top-4 left-0 whitespace-nowrap rounded bg-popover/90 px-1 text-[10px] text-foreground shadow-sm">
                  {formatTimecode(to - from)}
                </span>
              </div>
            );
          })()}
        {/* 选中片段的快捷条：拖动 / 框选 / 绘制时隐藏 */}
        {commands &&
          commands.length > 0 &&
          !preview &&
          !marquee?.active &&
          !draw &&
          (() => {
            const anchorId = selectedCueIds.at(-1);
            const anchor = anchorId ? clips.find((c) => c.cue.id === anchorId) : undefined;
            if (!anchor) return null;
            const locked = tracks[anchor.row]?.lock ?? false;
            return (
              <ClipQuickBar
                commands={commands}
                ids={selectedCueIds}
                locked={locked}
                left={Math.max(scrollLeft + 4, anchor.left)}
                // 上方放不下（第一条轨道）时放到片段下方
                top={anchor.top >= QUICK_BAR_SPACE ? anchor.top - QUICK_BAR_SPACE : anchor.top + anchor.height + 4}
              />
            );
          })()}
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
