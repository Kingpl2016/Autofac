import { create } from "zustand";

interface TimelineScrollState {
  /** 横向滚动距离（像素） */
  left: number;
  /** 纵向滚动距离（像素） */
  top: number;
  /**
   * 更新滚动位置。
   *
   * @param left 横向滚动距离。
   * @param top 纵向滚动距离。
   */
  set: (left: number, top: number) => void;
}

/**
 * 时间线当前的滚动位置。
 *
 * 节拍网格和标记点条要随横向滚动重绘，但时间线主体不应因为滚动而重渲染，
 * 所以滚动位置单独放一个小 store，只有订阅它的叠加层会更新。
 */
export const useTimelineScrollStore = create<TimelineScrollState>((set) => ({
  left: 0,
  top: 0,
  set: (left, top) => set((s) => (s.left === left && s.top === top ? s : { left, top })),
}));
