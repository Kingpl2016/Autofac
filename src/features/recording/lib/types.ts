/**
 * 录制 / 回放相关类型，与 Rust `recorder` / `recording` 模块的 DTO（camelCase）一一对应。
 */

import type { Protocol } from "@/shared/domain/engine";
import type { DiskLevel } from "../../../shared/domain/disk";

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
  /** 当前分段内的已录时长（微秒） */
  elapsedUs: number;
  /** 整个录制会话的时长（微秒，跨分段累加） */
  sessionElapsedUs: number;
  /** 各分段在会话时间轴上的起点（微秒，第一段为 0；未录制时为空） */
  partStartsUs: number[];
  stats: SessionStats;
  dropped: number;
  universes: number[];
  /** 录制目录所在卷的剩余字节数；无法查询时为 null */
  diskFreeBytes: number | null;
  /** 最近一次检查得到的磁盘空间等级 */
  diskLevel: DiskLevel;
}

/**
 * 录制活动时间线（对应 host-core `ActivityDto`）：按时间分桶 × Universe 的变化强度与最大电平。
 * 行数据为 Base64，`change[行]` 的第 i 个字节对应桶 `from + i`。
 */
export interface ActivityDto {
  /** 桶布局代次，后端每次合并桶加一 */
  generation: number;
  /** 桶宽（微秒） */
  bucketUs: number;
  /** 时间线总桶数 */
  len: number;
  /** 本次数据覆盖的第一个桶 */
  from: number;
  universes: number[];
  change: string[];
  level: string[];
  partStartsUs: number[];
}

/** 解码后的完整活动时间线（前端 store 里维护）。 */
export interface Activity {
  generation: number;
  bucketUs: number;
  len: number;
  universes: number[];
  /** 每行一个字节数组，长度为 `len` */
  change: Uint8Array[];
  level: Uint8Array[];
  partStartsUs: number[];
}

/** `recording:stats` 事件载荷：录制状态 + 活动时间线增量（最终一次推送不带增量）。 */
export interface RecordingStatsEvent extends RecordingStatus {
  activity?: ActivityDto;
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
  /** 非用户主动停止时的原因（目前只有磁盘空间告急） */
  stoppedBy: "disk" | null;
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
  /** 文件头是否可解析（未导出的节目为 false） */
  valid: boolean;
  /** 带有可在节目编辑器里打开的工程 */
  editable: boolean;
  /** `.artrec` 文件是否存在；`false` 且可编辑表示工程已保存但还没导出 */
  exported: boolean;
  /** 由文件头派生的格式信息；文件头不可解析时为 null（旧版后端可能缺省） */
  header?: HeaderInfo | null;
}

/** 文件头发现的问题。 */
export type HeaderIssue = "emptyProgram" | "durationMismatch" | "newerMinor";

/** 由 `.artrec` 文件头（A 区）派生的格式信息（对应 `recorder::HeaderInfo`）。 */
export interface HeaderInfo {
  verMajor: number;
  verMinor: number;
  compression: "none" | "zstd";
  compressLevel: number;
  /** 文件头推荐循环播放 */
  loopFlag: boolean;
  /** 允许差分帧（核心板固件可能不支持） */
  diffFrames: boolean;
  /** 帧索引表在 Chunk 池之后 */
  frameIndexAtTail: boolean;
  issues: HeaderIssue[];
}

/** 节目库错误码。 */
export const LIB_ERR_EXISTS = "already_exists";
export const LIB_ERR_OUTSIDE = "outside_library";
export const LIB_ERR_NOT_FOUND = "not_found";
/** 无法移入回收站的错误码前缀（后面跟冒号和原因）。 */
export const LIB_ERR_TRASH = "trash_failed";
/** 编辑导出：没有可导出的内容（片段为空 / 没有保留任何 Universe）。 */
export const LIB_ERR_EMPTY_EDIT = "empty_edit";
/** 编辑导出：编辑器节目不能被替换，只能另存。 */
export const LIB_ERR_EDITABLE_REPLACE = "editable_replace";
/** 编辑导出：要替换的节目正被播放器打开。 */
export const LIB_ERR_IN_USE = "in_use";
/** 编辑导出被取消。 */
export const LIB_ERR_CANCELLED = "cancelled";

