/**
 * 录制 / 回放相关类型，与 Rust `recorder` / `recording` 模块的 DTO（camelCase）一一对应。
 */

import type { Protocol } from "@/shared/domain/engine";

/** 闭区间 Universe 范围。 */
export interface UniverseRange {
  start: number;
  end: number;
}

/** 录制过滤条件；三类条件取交集，空数组表示该维度不限制。 */
export interface RecordFilter {
  /** 来源 IP 集合 */
  sources: string[];
  /** true 时 `sources` 为黑名单 */
  excludeSources: boolean;
  /** Universe 范围集合 */
  universes: UniverseRange[];
  /** 协议集合 */
  protocols: Protocol[];
}

/** 按源 IP 聚合的来源统计（对应 `signal_engine::SourceStat`）。 */
export interface SourceStat {
  ip: string;
  protocol: Protocol | null;
  universes: number[];
  packets: number;
}

/** 会话统计（对应 `recorder::SessionStats`）。 */
export interface SessionStats {
  frames: number;
  fullFrames: number;
  diffFrames: number;
  bytes: number;
  durationUs: number;
  acceptedPackets: number;
  filteredPackets: number;
  ignoredPackets: number;
  ignoredUniverses: number;
  maxChain: number;
}

/** 录制实时状态（`recording:stats` 事件与 `recording_status` 返回值）。 */
export interface RecordingStatus {
  recording: boolean;
  name: string;
  path: string;
  part: number;
  elapsedUs: number;
  stats: SessionStats;
  dropped: number;
  universes: number[];
}

/** Universe 规划结果。 */
export interface UniversePlan {
  accepted: number[];
  rejectedOutOfRange: number[];
  rejectedOverCapacity: number[];
}

/** 启动录制参数。 */
export interface RecordingStartArgs {
  name: string;
  notes: string;
  fileStem: string;
  filter: RecordFilter;
  universes: number[];
}

/** 启动录制结果。 */
export interface RecordingStartResult {
  path: string;
  plan: UniversePlan;
}

/** 一个已完成的录制文件。 */
export interface FinishedFile {
  path: string;
  durationUs: number;
  frames: number;
  bytes: number;
  sources: string[];
}

/** 一次录制的最终结果。 */
export interface RecordingResult {
  files: FinishedFile[];
  error: string | null;
  dropped: number;
}

/** 孤立录制的恢复结果（对应 `recorder::RecoveryOutcome`）。 */
export type RecoveryOutcome =
  | { kind: "recovered"; path: string; frames: number; durationUs: number }
  | { kind: "discarded"; part: string }
  | { kind: "failed"; part: string; reason: string };

/** 节目库中的一条节目（对应 `recorder::LibraryEntry`）。 */
export interface LibraryEntry {
  path: string;
  fileName: string;
  name: string;
  notes: string;
  bytes: number;
  modifiedUnixMs: number;
  durationUs: number;
  frames: number;
  universes: number[];
  sources: string[];
  recovered: boolean;
  /** 文件头是否可解析 */
  valid: boolean;
}

/** 节目库错误码。 */
export const LIB_ERR_EXISTS = "already_exists";
export const LIB_ERR_OUTSIDE = "outside_library";
export const LIB_ERR_NOT_FOUND = "not_found";

/** 后端错误码。 */
export const REC_ERR_ALREADY = "already_recording";
export const REC_ERR_NO_UNIVERSES = "no_universes";
export const REC_ERR_NOT_RECORDING = "not_recording";

/** 空状态（未录制）。 */
export const EMPTY_STATUS: RecordingStatus = {
  recording: false,
  name: "",
  path: "",
  part: 0,
  elapsedUs: 0,
  stats: {
    frames: 0,
    fullFrames: 0,
    diffFrames: 0,
    bytes: 0,
    durationUs: 0,
    acceptedPackets: 0,
    filteredPackets: 0,
    ignoredPackets: 0,
    ignoredUniverses: 0,
    maxChain: 0,
  },
  dropped: 0,
  universes: [],
};

// ---------------------------------------------------------------------------
// 回放
// ---------------------------------------------------------------------------

/** 回放输出目标（对应 Rust `DispatchTarget`，`kind` 为判别字段）。 */
export type PlayerTarget =
  | { kind: "forwarding" }
  | { kind: "direct"; ip: string; protocol: "artNet" | "sacn"; port: number };

export type PlayState = "stopped" | "playing" | "paused";

/** 回放状态（`player:state` 事件与 `player_status` 返回值）。 */
export interface PlaybackStatus {
  loaded: boolean;
  path: string;
  name: string;
  state: PlayState;
  posUs: number;
  durationUs: number;
  speedMilli: number;
  looping: boolean;
  frames: number;
  corruptFrames: number;
  universes: number[];
  target: PlayerTarget;
  /** 启用的转发目的地数量 */
  destinations: number;
}

/** 回放期间被查看 Universe 的通道数据（`player:channels`）。 */
export interface PlayerChannelsPayload {
  universe: number;
  data: number[];
}

/** 时间线概览（对应 `player::Overview`；矩阵为 Base64 字符串，需解码后使用）。 */
export interface OverviewDto {
  version: number;
  durationUs: number;
  buckets: number;
  universes: number[];
  change: string[];
  level: string[];
  frames: number;
  skippedFrames: number;
  fileBytes: number;
}

/** 解码后的概览：每路 Universe 一行字节。 */
export interface Overview {
  durationUs: number;
  buckets: number;
  universes: number[];
  change: Uint8Array[];
  level: Uint8Array[];
  frames: number;
  skippedFrames: number;
}

/** 通道曲线的一个降采样点。 */
export interface SeriesPoint {
  tUs: number;
  min: number;
  max: number;
}

/** 一个通道的曲线。 */
export interface ChannelSeries {
  channel: number;
  points: SeriesPoint[];
}

/** 通道曲线查询参数。 */
export interface SeriesQuery {
  path: string;
  universe: number;
  channels: number[];
  t0Us: number;
  t1Us: number;
  maxPoints: number;
}

/** 回放相关后端错误码。 */
export const PLAYER_ERR_RECORDING_ACTIVE = "recording_active";
export const PLAYER_ERR_PLAYBACK_ACTIVE = "playback_active";
export const PLAYER_ERR_NO_PLAYER = "no_player";
export const PLAYER_ERR_BAD_TARGET = "bad_target";
export const PLAYER_ERR_BAD_PATH = "bad_path";

/** 倍速档位（千分之一为单位）。 */
export const SPEED_STEPS = [250, 500, 1000, 1500, 2000] as const;

/** 未打开节目时的空状态。 */
export const EMPTY_PLAYBACK: PlaybackStatus = {
  loaded: false,
  path: "",
  name: "",
  state: "stopped",
  posUs: 0,
  durationUs: 0,
  speedMilli: 1000,
  looping: false,
  frames: 0,
  corruptFrames: 0,
  universes: [],
  target: { kind: "forwarding" },
  destinations: 0,
};
