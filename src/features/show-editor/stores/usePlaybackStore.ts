import { create } from "zustand";

import type { ShowState } from "../lib/playbackApi";

interface PlaybackStoreState {
  /** 后端最近一次推送的状态；尚未收到时为 `null`。 */
  state: ShowState | null;
  /**
   * 记录后端状态。
   *
   * @param state 后端推送的状态。
   */
  setState: (state: ShowState) => void;
  /** 清空（离开编辑器时）。 */
  reset: () => void;
}

/** 后端预览引擎的状态镜像。位置由后端是唯一的真相，界面只读。 */
export const usePlaybackStore = create<PlaybackStoreState>((set) => ({
  state: null,
  setState: (state) => set({ state }),
  reset: () => set({ state: null }),
}));
