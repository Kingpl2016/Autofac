import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { OUTPUT_FPS } from "../lib/project";
import { collectSnapTargets } from "../lib/snap";
import { clamp } from "@/shared/lib/math";
import { formatTimecode, snapToFrame } from "../lib/time";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { PLAYHEAD_HIT_PX, playheadDropMs } from "./playheadMath";
import { START_LEFT } from "./timelineData";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 一帧的毫秒数。 */
const FRAME = 1000 / OUTPUT_FPS;

/**
 * 播放头：从标尺贯穿到轨道底部的竖线，顶部有把手。
 *
 * - 线宽 2px 带描边，深浅主题下都醒目；外面套一条 9px 宽的透明抓取带，直接按住拖动即可定位；
 * - 拖动时吸附到标记点、片段边缘和节拍（工具条吸附开关打开时；按住 Alt 临时关闭），并显示时间码浮标；
 * - 聚焦后方向键逐帧移动，Shift 加方向键每次 10 帧。
 *
 * 播放时每秒约 30 次更新，所以位置直接命令式改 `transform`，不触发 React 渲染。
 *
 * @param props.top 竖线顶边（像素，相对时间线右侧列），即标尺的顶边。
 * @param props.bottom 竖线底边离列底的距离（像素），让出概览条。
 */
export function Playhead({ top, bottom = 0 }: { top: number; bottom?: number }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ targets: number[] } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const { playheadMs, pxPerSec } = useEditorUiStore.getState();
      const x = START_LEFT + (playheadMs / 1000) * pxPerSec - useTimelineScrollStore.getState().left;
      el.style.transform = `translateX(${x - PLAYHEAD_HIT_PX / 2}px)`;
      el.style.visibility = x < 0 ? "hidden" : "visible";
      el.setAttribute("aria-valuenow", String(Math.round(playheadMs)));
      el.setAttribute("aria-valuetext", formatTimecode(playheadMs));
      if (labelRef.current) labelRef.current.textContent = formatTimecode(playheadMs);
    };
    place();
    const offUi = useEditorUiStore.subscribe((s, prev) => {
      if (s.playheadMs !== prev.playheadMs || s.pxPerSec !== prev.pxPerSec) place();
    });
    const offScroll = useTimelineScrollStore.subscribe(place);
    return () => {
      offUi();
      offScroll();
    };
  }, []);

  /** 指针在时间线内容坐标里的横坐标。 */
  const contentX = (clientX: number) => {
    const column = ref.current?.parentElement?.getBoundingClientRect();
    return clientX - (column?.left ?? 0) + useTimelineScrollStore.getState().left;
  };

  const seek = (e: PointerEvent<HTMLDivElement>) => {
    const ui = useEditorUiStore.getState();
    const project = useProjectStore.getState().project;
    const targets = ui.snapEnabled && !e.altKey ? (drag.current?.targets ?? null) : null;
    ui.setPlayhead(playheadDropMs(contentX(e.clientX), ui.pxPerSec, project.durationMs, targets));
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const project = useProjectStore.getState().project;
    // 吸附目标不含播放头自己（传一个节目外的时刻）
    drag.current = { targets: collectSnapTargets(project, -1, new Set(), useEditorPrefsStore.getState().snapKinds).filter((ms) => ms >= 0) };
    setDragging(true);
    seek(e);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) seek(e);
  };
  const onUp = () => {
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (e.shiftKey ? 10 : 1) * FRAME;
    const ui = useEditorUiStore.getState();
    const duration = useProjectStore.getState().project.durationMs;
    if (e.key === "ArrowLeft") ui.setPlayhead(snapToFrame(clamp(ui.playheadMs - step, 0, duration)));
    else if (e.key === "ArrowRight") ui.setPlayhead(snapToFrame(clamp(ui.playheadMs + step, 0, duration)));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={t("editor.timeline.playheadHandle")}
      aria-valuemin={0}
      aria-orientation="horizontal"
      data-testid="playhead"
      className="group/playhead absolute left-0 z-20 cursor-ew-resize touch-none focus-visible:outline-none"
      style={{ top, bottom, width: PLAYHEAD_HIT_PX }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKeyDown}
    >
      {/* 线：2px，带一圈背景色描边，悬停 / 拖动 / 聚焦时加粗 */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-playhead shadow-[0_0_0_1px_var(--background)] transition-[width]",
          "group-hover/playhead:w-[3px] group-focus-visible/playhead:w-[3px]",
          dragging && "w-[3px]",
        )}
      />
      {/* 顶部把手（在标尺里）：圆角五边形 */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-px left-1/2 h-3.5 w-[11px] -translate-x-1/2 rounded-t-[3px] bg-playhead shadow-[0_0_0_1px_var(--background)]",
          "[clip-path:polygon(0_0,100%_0,100%_65%,50%_100%,0_65%)]",
          "group-focus-visible/playhead:ring-2 group-focus-visible/playhead:ring-ring",
        )}
      />
      {/* 拖动时的时间码浮标 */}
      <span
        ref={labelRef}
        aria-hidden
        className={cn(
          "num pointer-events-none absolute left-3 top-0 whitespace-nowrap rounded bg-playhead px-1.5 py-0.5 text-[10px] font-medium text-background shadow",
          dragging ? "block" : "hidden",
        )}
      />
    </div>
  );
}
