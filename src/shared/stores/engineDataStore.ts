import { create } from "zustand";

import type {
  EngineStats,
  UniverseSnapshot,
} from "@/shared/domain/engine";
import type { Device } from "@/shared/domain/device";
import type { DmxFrame } from "@/shared/lib/dmxFrame";

/** 一帧通道数据中与通道表相关的部分（见 `@/shared/lib/dmxFrame`）。 */
type ChannelFrame = Pick<DmxFrame, "full" | "entries">;

interface EngineDataState {
  /** 最新统计。 */
  stats: EngineStats;
  /** 活跃 Universe 快照。 */
  universes: UniverseSnapshot[];
  /** 被查看 Universe 的通道数据：universe -> 合并输出（至多 512 字节）。 */
  channels: Record<number, Uint8Array>;
  /** 已发现设备。 */
  devices: Device[];
  setStats: (s: EngineStats) => void;
  setUniverses: (u: UniverseSnapshot[]) => void;
  /**
   * 应用一帧实时通道数据：全量帧整体替换通道表（未出现的 Universe 移除），
   * 增量帧按条目合并；长度为 0 的条目删除该 Universe。整帧只触发一次更新。
   */
  applyChannelFrame: (frame: ChannelFrame) => void;
  setDevices: (d: Device[]) => void;
}

const EMPTY_STATS: EngineStats = {
  activeUniverses: 0,
  totalPackets: 0,
  packetRate: 0,
  uptimeSec: 0,
  memoryBytes: 0,
};

/**
 * 引擎实时数据 store：由 Tauri 事件与二进制通道流填充，Dashboard 与 Universe 视图读取。
 */
export const useEngineDataStore = create<EngineDataState>((set) => ({
  stats: EMPTY_STATS,
  universes: [],
  channels: {},
  devices: [],
  setStats: (stats) => set({ stats }),
  setUniverses: (universes) => set({ universes }),
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
  setDevices: (devices) => set({ devices }),
}));
