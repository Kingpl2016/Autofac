import type { TimelineViewport } from "./geometry";

/**
 * 时间线视口的“登记处”。
 *
 * 从素材库拖拽模板放到时间线上时，拖拽库只给出屏幕坐标，需要时间线当前的滚动位置、缩放和
 * 屏幕矩形才能换算出时间和轨道。这些值每次滚动都在变，放进 React 状态会造成无谓的重渲染，
 * 所以由时间线面板登记一个读取函数，需要时才现取。
 */
let reader: (() => TimelineViewport | null) | null = null;

/**
 * 登记读取当前视口的函数。
 *
 * @param read 返回当前视口；时间线尚未挂载时返回 `null`。
 * @returns 取消登记的函数（只会取消自己登记的那一个）。
 */
export function registerTimelineViewport(read: () => TimelineViewport | null): () => void {
  reader = read;
  return () => {
    if (reader === read) reader = null;
  };
}

/**
 * 读取时间线当前的视口。
 *
 * @returns 视口信息；时间线没有挂载时为 `null`。
 */
export function readTimelineViewport(): TimelineViewport | null {
  return reader ? reader() : null;
}
