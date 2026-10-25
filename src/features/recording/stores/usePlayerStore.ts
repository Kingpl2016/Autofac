import { create } from "zustand";

import { EMPTY_PLAYBACK, type PlaybackStatus } from "../lib/types";

interface PlayerState {
  /** 回放状态（约 30Hz 更新） */
  status: PlaybackStatus;
  /** 回放期间被查看 Universe 的当前输出：universe -> 512 值 */
  channels: Record<number, number[]>;
  setStatus: (s: PlaybackStatus) => void;
  setChannels: (universe: number, data: number[]) => void;
  /** 清空通道缓存（切换节目 / 停止时调用） */
  clearChannels: () => void;
}

/**
 * 回放状态 store：由 Tauri 事件填充，回放面板与顶部状态条读取。
 */
export const usePlayerStore = create<PlayerState>((set) => ({
  status: EMPTY_PLAYBACK,
  channels: {},
  setStatus: (status) => set({ status }),
  setChannels: (universe, data) =>
    set((s) => ({ channels: { ...s.channels, [universe]: data } })),
  clearChannels: () => set({ channels: {} }),
}));
