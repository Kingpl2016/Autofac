/** 引擎事件与快照的共享类型（对应 Rust runtime / signal-engine DTO）。 */

export type Protocol = "artNet" | "sacn";

export interface UniverseSnapshot {
  universe: number;
  protocol: Protocol | null;
  sourceIps: string[];
  sourceCount: number;
  activeChannels: number;
  conflictChannels: number;
  totalPackets: number;
}

export interface EngineStats {
  activeUniverses: number;
  totalPackets: number;
  packetRate: number;
  uptimeSec: number;
}

export interface ChannelsPayload {
  universe: number;
  data: number[];
}
