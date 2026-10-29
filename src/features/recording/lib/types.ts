/**
 * 录制 / 回放相关类型。
 *
 * 与后端一一对应的 DTO 由 Rust `recorder` / `host-core` / `player` / 应用命令经 ts-rs 生成
 * （`src/bindings`，运行 `npm run gen:types` 更新），此处转出并起别名；只在前端存在的
 * 结构（解码后的时间线、事件载荷的组合形态、收窄的回放目标）在这里手写。
 */

import type { ActivityDto } from "@/bindings/ActivityDto";
import type { PlaybackState } from "@/bindings/PlaybackState";
import type { RecordingStatus } from "@/bindings/RecordingStatus";
import type { RepeatMode } from "@/bindings/RepeatMode";

export type { ActivityDto, RecordingStatus, RepeatMode };
/** 闭区间 Universe 范围。 */
export type { UniverseRange } from "@/bindings/UniverseRange";
/** 录制过滤条件；三类条件取交集，空数组表示该维度不限制。 */
export type { RecordFilter } from "@/bindings/RecordFilter";
/** 按源 IP 聚合的来源统计（`signal_engine::SourceStat`）。 */
export type { SourceStat } from "@/bindings/SourceStat";
/** Universe 规划结果。 */
export type { UniversePlan } from "@/bindings/UniversePlan";
/** 启动录制参数。 */
export type { RecordingStartArgs } from "@/bindings/RecordingStartArgs";
/** 启动录制结果。 */
export type { RecordingStartResult } from "@/bindings/RecordingStartResult";
/** 一次录制的最终结果。 */
export type { RecordingResult } from "@/bindings/RecordingResult";
/** 孤立录制的恢复结果（`recorder::RecoveryOutcome`）。 */
export type { RecoveryOutcome } from "@/bindings/RecoveryOutcome";
/** 节目库中的一条节目（`recorder::LibraryEntry`）。 */
export type { LibraryEntry } from "@/bindings/LibraryEntry";
/** 文件头发现的问题。 */
export type { HeaderIssue } from "@/bindings/HeaderIssue";
/** 由 `.artrec` 文件头（A 区）派生的格式信息（`recorder::HeaderInfo`）。 */
export type { HeaderInfo } from "@/bindings/HeaderInfo";
/** 源时间轴上要保留的一个片段（微秒，`[startUs, endUs)`）。 */
export type { SegmentDto as EditSegment } from "@/bindings/SegmentDto";
/** 编辑导出请求（`library_commands::EditRequest`）。 */
export type { EditRequest } from "@/bindings/EditRequest";
/** 编辑导出结果。 */
export type { EditResult } from "@/bindings/EditResult";
/** `recordings:edit` 进度事件载荷。 */
export type { EditProgress as EditProgressEvent } from "@/bindings/EditProgress";
/** 时间线概览（`player::Overview`；矩阵为 Base64 字符串，需解码后使用）。 */
export type { Overview as OverviewDto } from "@/bindings/Overview";
/** 通道曲线的一个降采样点。 */
export type { SeriesPoint } from "@/bindings/SeriesPoint";
/** 一个通道的曲线。 */
export type { ChannelSeries } from "@/bindings/ChannelSeries";
/** 通道曲线查询参数。 */
export type { SeriesQuery } from "@/bindings/SeriesQuery";

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

/**
 * 回放输出目标（Rust `DispatchTarget`，`kind` 为判别字段）。
 *
 * 只列回放用到的两种；后端另有节目编辑器专用的 `routed`，回放界面不会设置也不会收到，故不生成。
 */
export type PlayerTarget =
  | { kind: "forwarding" }
  | { kind: "direct"; ip: string; protocol: "artNet" | "sacn"; port: number };

/** 播放状态（Rust `PlaybackState`）。 */
export type PlayState = PlaybackState;

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

/** `player:playlist` 事件载荷：连播的结果（后端以 JSON 字面量发出，无对应结构体）。 */
export type PlaylistEvent =
  | { kind: "advanced"; name: string }
  | { kind: "listFinished" }
  | { kind: "advanceFailed"; name: string; reason: string };

/**
 * 回放状态（`player:state` 事件与 `player_status` 返回值，Rust `PlaybackStatus`）。
 *
 * 手写而非生成：`target` 收窄为 {@link PlayerTarget}。
 */
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
