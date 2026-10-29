/**
 * 录制磁盘空间相关类型与格式化，与 Rust `recorder::disk` / `host_core::recording::DiskInfo` 对应。
 */

/** 空间等级（`recorder::DiskLevel`，ts-rs 生成）。 */
export type { DiskLevel } from "@/bindings/DiskLevel";

/** 录制目录所在卷的空间信息（`host_core::recording::DiskInfo`，ts-rs 生成）。 */
export type { DiskInfo } from "@/bindings/DiskInfo";

/** 开始录制所需的最小剩余空间（字节），与后端 `MIN_START_FREE_BYTES` 一致。 */
export const MIN_START_FREE_BYTES = 500_000_000;

/**
 * 按十进制单位格式化磁盘字节数（与阈值 500 MB / 1 GB 的口径一致）。
 *
 * 磁盘阈值按十进制定义，若用二进制的 MiB/GiB 展示，会出现“500 MB 阈值显示为 476.8 MiB”的错位。
 *
 * @param bytes 字节数。
 * @returns 形如 `320 MB`、`1.5 GB` 的字符串。
 */
export function formatDiskBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  const gb = bytes / 1_000_000_000;
  return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
}
