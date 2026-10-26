import { create } from "zustand";

import type { DmxFrame } from "@/shared/lib/dmxFrame";
import { EMPTY_PLAYBACK, type PlaybackStatus } from "../lib/types";

/** 一帧通道数据中与通道表相关的部分（见 `@/shared/lib/dmxFrame`）。 */
type ChannelFrame = Pick<DmxFrame, "full" | "entries">;

interface PlayerState {
  /** 回放状态（约 30Hz 更新） */
  status: PlaybackStatus;
  /** 回放期间被查看 Universe 的当前输出：universe -> 通道数据（至多 512 字节） */
  channels: Record<number, Uint8Array>;
  setStatus: (s: PlaybackStatus) => void;
  /**
   * 应用一帧回放通道数据（二进制通道流 kind = 2）：全量帧整体替换通道表（未出现的 Universe 移除），
   * 增量帧按条目合并；长度为 0 的条目删除该 Universe。整帧只触发一次更新。
   */
  applyChannelFrame: (frame: ChannelFrame) => void;
  /** 清空通道缓存（节目关闭时调用） */
  clearChannels: () => void;
}

/**
 * 回放状态 store：由 Tauri 事件与二进制通道流填充，回放面板与顶部状态条读取。
 */
export const usePlayerStore = create<PlayerState>((set) => ({
  status: EMPTY_PLAYBACK,
  channels: {},
  setStatus: (status) => set({ status }),
  applyChannelFrame: ({ full, entries }) => {
    if (!full && entries.length === 0) return;
    set((s) => {
      const channels: Record<number, Uint8Array> = full ? {} : { ...s.channels };
      for (const { universe, data } of entries) {
        if (data.length === 0) delete channels[universe];
        else channels[universe] = data;
      }
      return { channels };
    });
  },
  clearChannels: () => set({ channels: {} }),
}));
