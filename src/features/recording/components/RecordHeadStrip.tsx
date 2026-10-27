import { useMemo, useRef } from "react";

import { useHeatCanvas } from "../hooks/useHeatCanvas";
import { activityAsOverview, axisSpanUs, dataWidth, headX } from "../lib/recordTimeline";
import { useRecordingStore } from "../stores/useRecordingStore";

/** 迷你时间线的像素宽度（与 `w-40` 一致）与高度。 */
const STRIP_WIDTH = 160;
const STRIP_HEIGHT = 8;

interface RecordHeadStripProps {
  /** 会话总时长（微秒，已平滑外推） */
  sessionUs: number;
  /** 无障碍名称（时间与轴长的文字说明） */
  label: string;
}

/**
 * 顶栏的迷你录制时间线：各 Universe 的活动强度合成一行，录制头标出当前位置，
 * 分段边界用短竖线标出。纯展示，作为一张带文字说明的图（`role="img"`）。
 */
export function RecordHeadStrip({ sessionUs, label }: RecordHeadStripProps) {
  const activity = useRecordingStore((s) => s.activity);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const spanUs = axisSpanUs(sessionUs);
  const dataPx = dataWidth(activity, STRIP_WIDTH, spanUs);
  const overview = useMemo(() => (activity ? activityAsOverview(activity) : null), [activity]);
  useHeatCanvas(canvasRef, overview, dataPx, STRIP_HEIGHT, { collapse: true, track: "--surface-1" });

  const parts = (activity?.partStartsUs ?? []).filter((s) => s > 0);

  return (
    <div
      role="img"
      aria-label={label}
      data-testid="record-head-strip"
      className="relative h-2 w-40 overflow-hidden rounded-full bg-surface-1"
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-y-0 left-0 block h-full"
        style={{ width: dataPx }}
        aria-hidden
      />
      {parts.map((s) => (
        <span
          key={s}
          className="absolute inset-y-0 left-0 w-px bg-foreground/60"
          style={{ transform: `translateX(${headX(s, STRIP_WIDTH, spanUs)}px)` }}
          aria-hidden
        />
      ))}
      <span
        className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-recording will-change-transform"
        style={{ transform: `translateX(${headX(sessionUs, STRIP_WIDTH, spanUs)}px)` }}
        aria-hidden
      />
    </div>
  );
}
