import { create } from "zustand";

interface TimelineScrollState {
  /** 横向滚动距离（像素） */
  left: number;
  /** 纵向滚动距离（像素） */
  top: number;
  /** 轨道区视口宽度（像素，概览条画视口框用） */
  viewWidth: number;
  /**
   * 更新滚动位置。
   *
   * @param left 横向滚动距离。
   * @param top 纵向滚动距离。
   */
  set: (left: number, top: number) => void;
  /**
   * 更新视口宽度。
   *
   * @param width 像素。
   */
  setViewWidth: (width: number) => void;
}

/**
 * 时间线当前的滚动位置。
 *
 * 节拍网格、标尺和标记点条要随横向滚动重绘，但不相关的面板不应因为滚动而重渲染，
 * 所以滚动位置单独放一个小 store，只有订阅它的叠加层会更新。
 */
export const useTimelineScrollStore = create<TimelineScrollState>((set) => ({
  left: 0,
  top: 0,
  viewWidth: 0,
  set: (left, top) => set((s) => (s.left === left && s.top === top ? s : { left, top })),
  setViewWidth: (viewWidth) => set((s) => (s.viewWidth === viewWidth ? s : { viewWidth })),
}));
