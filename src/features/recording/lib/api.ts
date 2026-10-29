import { invoke } from "@/shared/tauri/invoke";

import type { DiskInfo } from "@/shared/domain/disk";
import { decodeOverview } from "./overview";
import type {
  ActivityDto,
  ChannelSeries,
  EditRequest,
  EditResult,
  LibraryEntry,
  Overview,
  OverviewDto,
  PlaybackStatus,
  PlayerTarget,
  RecordingResult,
  RecordingStartArgs,
  RecordingStartResult,
  RecordingStatus,
  RecoveryOutcome,
  RepeatMode,
  SeriesQuery,
} from "./types";

/**
 * 查询录制目录所在卷的剩余空间。
 *
 * @param path 要查询的目录；省略则查询当前生效的录制目录。
 */
export function recordingDiskInfo(path?: string): Promise<DiskInfo> {
  return invoke<DiskInfo>("recording_disk_info", { path: path ?? null });
}

/** 开始录制。 */
export function recordingStart(
  args: RecordingStartArgs,
): Promise<RecordingStartResult> {
  return invoke<RecordingStartResult>("recording_start", { args });
}

/** 停止录制并等待文件收尾。 */
export function recordingStop(): Promise<RecordingResult> {
  return invoke<RecordingResult>("recording_stop");
}

/** 读取录制状态快照。 */
export function recordingStatus(): Promise<RecordingStatus> {
  return invoke<RecordingStatus>("recording_status");
}

/** 读取录制活动时间线的全量快照（中途打开页面或代次不一致时用）。 */
export function recordingActivity(): Promise<ActivityDto> {
  return invoke<ActivityDto>("recording_activity");
}

/** 节目库列表的查询键；其他功能（如节目编辑器保存节目）据此刷新列表。 */
export const RECORDINGS_QUERY_KEY = ["recordings"] as const;

/** 列出节目库（按修改时间从新到旧）。 */
export function recordingsList(): Promise<LibraryEntry[]> {
  return invoke<LibraryEntry[]>("recordings_list");
}

/** 重命名节目，返回新路径。 */
export function recordingsRename(path: string, newName: string): Promise<string> {
  return invoke<string>("recordings_rename", { path, newName });
}

/** 删除节目及其 sidecar。 */
export function recordingsDelete(path: string): Promise<void> {
  return invoke<void>("recordings_delete", { path });
}

/** 修改节目备注（编辑器节目会同步改写工程里的备注）。 */
export function recordingsSetNotes(path: string, notes: string): Promise<void> {
  return invoke<void>("recordings_set_notes", { path, notes });
}

/** 创建节目副本，返回副本路径（重名时后端自动追加编号）。 */
export function recordingsDuplicate(path: string, newName: string): Promise<string> {
  return invoke<string>("recordings_duplicate", { path, newName });
}

/** 编辑导出：截取 / 拼接片段、只保留部分 Universe，另存或替换原节目。 */
export function recordingsEdit(req: EditRequest): Promise<EditResult> {
  return invoke<EditResult>("recordings_edit", { req });
}

/** 取消进行中的编辑导出。 */
export function recordingsEditCancel(jobId: string): Promise<void> {
  return invoke<void>("recordings_edit_cancel", { jobId });
}

/** 取走应用启动时恢复出的孤立录制结果（取走后清空）。 */
export function recordingTakeRecovered(): Promise<RecoveryOutcome[]> {
  return invoke<RecoveryOutcome[]>("recording_take_recovered");
}

// ---------------------------------------------------------------------------
// 回放
// ---------------------------------------------------------------------------

/** 打开节目并进入回放模式（暂停实时接收）。 */
export function playerOpen(
  path: string,
  target?: PlayerTarget,
): Promise<PlaybackStatus> {
  return invoke<PlaybackStatus>("player_open", { path, target: target ?? null });
}

/** 播放 / 继续。 */
export function playerPlay(): Promise<void> {
  return invoke<void>("player_play");
}

/** 暂停。 */
export function playerPause(): Promise<void> {
  return invoke<void>("player_pause");
}

/** 停止并回到开头（节目保持打开）。 */
export function playerStop(): Promise<void> {
  return invoke<void>("player_stop");
}

/** 关闭节目并退出回放模式（恢复实时接收）。 */
export function playerClose(): Promise<void> {
  return invoke<void>("player_close");
}

/** 跳转到指定位置（微秒）。 */
export function playerSeek(posUs: number): Promise<void> {
  return invoke<void>("player_seek", { posUs: Math.max(0, Math.round(posUs)) });
}

/** 设置倍速（千分之一，1000 = 1.0x）。 */
export function playerSetSpeed(speedMilli: number): Promise<void> {
  return invoke<void>("player_set_speed", { speedMilli });
}

/** 设置重复模式（关闭 / 循环 / 连播）；没有节目时也会被记住。 */
export function playerSetRepeat(mode: RepeatMode): Promise<void> {
  return invoke<void>("player_set_repeat", { mode });
}

/** 切换输出目标。 */
export function playerSetTarget(target: PlayerTarget): Promise<void> {
  return invoke<void>("player_set_target", { target });
}

/** 设置前端正在查看的 Universe（决定二进制通道流的回放帧包含哪些 Universe）。 */
export function playerSetViewed(universes: number[]): Promise<void> {
  return invoke<void>("player_set_viewed", { universes });
}

/** 读取回放状态快照。 */
export function playerStatus(): Promise<PlaybackStatus> {
  return invoke<PlaybackStatus>("player_status");
}

/** 读取（必要时生成）节目的时间线概览，矩阵已解码。 */
export async function playerOverview(
  path: string,
  buckets?: number,
): Promise<Overview> {
  const dto = await invoke<OverviewDto>("player_overview", {
    path,
    buckets: buckets ?? null,
  });
  return decodeOverview(dto);
}

/** 查询选定通道的降采样曲线。 */
export function playerSeries(query: SeriesQuery): Promise<ChannelSeries[]> {
  return invoke<ChannelSeries[]>("player_series", { query });
}
