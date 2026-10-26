import { PLAYABLE_MODES, PlayState, type NetFile, type PlayerBrief } from "./types";

/**
 * 取本地路径的文件名（兼容 `\` 与 `/`）。
 *
 * # Arguments
 *
 * * `path` - 本地路径。
 *
 * # Returns
 *
 * 最后一段文件名。
 */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 文件排序：已分配节目号的按编号升序在前，未分配的按名称排在后。
 *
 * # Arguments
 *
 * * `files` - 设备文件列表（不会被修改）。
 *
 * # Returns
 *
 * 排好序的新数组，目录被过滤掉。
 */
export function sortFiles(files: readonly NetFile[]): NetFile[] {
  return files
    .filter((f) => !f.isDir)
    .sort((a, b) => {
      if (a.program !== null && b.program !== null) return a.program - b.program;
      if (a.program !== null) return -1;
      if (b.program !== null) return 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * 当前工作模式是否允许播放（固件限制：自动 0 与节目 4）。
 *
 * # Arguments
 *
 * * `mode` - 工作模式。
 */
export function isPlayableMode(mode: number): boolean {
  return PLAYABLE_MODES.includes(mode);
}

/** 文件在设备上的播放状态。 */
export type FilePlayState = "playing" | "paused" | null;

/**
 * 判断某文件当前是否正在播放 / 暂停。
 *
 * # Arguments
 *
 * * `file` - 设备文件。
 * * `player` - 状态接口里的播放摘要；未知传 `null`。
 *
 * # Returns
 *
 * 播放中、暂停，或 `null`（不是当前节目）。
 */
export function filePlayState(file: NetFile, player: PlayerBrief | null): FilePlayState {
  if (!player || file.program === null || player.programNo !== file.program) return null;
  if (player.state === PlayState.Playing) return "playing";
  if (player.state === PlayState.Paused) return "paused";
  return null;
}

/**
 * 找出与设备上已有文件重名的待上传名称（不区分大小写，与 FAT 文件系统一致）。
 *
 * # Arguments
 *
 * * `names` - 待上传文件名。
 * * `existing` - 设备上已有文件。
 *
 * # Returns
 *
 * 会被覆盖的文件名（取设备上的原名）。
 */
export function findOverwrites(names: readonly string[], existing: readonly NetFile[]): string[] {
  const lower = new Map(existing.map((f) => [f.name.toLowerCase(), f.name]));
  return names.flatMap((n) => {
    const hit = lower.get(n.toLowerCase());
    return hit ? [hit] : [];
  });
}
