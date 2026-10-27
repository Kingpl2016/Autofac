import { useEffect, useRef } from "react";

import { useEditorUiStore } from "../stores/useEditorUiStore";
import { START_LEFT } from "./timelineData";
import { useTimelineScrollStore } from "./timelineScrollStore";

/**
 * 播放头：从标尺贯穿到轨道底部的一条竖线（顶部带三角）。
 *
 * 播放时每秒约 30 次更新，所以直接订阅 store 命令式改 `transform`，不触发 React 渲染。
 * 不拦截指针事件（点击标尺定位由标尺处理）。
 *
 * @param props.top 竖线顶边（像素，相对时间线右侧列），即标尺的顶边。
 * @param props.bottom 竖线底边离列底的距离（像素），让出概览条。
 */
export function Playhead({ top, bottom = 0 }: { top: number; bottom?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const { playheadMs, pxPerSec } = useEditorUiStore.getState();
      const x = START_LEFT + (playheadMs / 1000) * pxPerSec - useTimelineScrollStore.getState().left;
      el.style.transform = `translateX(${x}px)`;
      el.style.visibility = x < 0 ? "hidden" : "visible";
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

  return (
    <div
      ref={ref}
      aria-hidden
      data-testid="playhead"
      className="pointer-events-none absolute left-0 z-20 w-px bg-playhead"
      style={{ top, bottom }}
    >
      <span className="absolute -left-[5px] -top-px size-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-playhead" />
    </div>
  );
}
