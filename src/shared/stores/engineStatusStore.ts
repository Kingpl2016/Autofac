import { create } from "zustand";

/** 集群角色 */
export type ClusterRole = "primary" | "standby" | "none";

/** 应用运行模式：实时 / 播放器（对应后端 `AppMode`）。 */
export type AppModeName = "live" | "player";

/** 接收任务状态：已绑定 / 重建失败 / 被播放器模式主动停止。 */
export type ReceiversName = "bound" | "failed" | "suspended";

/** 发送器状态：就绪 / 重连中 / 不可用。 */
export type SenderName = "ready" | "reconnecting" | "down";

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
  /** 是否已打开节目（回放中 / 暂停 / 停止均算） */
  playback: boolean;
  /** 是否正在播放（不含暂停与停止） */
  playing: boolean;
  /** 应用运行模式 */
  appMode: AppModeName;
  /** 接收任务状态 */
  receivers: ReceiversName;
  /** 发送器状态 */
  sender: SenderName;
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
  playing: false,
  appMode: "live",
  receivers: "bound",
  sender: "ready",
  packetRate: 0,
  uptimeSec: 0,
  patch: (partial) => set(partial),
}));
