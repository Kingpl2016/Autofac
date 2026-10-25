import { create } from "zustand";

import type {
  EngineStats,
  UniverseSnapshot,
} from "@/shared/domain/engine";
import type { Device } from "@/shared/domain/device";

interface EngineDataState {
  /** 最新统计。 */
  stats: EngineStats;
  /** 活跃 Universe 快照。 */
  universes: UniverseSnapshot[];
  /** 被查看 Universe 的通道数据：universe -> 512 值。 */
  channels: Record<number, number[]>;
  /** 已发现设备。 */
  devices: Device[];
  setStats: (s: EngineStats) => void;
  setUniverses: (u: UniverseSnapshot[]) => void;
  setChannels: (universe: number, data: number[]) => void;
  setDevices: (d: Device[]) => void;
}

const EMPTY_STATS: EngineStats = {
  activeUniverses: 0,
  totalPackets: 0,
  packetRate: 0,
  uptimeSec: 0,
};

/**
 * 引擎实时数据 store：由 Tauri 事件填充，Dashboard 与 Universe 视图读取。
 */
export const useEngineDataStore = create<EngineDataState>((set) => ({
  stats: EMPTY_STATS,
  universes: [],
  channels: {},
  devices: [],
  setStats: (stats) => set({ stats }),
  setUniverses: (universes) => set({ universes }),
  setChannels: (universe, data) =>
    set((s) => ({ channels: { ...s.channels, [universe]: data } })),
  setDevices: (devices) => set({ devices }),
}));
