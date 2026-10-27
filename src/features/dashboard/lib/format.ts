/** Dashboard 展示用的格式化辅助。 */

import { trimFraction, type ValueWithUnit } from "@/shared/lib/format";

// 包速率格式化已提升到共享库，这里再导出以保持既有引用路径可用
export { formatPacketRate, type ValueWithUnit } from "@/shared/lib/format";
export { formatUptime } from "@/shared/lib/uptime";

/**
 * 格式化进程内存：不足 1 GB 用 MB（取整），否则用 GB（保留 1 位小数）。
 *
 * @param bytes 字节数；`0`、负数与非有限值视为"暂无数据"。
 * @returns 数值与单位；暂无数据时返回 `{ value: "—", unit: "" }`。
 */
export function formatMemory(bytes: number): ValueWithUnit {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: "—", unit: "" };
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return { value: String(Math.max(1, Math.round(mb))), unit: "MB" };
  return { value: trimFraction(mb / 1024, 1), unit: "GB" };
}