/** 源时间轴上要保留的一个片段（微秒，`[startUs, endUs)`）。 */
export interface EditSegment {
  startUs: number;
  endUs: number;
}

/** 编辑导出请求（对应 `library_commands::EditRequest`）。 */
export interface EditRequest {
  path: string;
  /** 前端生成的任务 id（进度事件与取消用） */
  jobId: string;
  /** 要保留的片段，按时间升序、互不重叠；导出时首尾拼接 */
  segments: EditSegment[];
  /** 要保留的 Universe；`null` 表示全部保留 */
  universes: number[] | null;
  output: { kind: "new"; name: string } | { kind: "replace" };
}

/** 编辑导出结果。 */
export interface EditResult {
  path: string;
  durationUs: number;
  frames: number;
  bytes: number;
  universes: number[];
}

/** `recordings:edit` 进度事件载荷。 */
export interface EditProgressEvent {
  jobId: string;
  /** 0..1 */
  progress: number;
}

/** 编辑导出进度事件名。 */
export const EDIT_PROGRESS_EVENT = "recordings:edit";

/** 后端错误码。 */
export const REC_ERR_ALREADY = "already_recording";
export const REC_ERR_NO_UNIVERSES = "no_universes";
export const REC_ERR_NOT_RECORDING = "not_recording";
export const REC_ERR_DISK_LOW = "disk_low";

/** 空状态（未录制）。 */
export const EMPTY_STATUS: RecordingStatus = {
  recording: false,
  name: "",
  path: "",
  part: 0,
  elapsedUs: 0,
  sessionElapsedUs: 0,
  partStartsUs: [],
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
  diskFreeBytes: null,
  diskLevel: "ok",
};

// ---------------------------------------------------------------------------
// 回放
// ---------------------------------------------------------------------------

/** 回放输出目标（对应 Rust `DispatchTarget`，`kind` 为判别字段）。 */
export type PlayerTarget =
  | { kind: "forwarding" }
  | { kind: "direct"; ip: string; protocol: "artNet" | "sacn"; port: number };

export type PlayState = "stopped" | "playing" | "paused";

/** 重复模式：播完即停 / 单个循环 / 连播（按节目库顺序向下，到末尾停止）。 */
export type RepeatMode = "off" | "loop" | "playlist";

/** 重复模式的循环顺序（快捷键 `L` 依此切换）。 */
export const REPEAT_MODES: readonly RepeatMode[] = ["off", "loop", "playlist"];

/**
 * 取循环顺序中的下一个重复模式。
 *
 * @param mode 当前模式。
 * @returns 下一个模式（`playlist` 之后回到 `off`）。
 */
export function nextRepeatMode(mode: RepeatMode): RepeatMode {
  return REPEAT_MODES[(REPEAT_MODES.indexOf(mode) + 1) % REPEAT_MODES.length];
}

/** `player:playlist` 事件载荷：连播的结果。 */
export type PlaylistEvent =
  | { kind: "advanced"; name: string }
  | { kind: "listFinished" }
  | { kind: "advanceFailed"; name: string; reason: string };

/** 回放状态（`player:state` 事件与 `player_status` 返回值）。 */
export interface PlaybackStatus {
  loaded: boolean;
  path: string;
  name: string;
  state: PlayState;
  posUs: number;
  durationUs: number;
  speedMilli: number;
  repeat: RepeatMode;
  frames: number;
  corruptFrames: number;
  universes: number[];
  target: PlayerTarget;
  /** 启用的转发目的地数量 */
  destinations: number;
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
/** 后端错误码：节目编辑器正在输出灯光，不能录制或打开回放节目。 */
export const PLAYER_ERR_SHOW_ACTIVE = "show_active";
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
  repeat: "off",
  frames: 0,
  corruptFrames: 0,
  universes: [],
  target: { kind: "forwarding" },
  destinations: 0,
};
