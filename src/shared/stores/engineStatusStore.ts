import { create } from "zustand";

/** 集群角色 */
export type ClusterRole = "primary" | "standby" | "none";

interface EngineStatusState {
  /** 当前网络接口标签 */
  interfaceLabel: string;
  /** 引擎是否正在接收 */
  connected: boolean;
  /** 集群角色 */
  clusterRole: ClusterRole;
  /** Guardian 守护是否启用 */
  guardianEnabled: boolean;
  /** 是否正在录制 */
  recording: boolean;
  /** 是否处于回放模式（已打开节目，实时接收暂停） */
  playback: boolean;
  /** 每秒接收包数 */
  packetRate: number;
  /** 引擎运行时长（秒） */
  uptimeSec: number;
  /** 批量更新状态 */
  patch: (partial: Partial<EngineStatusState>) => void;
}

/**
 * 引擎实时状态 store：供顶部状态条与底部状态条读取；后续任务由 Tauri 事件填充。
 */
export const useEngineStatusStore = create<EngineStatusState>((set) => ({
  interfaceLabel: "0.0.0.0",
  connected: false,
  clusterRole: "none",
  guardianEnabled: false,
  recording: false,
  playback: false,
  packetRate: 0,
  uptimeSec: 0,
  patch: (partial) => set(partial),
}));
