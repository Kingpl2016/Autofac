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

/** 节目号的合法范围（固件限制）。 */
export const PROGRAM_NO_MIN = 1;
export const PROGRAM_NO_MAX = 255;

/** 一条节目号分配：把 `no` 指到 `file`。 */
export interface ProgramAssignment {
  no: number;
  file: string;
}

/**
 * 是否是合法的节目号（1~255 的整数）。
 *
 * # Arguments
 *
 * * `n` - 待检查的数。
 */
export function isValidProgramNo(n: number): boolean {
  return Number.isInteger(n) && n >= PROGRAM_NO_MIN && n <= PROGRAM_NO_MAX;
}

/**
 * 当前被占用的最小空闲节目号（用于给未编号的文件预填）。
 *
 * # Arguments
 *
 * * `files` - 设备文件列表。
 *
 * # Returns
 *
 * 最小的未被占用的节目号；1~255 全被占用时返回 `null`。
 */
export function smallestFreeProgramNo(files: readonly NetFile[]): number | null {
  const used = new Set(files.flatMap((f) => (f.program === null ? [] : [f.program])));
  for (let n = PROGRAM_NO_MIN; n <= PROGRAM_NO_MAX; n += 1) if (!used.has(n)) return n;
  return null;
}

/**
 * 按拖动结果重排已编号的文件：节目号这几个“位置”保持不变，文件按新顺序依次占用。
 *
 * 例如 #1 a、#2 b、#5 c 把 c 拖到最前，得到 #1 c、#2 a、#5 b（编号间隔保持原样）。
 *
 * # Arguments
 *
 * * `numbered` - 已按节目号升序排好、且都有节目号的文件。
 * * `from` - 被拖动文件的原下标。
 * * `to` - 放下后的目标下标。
 *
 * # Returns
 *
 * 需要改动的分配（没变的不包含）；下标无效或没有移动时返回空数组。
 */
export function planReorder(numbered: readonly NetFile[], from: number, to: number): ProgramAssignment[] {
  const n = numbered.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return [];
  const order = [...numbered];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order.flatMap((f, i) => {
    const prev = numbered[i];
    const no = prev.program;
    return no === null || prev.name === f.name ? [] : [{ no, file: f.name }];
  });
}

/** 修改某个文件节目号的方案。 */
export type NumberPlan =
  /** 与现在相同 */
  | { kind: "same" }
  /** 节目号不合法 */
  | { kind: "invalid" }
  /** 目标号空闲，直接改 */
  | { kind: "assign"; assignments: ProgramAssignment[] }
  /** 目标号被别的文件占用，与其互换 */
  | { kind: "swap"; assignments: ProgramAssignment[]; other: string }
  /** 目标号被占用，而当前文件没有编号可换给对方 */
  | { kind: "taken"; other: string };

/**
 * 规划“把某文件的节目号改成 `no`”：空闲则直接改，被占用则与对方互换（两个文件互换编号）。
 *
 * # Arguments
 *
 * * `files` - 设备文件列表。
 * * `name` - 要改号的文件名。
 * * `no` - 目标节目号。
 *
 * # Returns
 *
 * 改号方案；找不到该文件按 `invalid` 处理。
 */
export function planSetNumber(files: readonly NetFile[], name: string, no: number): NumberPlan {
  const file = files.find((f) => f.name === name);
  if (!file || !isValidProgramNo(no)) return { kind: "invalid" };
  if (file.program === no) return { kind: "same" };
  const holder = files.find((f) => f.program === no);
  if (!holder) return { kind: "assign", assignments: [{ no, file: name }] };
  if (file.program === null) return { kind: "taken", other: holder.name };
  return {
    kind: "swap",
    other: holder.name,
    // 先让当前文件占到目标号（对方失去编号），再把当前文件原来的号给对方
    assignments: [
      { no, file: name },
      { no: file.program, file: holder.name },
    ],
  };
}

/**
 * 在本地列表上先行应用分配（乐观更新），规则与固件一致：一个文件只有一个编号，被占用的编号会被覆盖。
 *
 * # Arguments
 *
 * * `files` - 设备文件列表（不会被修改）。
 * * `assignments` - 要应用的分配，按顺序执行。
 *
 * # Returns
 *
 * 应用后的新列表。
 */
export function applyAssignments(files: readonly NetFile[], assignments: readonly ProgramAssignment[]): NetFile[] {
  return assignments.reduce<NetFile[]>(
    (list, a) =>
      list.map((f) => {
        if (f.name === a.file) return { ...f, program: a.no };
        return f.program === a.no ? { ...f, program: null } : f;
      }),
    [...files],
  );
}

/**
 * 这批分配是否会动到某个节目号（目标号，或被改动文件当前的号）。
 *
 * # Arguments
 *
 * * `files` - 设备文件列表。
 * * `assignments` - 要应用的分配。
 * * `no` - 要检查的节目号（如正在播放的节目号）。
 */
export function touchesProgramNo(
  files: readonly NetFile[],
  assignments: readonly ProgramAssignment[],
  no: number,
): boolean {
  return assignments.some((a) => a.no === no || files.find((f) => f.name === a.file)?.program === no);
}

/**
 * 正在播放 / 暂停的节目号。
 *
 * # Arguments
 *
 * * `player` - 状态接口里的播放摘要；未知传 `null`。
 *
 * # Returns
 *
 * 播放中或暂停的节目号；空闲、已停止或未知返回 `null`。
 */
export function activeProgramNo(player: PlayerBrief | null): number | null {
  if (!player) return null;
  return player.state === PlayState.Playing || player.state === PlayState.Paused ? player.programNo : null;
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
