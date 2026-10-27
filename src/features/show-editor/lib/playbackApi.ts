import { onEvent } from "@/shared/tauri/events";
import { invoke } from "@/shared/tauri/invoke";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ShowProject } from "./project";

/** 后端预览引擎的传输状态。 */
export type Transport = "stopped" | "playing" | "paused";

/** 被后端跳过（不会输出）的灯具及原因。 */
export interface CompileWarning {
  kind: "unknownModel" | "invalidModel" | "outOfRange";
  fixtureId: string;
}

/** `show:state` 事件载荷，也是各播放命令的返回值。 */
export interface ShowState {
  loaded: boolean;
  transport: Transport;
  /** 播放位置（毫秒） */
  positionMs: number;
  durationMs: number;
  looping: boolean;
  /** 正在定位的灯具 */
  locate: string | null;
  /** 参与输出的 Universe */
  universes: number[];
  warnings: CompileWarning[];
  /** 是否有输出会话在运行（此时实时帧被丢弃） */
  outputting: boolean;
  /** 输出目标为转发表时启用的目的地个数；`null` 表示目标不是转发表 */
  destinations: number | null;
  /** 因发送队列满而丢弃的帧数 */
  dropped: number;
}

/** 状态事件名。 */
export const SHOW_STATE_EVENT = "show:state";

/** 后端错误码。 */
export const SHOW_ERR = {
  noShow: "no_show",
  emptyShow: "empty_show",
  unknownFixture: "unknown_fixture",
  recordingActive: "recording_active",
  playbackActive: "playback_active",
  showActive: "show_active",
  badTarget: "bad_target",
  invalidProject: "invalid_project",
} as const;

/**
 * 把工程交给后端预览引擎（整体替换，播放位置与传输状态保持）。
 *
 * @param project 当前工程。
 */
export function showLoad(project: ShowProject): Promise<ShowState> {
  return invoke<ShowState>("show_load", { project });
}

/** 播放 / 继续；位置在结尾时从头开始。 */
export function showPlay(): Promise<ShowState> {
  return invoke<ShowState>("show_play");
}

/** 暂停（保持画面并保活）。 */
export function showPause(): Promise<ShowState> {
  return invoke<ShowState>("show_pause");
}

/** 停止：位置回到 0，输出黑场并结束输出会话。 */
export function showStop(): Promise<ShowState> {
  return invoke<ShowState>("show_stop");
}

/**
 * 跳转到指定位置。
 *
 * @param positionMs 目标位置（毫秒），后端会夹取到节目时长内。
 */
export function showSeek(positionMs: number): Promise<ShowState> {
  return invoke<ShowState>("show_seek", { positionMs });
}

/**
 * 开始 / 结束灯具定位（只点亮指定灯具，其余黑场）。
 *
 * @param fixtureId 灯具实例 id；`null` 结束定位。
 */
export function showLocate(fixtureId: string | null): Promise<ShowState> {
  return invoke<ShowState>("show_locate", { fixtureId });
}

/** 读取当前状态。 */
export function showStatus(): Promise<ShowState> {
  return invoke<ShowState>("show_status");
}

/**
 * 订阅 `show:state` 事件。
 *
 * @param handler 状态处理器。
 * @returns 取消订阅函数的 Promise。
 */
export function onShowState(handler: (state: ShowState) => void): Promise<UnlistenFn> {
  return onEvent<ShowState>(SHOW_STATE_EVENT, handler);
}

/**
 * 告诉后端编辑器里的工程是否有未保存的修改（关闭窗口时的退出守卫据此确认）。
 *
 * @param dirty 是否有未保存的修改。
 */
export function showSetDirty(dirty: boolean): Promise<void> {
  return invoke<void>("show_set_dirty", { dirty });
}