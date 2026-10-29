import { pxToMs, SNAP_THRESHOLD_PX, snapValue } from "../lib/snap";
import { clamp } from "@/shared/lib/math";
import { snapToFrame } from "../lib/time";
import { START_LEFT } from "./timelineData";

/** 播放头抓取带的宽度（像素）：比线宽得多，容易抓住。 */
export const PLAYHEAD_HIT_PX = 9;

/**
 * 计算拖动播放头的落点：换算成时间，夹在节目范围内，开启吸附时吸到标记点 / 片段边缘 / 节拍，最后对齐到帧。
 *
 * @param contentX 指针在时间线内容坐标里的横坐标（含滚动）。
 * @param pxPerSec 每秒像素数。
 * @param durationMs 节目时长。
 * @param targets 吸附目标；`null` 为不吸附。
 * @returns 播放头时刻（毫秒）。
 */
export function playheadDropMs(contentX: number, pxPerSec: number, durationMs: number, targets: readonly number[] | null): number {
  const raw = clamp(((contentX - START_LEFT) / pxPerSec) * 1000, 0, durationMs);
  const snapped = targets ? snapValue(raw, targets, pxToMs(SNAP_THRESHOLD_PX, pxPerSec)) : raw;
  return snapToFrame(clamp(snapped, 0, durationMs));
}
