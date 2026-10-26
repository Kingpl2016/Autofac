import { MIN_START_FREE_BYTES, type DiskInfo, type DiskLevel } from "@/shared/domain/disk";

/** 剩余空间低于此值给出“偏低”告警（字节），与后端阈值一致。 */
export const LOW_FREE_BYTES = 1_000_000_000;

/**
 * 按剩余字节数判定空间等级。
 *
 * # Arguments
 *
 * * `freeBytes` - 剩余字节数。
 *
 * # Returns
 *
 * 低于 500 MB 为 `critical`，低于 1 GB 为 `low`，否则 `ok`。
 */
export function diskLevelOf(freeBytes: number): DiskLevel {
  if (freeBytes < MIN_START_FREE_BYTES) return "critical";
  if (freeBytes < LOW_FREE_BYTES) return "low";
  return "ok";
}

/**
 * 组装某目录所在卷的空间信息。
 *
 * # Arguments
 *
 * * `path` - 被查询的目录。
 * * `freeBytes` - 剩余字节数。
 *
 * # Returns
 *
 * 磁盘空间信息；空间不足 500 MB 时不允许开始录制。
 */
export function diskInfoOf(path: string, freeBytes: number): DiskInfo {
  return {
    path,
    freeBytes,
    level: diskLevelOf(freeBytes),
    canStart: freeBytes >= MIN_START_FREE_BYTES,
  };
}
