/**
 * 与 Rust `settings::AppSettings` 对应的前端类型（camelCase 一致）。
 */

export type NetworkMode = "single" | "multiNic";

export interface NicConfig {
  name: string;
  artnetEnabled: boolean;
  sacnEnabled: boolean;
}

export interface NetworkSettings {
  mode: NetworkMode;
  interface: string;
  multiNic: NicConfig[];
}

export interface ProtocolSettings {
  artnetEnabled: boolean;
  artnetPort: number;
  sacnEnabled: boolean;
  sacnPort: number;
  sacnUniverses: number[];
}

export type UniverseFormat =
  | "decimal1"
  | "decimal0"
  | "hex"
  | "artnet"
  | "ascii";
export type ChannelFormat = "decimal1" | "decimal0" | "hex";
export type ValueFormat = "decimal" | "hex" | "percent";

export interface DisplaySettings {
  uiUpdateRate: number;
  universeFormat: UniverseFormat;
  channelFormat: ChannelFormat;
  valueFormat: ValueFormat;
}

export type MergeMode = "htp" | "ltp" | "priority";

export interface MergeSettings {
  mode: MergeMode;
  sourceTimeoutMs: number;
}

export type RecordingCompression = "zstd" | "none";

export interface RecordingSettings {
  directory: string;
  /** 压缩方式 */
  compression: RecordingCompression;
  /** Zstd 压缩等级 1~9 */
  zstdLevel: number;
  /** 自动分段时长（分钟），0 为不分段 */
  splitMinutes: number;
}

export type UpdateChannel = "stable" | "beta";

export interface UpdateSettings {
  channel: UpdateChannel;
}

export interface AppSettings {
  /** 配置结构版本（后端用于一次性迁移，前端原样回传即可） */
  schemaVersion: number;
  network: NetworkSettings;
  protocol: ProtocolSettings;
  display: DisplaySettings;
  merge: MergeSettings;
  recording: RecordingSettings;
  update: UpdateSettings;
}

export interface NetworkInterface {
  name: string;
  ip: string;
  isLoopback: boolean;
}
