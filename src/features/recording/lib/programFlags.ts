import type { LibraryEntry } from "./types";

/**
 * 节目是否有需要用徽章标出的状态（下一个、刚录制、可编辑、未导出、损坏、已恢复、文件头告警）。
 *
 * @param entry 节目。
 * @param isNext 是否为连播的下一个。
 * @param isFresh 是否刚录制。
 */
export function hasProgramFlags(entry: LibraryEntry, isNext = false, isFresh = false): boolean {
  return (
    isNext ||
    isFresh ||
    entry.editable ||
    !entry.valid ||
    entry.recovered ||
    (entry.valid && Boolean(entry.header?.diffFrames || (entry.header?.issues.length ?? 0) > 0))
  );
}
